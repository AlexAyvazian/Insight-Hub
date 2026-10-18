import { Router } from "express";
import { eq } from "drizzle-orm";
import { rfpDb as db } from "@workspace/db";
import { opportunitiesTable } from "@workspace/db/schema";
import { jinaProvider } from "../lib/providers/jina";
import { firecrawlProvider } from "../lib/providers/firecrawl";
import { olostepProvider } from "../lib/providers/olostep";
import { cloudflareWorkerProvider } from "../lib/providers/cloudflareWorker";
import { geminiProvider } from "../lib/providers/gemini";
import { groqProvider } from "../lib/providers/groq";
import { openrouterProvider } from "../lib/providers/openrouter";
import { minimaxProvider } from "../lib/providers/minimax";
import { clodProvider } from "../lib/providers/clod";
import {
  cerebrasProvider,
  deepseekProvider,
  mistralProvider,
  nvidiaProvider,
} from "../lib/providers/openAiCompatible";
import { runLimitedProviderPool } from "../lib/limitedProviderPool";
import {
  classifyOpportunityQuality,
  plainSummaryIneligibilityReason,
  summaryEvidenceFingerprint,
  summaryIneligibilityReason,
} from "../lib/opportunityQuality";
import { isUsableAiBrief, mergeSummaryWithVerifiedFacts } from "../lib/summaryEvidence";
import { matchedServiceLines } from "../lib/search/profileServiceLines";
import { judgeScopeBlock, profileServiceLabels } from "../lib/search/profileText";
import { getRelevanceProfile } from "../lib/search/relevanceProfile";

const router = Router();
// Bump when the brief prompt or merge rules change, so briefs written under the old rules are regenerated.
export const SUMMARY_EVALUATOR_VERSION = "brief-v2.1";
const summaryCache = new Map<string, any>();

/**
 * What a cached brief was written from, beyond the notice text: the profile version, the brief rules, and the
 * stored document hashes and assessment. A material amendment changes one of these, so its old brief is not served.
 */
export function summaryCacheVersion(opp: { rawData?: unknown; raw_data?: unknown }, profileVersion: string): string {
  const raw = ((opp.rawData ?? opp.raw_data ?? {}) as Record<string, unknown>) || {};
  const evidence = raw.documentEvidence as { hashes?: unknown } | undefined;
  const ledger = raw.requirementLedger as { assessment?: { summary?: unknown } } | undefined;
  return [
    SUMMARY_EVALUATOR_VERSION,
    profileVersion,
    Array.isArray(evidence?.hashes) ? [...evidence!.hashes].map(String).sort().join(",") : "",
    typeof ledger?.assessment?.summary === "string" ? ledger.assessment.summary : "",
  ].join("|");
}
const SUMMARY_CACHE_MAX = 250;

function getCachedSummary(id: string): any | undefined {
  const cached = summaryCache.get(id);
  if (cached) {
    summaryCache.delete(id);
    summaryCache.set(id, cached);
  }
  return cached;
}

function cacheSummary(id: string, summary: any): void {
  summaryCache.delete(id);
  summaryCache.set(id, summary);
  while (summaryCache.size > SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next().value;
    if (typeof oldest !== "string") break;
    summaryCache.delete(oldest);
  }
}

function cleanText(value: unknown, max = 4000): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function dateOnly(value: unknown): string | null {
  if (!value) return null;
  const date =
    typeof value === "string"
      ? new Date(value)
      : value instanceof Date
        ? value
        : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
}

function money(value: unknown): string | null {
  if (value == null || value === "") return null;
  const n =
    typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n}`;
}

function sourceUrl(opp: any): string | null {
  return opp.samUrl || opp.sourceUrl || opp.url || null;
}

/** Service lines the text evidences, as profile category labels (no service vocabulary lives in this route). */
function findServiceLines(text: string): string[] {
  return matchedServiceLines(text);
}

function baseBrief(opp: any, extracted: string | null) {
  const text = cleanText(
    `${opp.title ?? ""} ${opp.description ?? ""} ${opp.notes ?? ""} ${extracted ?? ""}`,
    9000,
  );
  const lines = findServiceLines(text);
  const buyer =
    opp.agency && opp.agency !== "Unknown" ? String(opp.agency) : null;
  const posted = dateOnly(opp.postedDate);
  const due = dateOnly(opp.responseDeadline);
  const estimatedValue = money(
    opp.estimatedValue ?? opp.awardAmount ?? opp.ceilingValue ?? opp.floorValue,
  );
  const url = sourceUrl(opp);
  const confidence =
    extracted && extracted.length > 800
      ? lines.length
        ? "high"
        : "medium"
      : lines.length
        ? "medium"
        : "low";
  const verdict =
    lines.length >= 2
      ? "Strong fit after source verification"
      : lines.length === 1
        ? "Partial fit after source verification"
        : "Not qualified from saved card alone";
  const missingInfo = [
    !due ? "confirmed deadline" : null,
    !estimatedValue ? "estimated value / budget" : null,
    !buyer ? "buyer / contracting office" : null,
    !url ? "working source link" : null,
    !extracted ? "full source text" : null,
    lines.length === 0 ? "specific Occu-Med service requirement" : null,
  ].filter(Boolean) as string[];

  return {
    summary: `${opp.title ?? "Opportunity"} is listed by ${buyer ?? "an unknown buyer"}. ${lines.length ? `Detected service relevance: ${lines.join(", ")}.` : "The saved card does not prove a relevant service scope."} ${due ? `Listed due date: ${due}.` : "No due date is available in the saved record."}`,
    occumedFit: lines.length
      ? `Verdict: ${verdict}. This is relevant only where the source confirms ${lines.join(", ")}; do not treat it as bid-ready until deadline, location, submission method, and scope are verified.`
      : "Verdict: not qualified from the saved card alone. Open the source first; the card is too vague to connect to Occu-Med's service lines.",
    serviceLines: lines.length ? lines : ["Needs source review"],
    keyDates: { posted, due },
    buyer,
    estimatedValue,
    bidNotes: [
      `Decision status: ${verdict}. Confidence: ${confidence}.`,
      lines.length
        ? "Next action: verify source scope, locations, submission method, and whether clinic-network delivery is allowed."
        : "Next action: open source before spending time on pricing or outreach.",
    ],
    missingInfo,
    sourceUrl: url,
    provider: "rule-check-v2",
    fitVerdict: verdict,
    confidence,
  };
}

function jsonOnly(text: string): any {
  const stripped = text
    .replace(/```json\n?/gi, "")
    .replace(/```\n?/g, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  return JSON.parse(
    start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped,
  );
}

function promptFor(opp: any, base: any, extracted: string | null): string {
  return `You are the bid analyst for Occu-Med. Write a practical bid/no-bid brief for the procurement below.
Occu-Med provides: ${profileServiceLabels().join("; ")}.
Rules: use only facts stated in the material below. Never invent dates, dollar values, buyers, quantities, or scope. If the material does not state something, leave it null or list it under missingInfo. Name the specific tests or exams the buyer asks for instead of saying "occupational health". Do not hedge with "may" or "might" when the material is clear either way; state whether the scope fits and why.
${judgeScopeBlock()}

Rule-check verdict: ${base.fitVerdict}
Rule-check confidence: ${base.confidence}
Detected service lines: ${base.serviceLines.join(", ")}
Missing info: ${base.missingInfo.join(", ") || "none"}

Return only JSON with exactly these keys:
{"summary":"2-3 sentences: who is buying what, for whom, and where","occumedFit":"1-2 sentences: does the scope match what Occu-Med delivers, and the single biggest reason it does or does not","serviceLines":["profile service lines the scope covers"],"testsRequested":["each specific test, exam or service the buyer asks for, e.g. DOT drug screen, audiogram, respirator fit test"],"scope":"quantities, locations, contract term and submission method if stated, else null","keyDates":{"posted":"YYYY-MM-DD or null","due":"YYYY-MM-DD or null"},"buyer":"buyer exactly as written in the material, or null","estimatedValue":"value exactly as written in the material, or null","bidNotes":["next action","main risk"],"missingInfo":["facts a bidder still needs"]}

Title: ${opp.title ?? "N/A"}
Buyer: ${base.buyer ?? "N/A"}
Posted: ${base.keyDates.posted ?? "N/A"}
Due: ${base.keyDates.due ?? "N/A"}
Classification: ${base.fitVerdict ? ((base as any).classification ?? "N/A") : "N/A"}
Evidence source: ${(base as any).evidenceSource ?? "N/A"}
Source authority: ${(base as any).sourceAuthority ?? "N/A"}
Value: ${base.estimatedValue ?? "N/A"}
NAICS: ${opp.naicsCode ?? "N/A"}${opp.naicsDescription ? ` (${cleanText(opp.naicsDescription, 120)})` : ""}
PSC: ${opp.pscCode ?? "N/A"}
Set-aside: ${opp.setAside ?? "N/A"}
URL: ${base.sourceUrl ?? "N/A"}
Description: ${cleanText(opp.description, 3000) || "N/A"}
Notes: ${cleanText(opp.notes, 1200) || "N/A"}
${extracted ? `Source text: ${cleanText(extracted, 9000)}` : "Source text unavailable."}`;
}

router.post("/opportunities/:id/summary", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, req.params.id));
    if (!rows.length)
      return res.status(404).json({ error: "Opportunity not found" });
    const opp = rows[0] as any;
    let extracted: string | null = null;
    const url = sourceUrl(opp);

    if (url) {
      const extraction = await runLimitedProviderPool(
        "opportunity-brief-enrichment",
        [
          {
            name: "jina",
            isConfigured: () => jinaProvider.isConfigured(),
            run: () => jinaProvider.extractUrl(url, 10_000),
          },
          {
            name: "firecrawl",
            isConfigured: () => firecrawlProvider.isConfigured(),
            run: async () =>
              (await firecrawlProvider.scrape(url))?.markdown ?? null,
          },
          {
            name: "olostep",
            isConfigured: () => olostepProvider.isConfigured(),
            run: () => olostepProvider.getText(url),
          },
          {
            name: "cloudflare-worker",
            isConfigured: () => cloudflareWorkerProvider.isConfigured(),
            run: () => cloudflareWorkerProvider.extractUrl(url),
          },
        ],
        (value) => typeof value === "string" && value.length >= 400,
      );
      extracted = extraction.value;
      if (extraction.errors.length > 0) {
        req.log.warn(
          { errors: extraction.errors },
          "one or more summary extraction providers failed",
        );
      }
    }

    const quality = classifyOpportunityQuality(opp);
    const hasAuthoritativeContent = Boolean(
      extracted && extracted.length >= 400,
    );
    const hasStructuredDirectEvidence = quality.summaryEligible;
    const reasonCode =
      !hasAuthoritativeContent && !hasStructuredDirectEvidence
        ? (summaryIneligibilityReason(quality, false) ??
          "authoritative_content_unavailable")
        : summaryIneligibilityReason(quality, true);
    const base = {
      ...baseBrief(opp, extracted),
      classification: quality.classification,
      solicitationType: opp.type ?? null,
      evidenceSource: quality.sourceType,
      sourceAuthority: quality.sourceAuthority,
      eligible: !reasonCode,
    };
    if (reasonCode) {
      return res.json({
        ...base,
        eligible: false,
        preliminary: true,
        classification: quality.classification,
        reasonCode,
        verificationReason: plainSummaryIneligibilityReason(reasonCode),
        quality,
      });
    }
    const evidenceFingerprint = summaryEvidenceFingerprint(
      quality,
      `${cleanText(extracted, 6000)}|${summaryCacheVersion(opp, getRelevanceProfile().version)}`,
    );
    const cached = getCachedSummary(opp.id);
    if (cached?.evidenceFingerprint === evidenceFingerprint)
      return res.json({ ...cached, cached: true });
    const verifiedBase = { ...base, eligible: true, evidenceFingerprint };
    const prompt = promptFor({ ...opp, quality }, verifiedBase, extracted);

    const completion = await runLimitedProviderPool(
      "opportunity-brief-ai",
      [
        cerebrasProvider,
        groqProvider,
        geminiProvider,
        openrouterProvider,
        mistralProvider,
        deepseekProvider,
        nvidiaProvider,
        minimaxProvider,
        clodProvider,
      ].map((provider) => ({
        name: provider.name,
        isConfigured: () => provider.isConfigured(),
        run: async () => jsonOnly(await provider.complete(prompt, 1_400)),
      })),
      isUsableAiBrief,
    );
    if (completion.value && completion.provider) {
      const merged = mergeSummaryWithVerifiedFacts(
        completion.value,
        verifiedBase,
        `${completion.provider}-v2`,
        extracted,
      );
      cacheSummary(opp.id, merged);
      return res.json(merged);
    }
    if (completion.errors.length > 0) {
      req.log.warn(
        { errors: completion.errors },
        "all configured summary AI providers failed",
      );
    }

    cacheSummary(opp.id, verifiedBase);
    return res.json(verifiedBase);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to generate summary" });
  }
});

export default router;
