import { Router } from "express";
import { rfpDb as db } from "@workspace/db";
import { opportunitiesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, asc } from "drizzle-orm";
import { importFromCsv } from "../lib/csv-service";
import { jinaProvider } from "../lib/providers/jina";
import { groqProvider } from "../lib/providers/groq";
import { openrouterProvider } from "../lib/providers/openrouter";
import { samGovOpportunityClassificationEvidence } from "../lib/providers/samGovTaxonomyEvidence";
import { extractMetadataFromText } from "../lib/search/heuristicExtract";
import { classifyResult } from "../lib/search/relevance";
import { decideRelevanceWithCodes } from "../lib/search/relevanceDecision";
import { getRelevanceProfile } from "../lib/search/relevanceProfile";
import { matchedServiceLines } from "../lib/search/profileServiceLines";
import { classifyTestingTypes } from "../lib/search/testingTypes";
import { hasPrimaryOccuMedServiceEvidence } from "../lib/opportunityScopeEvidence";
import { judgeScopeBlock, profileServiceLabels } from "../lib/search/profileText";
import {
  cancelManualIngestion,
  getCurrentIngestionRun,
  getIngestionRun,
  IngestionRunNotRetryableError,
  listRecentIngestionRuns,
  reconcileExpiredOpportunities,
  retryFailedProviders,
  startManualIngestion,
} from "../lib/ingestion/manualIngestion";
import { createStartIngestionHandler } from "./opportunityIngestionHandlers";
import multer from "multer";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const CURRENT_YEAR = new Date().getFullYear();
const NEXT_YEAR = CURRENT_YEAR + 1;

// Max points the feedback-learned signal (userConfidence, 0-100, neutral 50)
// can add to or subtract from a result's ranking score. 0 when no grades exist.
const FEEDBACK_RANK_WEIGHT = 15;

// Convert a stored userConfidence (0-100, neutral 50) into a ranking delta
// in [-FEEDBACK_RANK_WEIGHT, +FEEDBACK_RANK_WEIGHT]. Null/neutral → 0 (no-op).
function feedbackAdjustment(userConfidence: unknown): number {
  const uc = typeof userConfidence === "string" ? parseFloat(userConfidence)
    : typeof userConfidence === "number" ? userConfidence : NaN;
  if (!Number.isFinite(uc)) return 0;
  const delta = ((uc - 50) / 50) * FEEDBACK_RANK_WEIGHT;
  return Math.max(-FEEDBACK_RANK_WEIGHT, Math.min(FEEDBACK_RANK_WEIGHT, delta));
}

function hasStaleYearOnly(raw: string): boolean {
  const years = Array.from(raw.matchAll(/\b20\d{2}\b/g)).map((m) => Number(m[0]));
  if (years.length === 0) return false;
  const hasCurrentOrFuture = years.some((year) => year >= CURRENT_YEAR && year <= NEXT_YEAR + 1);
  const hasOld = years.some((year) => year < CURRENT_YEAR);
  return hasOld && !hasCurrentOrFuture;
}

/**
 * Read-time gate. Whether a record is Occu-Med relevant is the one canonical Neon decision (rules + thresholds +
 * classification-code discovery facts); this function only adds source hygiene (untitled stubs, stale-year-only
 * records), which is date/identity validation and not relevance vocabulary.
 */
function shouldShowOpportunity(opp: any): boolean {
  // Notice identity only: an old year in the description ("awarded in 2021", "per the 2019 standard") says nothing
  // about whether this notice is current.
  const identity = [opp.title, opp.solicitationNumber, opp.samUrl].filter(Boolean).join(" ");

  // Reject untitled / suspiciously short titles
  const title = (opp.title ?? "").trim();
  if (title.length < 10) return false;

  // Reject stale-year-only records (old archived RFPs from past years), unless the notice has a future deadline.
  const deadlineInFuture = Boolean(
    opp.responseDeadline && new Date(opp.responseDeadline).getTime() > Date.now(),
  );
  if (!deadlineInFuture && hasStaleYearOnly(identity)) return false;

  const result = classifyResult({
    title,
    snippet: [
      opp.type,
      opp.solicitationNumber,
      opp.description,
      opp.naicsDescription,
      ...samGovOpportunityClassificationEvidence(opp),
    ].filter(Boolean).join(" "),
    url: opp.samUrl,
    date: opp.postedDate,
    deadlineInFuture: Boolean(
      opp.responseDeadline && new Date(opp.responseDeadline).getTime() > Date.now(),
    ),
    allowHistorical: true,
  });
  const decision = decideRelevanceWithCodes(result, [
    { system: "NAICS 2022", code: opp.naicsCode },
    { system: "PSC", code: opp.pscCode },
  ]);
  return decision.verdict !== "reject";
}

// Shared with enrichment and read-time presentation. Manual ingestion applies
// its quality decision before any record can be promoted into production.
export { shouldShowOpportunity };

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Build the transparent relevance view shown in the UI: a 0-100 score, the
 * human-readable reasons it matched, the detected/`unknown` date, and quality
 * warnings (stale / low-confidence). Uses stored values when present (web rows
 * scored at write time) and falls back to live classification for older rows.
 */
function buildRelevanceView(opp: any) {
  const samClassificationEvidence = samGovOpportunityClassificationEvidence(opp);
  const cls = classifyResult({
    title: opp.title,
    snippet: [opp.description, ...samClassificationEvidence].filter(Boolean).join(" "),
    url: opp.samUrl,
    date: opp.postedDate,
    allowHistorical: true,
  });

  // Group key for the UI: the most specific testing type the record evidences. The classifier's own `category` is the
  // first profile category that matched, which is almost always the broad umbrella, so it is only the fallback.
  const testing = classifyTestingTypes({
    title: opp.title,
    body: [opp.description, opp.naicsDescription, ...samClassificationEvidence].filter(Boolean).join(" "),
  });

  const tags = parseTags(opp.tags);
  const storedScore = opp.relevanceScore != null ? parseFloat(opp.relevanceScore) : NaN;
  const primaryScopeEvidenced = hasPrimaryOccuMedServiceEvidence(
    String(opp.title ?? ""), String(opp.description ?? ""),
  );
  // Persisted scores are historical rankings, not proof of purchased-scope fit.
  const rawScore = Number.isFinite(storedScore) ? Math.round(storedScore) : cls.score;
  const score = primaryScopeEvidenced ? rawScore : Math.min(rawScore, 49);

  const notesText = typeof opp.notes === "string" ? opp.notes : "";
  const whyMatch = notesText.match(/\[why:\s*([^\]]+?)(?:\s*\|\s*via:\s*([\w-]+))?\s*\]/);
  const why: string | null = whyMatch?.[1]?.trim() || null;
  const tagSet = parseTags(opp.tags);
  const decisionMethod: "rule" | "ai-panel" | "ai-judge" | null =
    tagSet.includes("deterministic-approved") || whyMatch?.[2] === "deterministic"
      ? "rule"
      : tagSet.includes("panel-ai-reviewed") || whyMatch?.[2] === "panel-ai-review"
        ? "ai-panel"
        : tagSet.includes("single-ai-reviewed") || whyMatch?.[2] === "single-ai-review"
          ? "ai-judge"
          : null;
  // Provenance text ("Evidence direct-structured; adapter=...") is not a reason.
  const storedReasons = notesText
    .replace(/\[why:[^\]]*\]/g, " ")
    .split(/;|·/)
    .map((s: string) => s.trim())
    .filter((s: string) => s && !/^Evidence\b|\b(?:adapter|buyer|deadline|status|description|directUrl)=/i.test(s));
  const baseReasons = storedReasons.length ? storedReasons : cls.reasons;

  // Feedback-learned signal (from graded opportunities) folded into ranking.
  const feedbackScore = typeof opp.userConfidence === "string" && opp.userConfidence.trim() !== ""
    ? Math.round(parseFloat(opp.userConfidence))
    : null;
  const feedbackAdj = feedbackAdjustment(opp.userConfidence);
  const feedbackReasons: string[] = [];
  if (feedbackAdj >= 5) feedbackReasons.push("Matches your feedback preferences");
  else if (feedbackAdj <= -5) feedbackReasons.push("Down-ranked by your feedback");

  const reasons = [
    ...(!primaryScopeEvidenced ? ["Specific purchased-scope evidence is missing; review the solicitation."] : []),
    ...feedbackReasons, ...baseReasons,
  ].slice(0, 4);

  const dateUnknown = tags.includes("date-unknown");
  const stale = tags.includes("stale") || cls.stale;
  const thresholds = getRelevanceProfile().thresholds;
  const confidence: "high" | "medium" | "low" =
    opp.sourceConfidence === "high" || opp.sourceConfidence === "medium" || opp.sourceConfidence === "low"
      ? opp.sourceConfidence
      : score >= thresholds.acceptMin ? "high" : score >= thresholds.reviewMin ? "medium" : "low";

  return {
    score,
    reasons,
    why,
    decisionMethod,
    category: testing.primary ?? cls.category,
    testingTypes: testing.all,
    dateUnknown,
    stale,
    confidence,
    feedbackScore,
    feedbackAdj,
    semanticSimilarity: null as number | null,
    postedDate: dateUnknown ? null : opp.postedDate,
  };
}

function mapOpportunity(opp: any) {
  return {
    ...opp,
    awardAmount: opp.awardAmount ? parseFloat(opp.awardAmount) : undefined,
    estimatedValue: opp.estimatedValue ? parseFloat(opp.estimatedValue) : undefined,
    ceilingValue: opp.ceilingValue ? parseFloat(opp.ceilingValue) : undefined,
    floorValue: opp.floorValue ? parseFloat(opp.floorValue) : undefined,
    relevanceScore: opp.relevanceScore ? parseFloat(opp.relevanceScore) : undefined,
    tags: parseTags(opp.tags),
    relevance: buildRelevanceView(opp),
  };
}

// GET /opportunities and POST /opportunities/purge-junk are owned by opportunity-safety-boundary.ts, which is
// registered first in routes/index.ts and always responds (the purge with HTTP 410). The former duplicate list
// handler and the destructive purge that lived here were unreachable and have been removed.

router.post("/opportunities/fetch", createStartIngestionHandler(startManualIngestion));

// Daily procurement run schedule: next slot and what the scheduler last did. Registered before "/opportunities/:id".
router.get("/opportunities/schedule", async (req, res) => {
  try {
    const { getDailySchedulerStatus } = await import("../lib/ingestion/dailyScheduler");
    return res.json(await getDailySchedulerStatus());
  } catch (error) {
    req.log?.error(error);
    return res.status(500).json({ error: "Unable to read the daily run schedule" });
  }
});

router.get("/opportunities/ingestion-runs/current", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.json({ run: await getCurrentIngestionRun() });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to read the current ingestion run" });
  }
});

router.get("/opportunities/ingestion-runs", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 20);
    return res.json({ runs: await listRecentIngestionRuns(Number.isFinite(limit) ? limit : 20) });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to list ingestion runs" });
  }
});

router.get("/opportunities/ingestion-runs/:runId", async (req, res) => {
  try {
    const run = await getIngestionRun(req.params.runId);
    if (!run) return res.status(404).json({ error: "Ingestion run not found" });
    return res.json({ run });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to read ingestion run" });
  }
});

router.post("/opportunities/ingestion-runs/:runId/stop", async (req, res) => {
  try {
    const run = await cancelManualIngestion(req.params.runId);
    if (!run) return res.status(404).json({ error: "Ingestion run not found" });
    return res.status(202).json({ runId: run.id, status: run.status, run });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to stop ingestion run", details: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/opportunities/ingestion-runs/:runId/retry", async (req, res) => {
  try {
    const run = await retryFailedProviders(req.params.runId);
    return res.status(202).json({ runId: run.id, status: run.status, run });
  } catch (err: any) {
    req.log.error(err);
    if (err?.constructor?.name === "ActiveIngestionRunError") return res.status(409).json({ error: err.message, runId: err.runId });
    if (err instanceof IngestionRunNotRetryableError) return res.status(400).json({ error: err.message });
    if (String(err?.message).includes("not found")) return res.status(404).json({ error: err.message });
    return res.status(500).json({ error: "Failed to retry ingestion run" });
  }
});

router.post("/opportunities/reconcile-expired", async (req, res) => {
  try {
    return res.json({ archived: await reconcileExpiredOpportunities() });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Deadline reconciliation failed" });
  }
});

router.post("/opportunities/import", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const csvContent = req.file.buffer.toString("utf-8");
    const result = await importFromCsv(csvContent);
    return res.json(result);
  } catch (err: any) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to import CSV", details: err.message });
  }
});

router.get("/opportunities/:id", async (req, res) => {
  try {
    const rows = await db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, req.params.id));
    if (rows.length === 0) return res.status(404).json({ error: "Opportunity not found" });
    return res.json(mapOpportunity(rows[0]));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to get opportunity" });
  }
});

router.delete("/opportunities/:id", async (req, res) => {
  try {
    await db.delete(opportunitiesTable).where(eq(opportunitiesTable.id, req.params.id));
    return res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to delete opportunity" });
  }
});

function toDateString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  try {
    const d = typeof value === "string" ? new Date(value) : value;
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split("T")[0];
  } catch {
    return null;
  }
}

function formatCurrency(value: number | string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n}`;
}

function detectServiceLines(text: string): string[] {
  // Service lines are the Neon profile's categories evidenced by the text.
  return matchedServiceLines(text);
}

function buildFallbackSummary(opp: any) {
  const text = `${opp.title ?? ""} ${opp.description ?? ""} ${opp.agency ?? ""} ${opp.notes ?? ""}`;
  const lines = detectServiceLines(text);
  const due = toDateString(opp.responseDeadline);
  const posted = toDateString(opp.postedDate);
  const value = formatCurrency(opp.estimatedValue ?? opp.awardAmount ?? opp.ceilingValue ?? opp.floorValue);
  const sourceUrl = opp.samUrl || opp.sourceUrl || opp.url || null;
  const buyer = opp.agency && opp.agency !== "Unknown" ? opp.agency : null;
  const summarySentences: string[] = [opp.title ?? "Opportunity details are limited."];
  if (opp.description) summarySentences.push(opp.description.slice(0, 220).replace(/\s+/g, " ").trim() + (opp.description.length > 220 ? "..." : ""));
  if (buyer) summarySentences.push(`Procuring agency: ${buyer}.`);
  if (due) summarySentences.push(`Response due ${due}.`);

  const fitReason = opp.relevance?.reasons?.length
    ? opp.relevance.reasons.slice(0, 2).join(" ")
    : `Mentions ${lines.slice(0, 2).join(" and ") || "the Occu-Med service profile"}.`;

  const missing: string[] = [];
  if (!due) missing.push("Response deadline");
  if (!value) missing.push("Estimated value");
  if (!buyer) missing.push("Procuring agency");
  if (!opp.description || opp.description.length < 60) missing.push("Full opportunity description");
  if (!sourceUrl) missing.push("Source link");

  return {
    summary: summarySentences.join(" "),
    occumedFit: `This appears to match Occu-Med based on ${fitReason}`,
    serviceLines: lines.slice(0, 3),
    keyDates: { posted, due },
    buyer,
    estimatedValue: value,
    bidNotes: ["Review source page to confirm scope and eligibility before bidding.", opp.relevance?.stale ? "Posted date may be stale; verify it is still open." : "Confirm deadline on the source page."].filter(Boolean),
    missingInfo: missing,
    sourceUrl,
    provider: "fallback" as const,
  };
}

function cleanJsonResponse(text: string): string {
  return text
    .replace(/```json\n?/gi, "")
    .replace(/```\n?/g, "")
    .replace(/^\s*\{\s*/g, "{")
    .replace(/\s*\}\s*$/g, "}")
    .trim();
}

function buildSummaryPrompt(opp: any, extractedContent: string | null, companyContext?: string): string {
  const due = toDateString(opp.responseDeadline);
  const posted = toDateString(opp.postedDate);
  const value = formatCurrency(opp.estimatedValue ?? opp.awardAmount ?? opp.ceilingValue ?? opp.floorValue);
  const sourceUrl = opp.samUrl || opp.sourceUrl || opp.url || null;
  const buyer = opp.agency && opp.agency !== "Unknown" ? opp.agency : null;
  const score = opp.relevance?.score ?? opp.relevanceScore ?? null;
  const reasons = opp.relevance?.reasons?.join(" · ") ?? (typeof opp.notes === "string" ? opp.notes : "");

  const companyBlock = companyContext ??
    `Occu-Med provides: ${profileServiceLabels().join("; ")}.`;

  return `You are an RFP analyst for Occu-Med. ${companyBlock}

${judgeScopeBlock()}

Analyze the opportunity below and produce a concise procurement brief.

Rules:
- Be practical and business-focused.
- Do not hallucinate missing dates, values, or agencies.
- If the opportunity is likely irrelevant, say so clearly.
- Return ONLY valid JSON.

Required JSON:
{
  "summary": "2-4 sentence plain-English summary",
  "occumedFit": "why this may or may not fit Occu-Med",
  "serviceLines": ["..."],
  "keyDates": {
    "posted": "YYYY-MM-DD or null",
    "due": "YYYY-MM-DD or null"
  },
  "buyer": "agency/buyer or null",
  "estimatedValue": "value or null",
  "bidNotes": ["short practical note", "short practical note"],
  "missingInfo": ["missing item", "missing item"]
}

Opportunity:
Title: ${opp.title ?? "N/A"}
Agency: ${buyer ?? "N/A"}
Posted: ${posted ?? "N/A"}
Due: ${due ?? "N/A"}
Estimated Value: ${value ?? "N/A"}
Relevance Score: ${score ?? "N/A"}
Relevance Reasons: ${reasons || "N/A"}
Source URL: ${sourceUrl ?? "N/A"}
Description: ${(opp.description ?? "").slice(0, 2500).replace(/\s+/g, " ").trim() || "N/A"}
${extractedContent ? `Extracted Page Content:\n${extractedContent.slice(0, 4000).replace(/\s+/g, " ").trim()}` : ""}`;
}

async function completeWithProvider(prompt: string, provider: "groq" | "openrouter"): Promise<any> {
  const text = provider === "groq"
    ? await groqProvider.complete(prompt, 900)
    : await openrouterProvider.complete(prompt, 900);
  const cleaned = cleanJsonResponse(text);
  return JSON.parse(cleaned);
}

function sanitizeSummaryResult(raw: any, opp: any): any {
  const sourceUrl = opp.samUrl || opp.sourceUrl || opp.url || null;
  const fallback = buildFallbackSummary(opp);

  return {
    summary: typeof raw?.summary === "string" && raw.summary.trim() ? raw.summary : fallback.summary,
    occumedFit: typeof raw?.occumedFit === "string" && raw.occumedFit.trim() ? raw.occumedFit : fallback.occumedFit,
    serviceLines: Array.isArray(raw?.serviceLines) && raw.serviceLines.length > 0 ? raw.serviceLines.filter((s: any) => typeof s === "string").slice(0, 5) : fallback.serviceLines,
    keyDates: {
      posted: typeof raw?.keyDates?.posted === "string" ? raw.keyDates.posted || null : fallback.keyDates.posted,
      due: typeof raw?.keyDates?.due === "string" ? raw.keyDates.due || null : fallback.keyDates.due,
    },
    buyer: typeof raw?.buyer === "string" ? raw.buyer || null : fallback.buyer,
    estimatedValue: typeof raw?.estimatedValue === "string" ? raw.estimatedValue || null : fallback.estimatedValue,
    bidNotes: Array.isArray(raw?.bidNotes) && raw.bidNotes.length > 0 ? raw.bidNotes.filter((s: any) => typeof s === "string").slice(0, 5) : fallback.bidNotes,
    missingInfo: Array.isArray(raw?.missingInfo) && raw.missingInfo.length > 0 ? raw.missingInfo.filter((s: any) => typeof s === "string").slice(0, 5) : fallback.missingInfo,
    sourceUrl,
    provider: raw?.provider ?? "fallback",
  };
}

router.post("/opportunities/:id/summary", async (req, res) => {
  try {
    const rows = await db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, req.params.id));
    if (rows.length === 0) return res.status(404).json({ error: "Opportunity not found" });

    const opp = mapOpportunity(rows[0]);
    const sourceUrl = opp.samUrl || opp.sourceUrl || opp.url || null;
    let extractedContent: string | null = null;

    if (sourceUrl) {
      try {
        if (await jinaProvider.isConfigured()) {
          extractedContent = await jinaProvider.extractUrl(sourceUrl, 10_000);
        }
      } catch (err) {
        req.log.warn(err, "Jina extract failed for summary");
      }
    }

    const prompt = buildSummaryPrompt(opp, extractedContent);
    let result: any = null;
    let provider: "groq" | "openrouter" | "fallback" = "fallback";

    try {
      const isGroqConfigured = await groqProvider.isConfigured();
      if (isGroqConfigured) {
        result = await completeWithProvider(prompt, "groq");
        provider = "groq";
      }
    } catch (err) {
      req.log.warn(err, "Groq summary failed");
    }

    if (!result) {
      try {
        const isOpenRouterConfigured = await openrouterProvider.isConfigured();
        if (isOpenRouterConfigured) {
          result = await completeWithProvider(prompt, "openrouter");
          provider = "openrouter";
        }
      } catch (err) {
        req.log.warn(err, "OpenRouter summary failed");
      }
    }

    if (!result) {
      return res.json(buildFallbackSummary(opp));
    }

    return res.json(sanitizeSummaryResult({ ...result, provider }, opp));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to generate summary" });
  }
});

router.post("/opportunities/enrich", async (req, res) => {
  const BATCH_SIZE = 5;
  const MAX_RECORDS = 30;
  const stats = { agencyUpdated: 0, deadlineUpdated: 0, valueUpdated: 0, errors: [] as string[] };
  const updatedIds = new Set<string>();

  try {
    const records = await db
      .select({
        id: opportunitiesTable.id,
        title: opportunitiesTable.title,
        description: opportunitiesTable.description,
        agency: opportunitiesTable.agency,
        samUrl: opportunitiesTable.samUrl,
        responseDeadline: opportunitiesTable.responseDeadline,
        estimatedValue: opportunitiesTable.estimatedValue,
      })
      .from(opportunitiesTable)
      .where(
        or(
          isNull(opportunitiesTable.responseDeadline),
          isNull(opportunitiesTable.estimatedValue),
          eq(opportunitiesTable.agency, "Unknown")
        )
      )
      .orderBy(asc(opportunitiesTable.updatedAt), asc(opportunitiesTable.id))
      .limit(MAX_RECORDS);

    for (const rec of records) {
      const { agencyHint } = extractMetadataFromText(rec.description ?? "", rec.title);
      if (agencyHint && rec.agency === "Unknown") {
        await db.update(opportunitiesTable).set({ agency: agencyHint, updatedAt: new Date() }).where(eq(opportunitiesTable.id, rec.id));
        stats.agencyUpdated++;
        updatedIds.add(rec.id);
        rec.agency = agencyHint;
      }
    }

    const needsEnrich = records.filter((r) => r.samUrl && (!r.responseDeadline || !r.estimatedValue));
    const isJinaAvailable = await jinaProvider.isConfigured();
    if (!isJinaAvailable) {
      stats.errors.push("Jina not configured — date/value enrichment skipped");
    } else {
      for (let i = 0; i < needsEnrich.length; i += BATCH_SIZE) {
        const batch = needsEnrich.slice(i, i + BATCH_SIZE);
        const urls = batch.map((r) => r.samUrl!);
        let extracted = new Map<string, string>();
        try {
          extracted = await jinaProvider.extractUrls(urls, 3, 10_000);
        } catch (err: any) {
          stats.errors.push(`Jina batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err.message}`);
          continue;
        }

        for (const [url, rawContent] of extracted) {
          const rec = batch.find((r) => r.samUrl === url);
          if (!rec) continue;
          const { deadline, estimatedValue, agencyHint } = extractMetadataFromText(rawContent.slice(0, 4000), rec.title);
          const updates: Record<string, unknown> = { updatedAt: new Date() };
          if (!rec.responseDeadline && deadline) {
            updates.responseDeadline = deadline;
            stats.deadlineUpdated++;
            if (deadline < new Date()) updates.status = "archived";
          }
          if (!rec.estimatedValue && estimatedValue != null) {
            updates.estimatedValue = String(estimatedValue);
            stats.valueUpdated++;
          }
          if (rec.agency === "Unknown" && agencyHint) {
            updates.agency = agencyHint;
            stats.agencyUpdated++;
          }

          if (Object.keys(updates).length > 1) {
            await db.update(opportunitiesTable).set(updates).where(eq(opportunitiesTable.id, rec.id));
            updatedIds.add(rec.id);
          }
        }

        if (i + BATCH_SIZE < needsEnrich.length) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    return res.json({
      enriched: updatedIds.size,
      agencyUpdated: stats.agencyUpdated,
      deadlineUpdated: stats.deadlineUpdated,
      valueUpdated: stats.valueUpdated,
      processed: records.length,
      errors: stats.errors,
    });
  } catch (err: any) {
    req.log.error(err);
    return res.status(500).json({ error: "Enrichment failed", details: err.message });
  }
});

export default router;
