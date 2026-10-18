import { Router } from "express";
import { and, asc, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { rfpDb as db } from "@workspace/db";
import { opportunitiesTable } from "@workspace/db/schema";
import { classifyResult } from "../lib/search/relevance";
import { decideRelevance } from "../lib/search/relevanceDecision";
import {
  classifyOpportunityQuality,
  calculateOpportunityRank,
  canonicalOpportunityKey,
  qualityMatchesView,
  type OpportunityQualityView,
  type OpportunityViewMode,
} from "../lib/opportunityQuality";
import { contextualAdjustments } from "../lib/learning/contextualFeedback";
import {
  opportunityListErrorDetail,
  opportunityListSelection,
} from "./opportunityListQuery";

const router = Router();
const VIEW_MODES = new Set<OpportunityViewMode>([
  "actionable",
  "needs-verification",
  "closed",
  "all",
]);
const FEEDBACK_RANK_WEIGHT = 15;
/** Rows ranked per database round trip; bounds transient memory per batch. */
const SCAN_BATCH_SIZE = 1_000;
/** Safety ceiling for one list request; exceeding it is reported (`truncated`, `totalBasis: "partial"`). */
const DEFAULT_MAX_SCAN_ROWS = 50_000;
function maxScanRows(): number {
  const parsed = Number.parseInt(process.env.OPPORTUNITY_LIST_MAX_SCAN_ROWS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= SCAN_BATCH_SIZE ? Math.min(parsed, 200_000) : DEFAULT_MAX_SCAN_ROWS;
}
/** Description characters used for ranking; the returned page carries the full description. */
const RANKING_DESCRIPTION_CHARS = 8_000;

interface RankedEntry {
  id: string;
  title: string;
  rank: number;
  authority: ReturnType<typeof sourceAuthority>;
  contextualAdjustment: number;
  contextualFeedback: number;
  contextHash: string;
  suppressed: boolean;
  /** Providers whose records collapsed into this canonical notice (provenance). */
  sources: string[];
}

function rankingScanSelection(table: typeof opportunitiesTable) {
  return {
    ...opportunityListSelection(table),
    description: sql<string | null>`left(${table.description}, ${RANKING_DESCRIPTION_CHARS})`,
  };
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return raw
      .split(/[,;|]/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
}

function feedbackAdjustment(value: unknown): number {
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const delta = ((parsed - 50) / 50) * FEEDBACK_RANK_WEIGHT;
  return Math.round(
    Math.max(-FEEDBACK_RANK_WEIGHT, Math.min(FEEDBACK_RANK_WEIGHT, delta)),
  );
}

function sourceAuthority(provider: unknown): {
  label: "official" | "structured" | "discovery" | "other";
  bonus: number;
} {
  const value = String(provider ?? "").toLowerCase();
  if (value === "samgov" || value === "sam_gov") {
    return { label: "official", bonus: 240 };
  }
  if (value === "internationalpublicportals") {
    return { label: "official", bonus: 220 };
  }
  // Tango is a structured secondary procurement source: above search discovery,
  // below official sources, so an official record of the same notice owns the
  // canonical row. opportunityQuality uses the same tier (trusted only when the
  // record points at an official notice page).
  if (value === "tango") return { label: "structured", bonus: 120 };
  if (
    [
      "langsearch",
      "serper",
      "exa",
      "parallel",
      "linkup",
      "you",
      "socrata",
      "websearch",
      "aidiscovery",
    ].includes(value)
  ) {
    return { label: "discovery", bonus: 20 };
  }
  return { label: "other", bonus: 0 };
}

function relevanceView(
  opp: Record<string, any>,
  contextualAdjustment = 0,
  quality: OpportunityQualityView = classifyOpportunityQuality(opp),
) {
  const classification = classifyResult({
    title: opp.title,
    snippet: [
      opp.type,
      opp.solicitationNumber,
      opp.description,
    ]
      .filter(Boolean)
      .join(" "),
    url: opp.samUrl,
    date: opp.postedDate,
    deadlineInFuture: Boolean(
      opp.responseDeadline &&
        new Date(opp.responseDeadline).getTime() > Date.now(),
    ),
    allowHistorical: true,
  });
  const tags = parseTags(opp.tags);
  // The visible score and verdict follow the authoritative quality decision: without purchased-scope evidence the
  // score is capped and an "accept" is shown as "review", whatever the classifier or a stored score says.
  const score = quality.relevanceScore;
  const classifierDecision = decideRelevance(classification);
  const scopeHeld = !quality.purchasedScopeEvidenced && classifierDecision.verdict === "accept";
  const decision = scopeHeld
    ? { ...classifierDecision, verdict: "review" as const }
    : classifierDecision;
  const dateUnknown =
    tags.includes("date-unknown") ||
    !opp.postedDate ||
    new Date(opp.postedDate).getTime() <= 0;
  const confidence =
    opp.sourceConfidence === "high" ||
    opp.sourceConfidence === "medium" ||
    opp.sourceConfidence === "low"
      ? opp.sourceConfidence
      : decision.verdict === "accept"
        ? "high"
        : decision.verdict === "review"
          ? "medium"
          : "low";
  const globalAdjustment = feedbackAdjustment(opp.userConfidence);
  return {
    score,
    // Canonical accept/review/reject decision and the thresholds it applied (Neon profile). The UI renders
    // these; it never compares scores to cutoffs of its own.
    verdict: decision.verdict,
    thresholds: decision.thresholds,
    reasons: [
      ...(quality.purchasedScopeEvidenced
        ? []
        : ["Specific purchased-scope evidence is missing; review the solicitation."]),
      ...classification.reasons,
    ].slice(0, 4),
    purchasedScopeEvidenced: quality.purchasedScopeEvidenced,
    // Only listing text was evaluated; attachments/SOW are not read by this view.
    documentCoverage: "listing-text-only" as const,
    category: classification.category,
    dateUnknown,
    stale: tags.includes("stale") || classification.stale,
    confidence,
    feedbackScore:
      opp.userConfidence == null ? null : Number(opp.userConfidence),
    feedbackAdj: globalAdjustment + contextualAdjustment,
    globalFeedbackAdj: globalAdjustment,
    contextualFeedbackAdj: contextualAdjustment,
    semanticSimilarity: null as number | null,
    postedDate: dateUnknown ? null : opp.postedDate,
  };
}

function mapOpportunity(
  opp: Record<string, any>,
  contextualAdjustment = 0,
  quality: OpportunityQualityView = classifyOpportunityQuality(opp),
) {
  return {
    ...opp,
    awardAmount: opp.awardAmount ? Number(opp.awardAmount) : undefined,
    estimatedValue: opp.estimatedValue
      ? Number(opp.estimatedValue)
      : undefined,
    ceilingValue: opp.ceilingValue ? Number(opp.ceilingValue) : undefined,
    floorValue: opp.floorValue ? Number(opp.floorValue) : undefined,
    relevanceScore: opp.relevanceScore
      ? Number(opp.relevanceScore)
      : undefined,
    tags: parseTags(opp.tags),
    relevance: relevanceView(opp, contextualAdjustment, quality),
  };
}

router.get("/opportunities", async (req, res) => {
  try {
    const search = String(req.query.search ?? "").trim();
    const status = String(req.query.status ?? "").trim();
    const type = String(req.query.type ?? "").trim();
    const naicsCode = String(req.query.naicsCode ?? "").trim();
    const agency = String(req.query.agency ?? "").trim();
    const source = String(req.query.source ?? "").trim();
    const viewRaw = String(req.query.view ?? "actionable").trim();
    const view: OpportunityViewMode = VIEW_MODES.has(
      viewRaw as OpportunityViewMode,
    )
      ? (viewRaw as OpportunityViewMode)
      : "actionable";
    const page = Math.max(
      1,
      Number.parseInt(String(req.query.page ?? "1"), 10) || 1,
    );
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(String(req.query.limit ?? "50"), 10) || 50),
    );
    const dateRange = Number.parseInt(String(req.query.dateRange ?? ""), 10);
    const freshOnly = String(req.query.freshOnly ?? "") === "true";
    const rankingNow = new Date();

    const conditions: any[] = [];
    if (status === "active" || status === "archived") {
      conditions.push(eq(opportunitiesTable.status, status));
    }
    if (type) conditions.push(ilike(opportunitiesTable.type, `%${type}%`));
    if (naicsCode) conditions.push(eq(opportunitiesTable.naicsCode, naicsCode));
    if (agency) conditions.push(ilike(opportunitiesTable.agency, `%${agency}%`));
    if (source) {
      const sourceAliases: Record<string, string[]> = {
        sam_gov: ["samGov", "sam_gov"],
        samGov: ["samGov", "sam_gov"],
        statePortals: ["publicPortalProviders"],
        publicPortalProviders: ["publicPortalProviders"],
      };
      const keys = sourceAliases[source] ?? [source];
      conditions.push(
        or(
          ...keys.flatMap((key) => [
            eq(opportunitiesTable.providerKey, key),
            eq(opportunitiesTable.providerName, key),
          ]),
        ),
      );
    }
    if (search) {
      const pattern = `%${search}%`;
      conditions.push(
        or(
          ilike(opportunitiesTable.title, pattern),
          ilike(opportunitiesTable.agency, pattern),
          ilike(opportunitiesTable.description, pattern),
          ilike(opportunitiesTable.solicitationNumber, pattern),
        ),
      );
    }
    if (Number.isFinite(dateRange) && dateRange > 0) {
      conditions.push(
        gt(
          opportunitiesTable.postedDate,
          new Date(Date.now() - dateRange * 86_400_000),
        ),
      );
    }
    if (freshOnly) {
      conditions.push(
        sql`coalesce(${opportunitiesTable.tags}, '') not ilike '%stale%'`,
      );
    }
    if (view !== "all") {
      conditions.push(
        sql`coalesce(${opportunitiesTable.userGrade}, '') <> 'spam'`,
      );
    }

    const prioritizeOpenCandidates = view === "actionable" || view === "all";
    const candidateOrder = prioritizeOpenCandidates
      ? [
          sql`CASE
            WHEN ${opportunitiesTable.responseDeadline} >= date_trunc('day', ${rankingNow}::timestamptz) THEN 0
            WHEN ${opportunitiesTable.responseDeadline} IS NULL THEN 1
            ELSE 2
          END ASC`,
          sql`${opportunitiesTable.relevanceScore} DESC NULLS LAST`,
          sql`${opportunitiesTable.postedDate} DESC NULLS LAST`,
          asc(opportunitiesTable.id),
        ]
      : [
          sql`${opportunitiesTable.relevanceScore} DESC NULLS LAST`,
          sql`${opportunitiesTable.postedDate} DESC NULLS LAST`,
          asc(opportunitiesTable.id),
        ];
    const where = conditions.length ? and(...conditions) : undefined;

    // Scan every matching row in bounded batches with a light projection (description truncated), classify each
    // once, and keep only a compact ranking entry per canonical notice. Full rows are fetched for the returned page
    // only. MAX_SCAN_ROWS is a safety ceiling reported through `truncated`, not a silent recall cap.
    const best = new Map<string, RankedEntry>();
    const scanCeiling = maxScanRows();
    let scanned = 0;
    let truncated = false;
    for (let offset = 0; ; offset += SCAN_BATCH_SIZE) {
      const batch = await db
        .select(rankingScanSelection(opportunitiesTable))
        .from(opportunitiesTable)
        .where(where)
        .orderBy(...candidateOrder)
        .limit(SCAN_BATCH_SIZE)
        .offset(offset);
      scanned += batch.length;
      const eligible = batch.flatMap((row) => {
        const quality = classifyOpportunityQuality(row);
        return qualityMatchesView(quality, view) ? [{ row, quality }] : [];
      });
      const context = await contextualAdjustments(
        eligible.map(({ row }) => row),
        search || undefined,
      );
      for (const { row, quality } of eligible) {
        const contextual = context.get(String(row.id)) ?? { adjustment: 0, contextHash: "" };
        const authority = sourceAuthority(row.providerName ?? row.source);
        const contextualFeedback = Math.max(-5, Math.min(5, contextual.adjustment));
        const rank = Math.max(0, Math.min(100,
          calculateOpportunityRank(row, quality).finalRankScore + contextualFeedback));
        const key = canonicalOpportunityKey(row);
        const provider = String(row.providerName ?? row.source ?? "unknown");
        const existing = best.get(key);
        if (!existing) {
          best.set(key, {
            id: String(row.id), title: String(row.title ?? ""), rank, authority,
            contextualAdjustment: contextual.adjustment, contextualFeedback,
            contextHash: contextual.contextHash, suppressed: row.userGrade === "spam",
            sources: [provider],
          });
          continue;
        }
        if (!existing.sources.includes(provider)) existing.sources.push(provider);
        const canonicalWins = authority.bonus > existing.authority.bonus ||
          (authority.bonus === existing.authority.bonus && rank > existing.rank);
        if (canonicalWins) {
          Object.assign(existing, {
            id: String(row.id), title: String(row.title ?? ""), authority,
            contextualAdjustment: contextual.adjustment, contextualFeedback,
            contextHash: contextual.contextHash, suppressed: row.userGrade === "spam",
          });
        }
        existing.rank = Math.max(existing.rank, rank);
      }
      if (batch.length < SCAN_BATCH_SIZE) break;
      if (scanned >= scanCeiling) {
        const more = await db
          .select({ id: opportunitiesTable.id })
          .from(opportunitiesTable)
          .where(where)
          .orderBy(...candidateOrder)
          .limit(1)
          .offset(scanned);
        truncated = more.length > 0;
        break;
      }
    }

    const sorted = Array.from(best.values()).sort((left, right) => {
      if (right.rank !== left.rank) return right.rank - left.rank;
      return left.title.localeCompare(right.title);
    });
    const total = sorted.length;
    const offset = (page - 1) * limit;
    const pageEntries = sorted.slice(offset, offset + limit);
    const pageRows = pageEntries.length
      ? await db
          .select(opportunityListSelection(opportunitiesTable))
          .from(opportunitiesTable)
          .where(inArray(opportunitiesTable.id, pageEntries.map((entry) => entry.id)))
      : [];
    const rowsById = new Map(pageRows.map((row) => [String(row.id), row]));
    const data = pageEntries.flatMap((entry) => {
      const row = rowsById.get(entry.id);
      if (!row) return [];
      const quality = classifyOpportunityQuality(row);
      const rankBreakdown = calculateOpportunityRank(row, quality);
      return [{
        ...mapOpportunity(row, entry.contextualAdjustment, quality),
        quality,
        crossSource: {
          canonicalKey: canonicalOpportunityKey(row),
          rank: entry.rank,
          rankBreakdown: {
            ...rankBreakdown,
            contextualFeedbackAdjustment: entry.contextualFeedback,
            finalRankScore: entry.rank,
          },
          authority: entry.authority.label,
          contextHash: entry.contextHash,
          suppressed: entry.suppressed,
          sources: entry.sources,
        },
      }];
    });

    return res.json({
      data,
      total,
      page,
      limit,
      view,
      ranking: {
        mode: "best-match-v3",
        candidateStrategy: prioritizeOpenCandidates
          ? "open-then-fit-v1"
          : "fit-then-recency-v1",
        candidateCount: scanned,
        candidateCap: scanCeiling,
        truncated,
        // "exact" when every matching row was ranked; "partial" when the safety ceiling stopped the scan.
        totalBasis: truncated ? "partial" : "exact",
        canonicalCount: total,
        queryContext: search || null,
      },
    });
  } catch (error) {
    req.log.error(error);
    return res.status(500).json({
      error: "Failed to list opportunities",
      details: opportunityListErrorDetail(error),
    });
  }
});

router.post("/opportunities/purge-junk", (_req, res) =>
  res.status(410).json({
    error: "Purge Junk is disabled.",
    reason:
      "The ingestion pipeline retains rejected evidence in staging and never bulk-deletes canonical production records.",
  }),
);

export default router;