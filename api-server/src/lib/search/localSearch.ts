/**
 * Local (fast) search over already-stored opportunity records.
 *
 * This is the **instant search path** over the PostgreSQL opportunities table. It is a hybrid of two retrieval
 * methods fused with Reciprocal Rank Fusion (hybridFusion.ts):
 *   - lexical: PostgreSQL full-text search (ts_rank_cd over a weighted tsvector) unioned with the original
 *     all-terms ILIKE match, so exact codes and substrings are still found;
 *   - vector: the existing Qdrant/Pinecone opportunity index (vectorIndex.ts), when one is configured.
 * Only the fused top-N is semantically reranked. No crawlers or extraction LLMs are called, and a missing vector
 * store or reranker degrades to lexical order with the failure reported in `diagnostics`.
 *
 * Ranking only orders results: matchScore, quality and summary eligibility are computed per record exactly as
 * before and are never changed by fusion or rerank. Per-method ranks are reported on every result.
 *
 * Contrast with:
 *   - /opportunities/fetch — ingestion/crawler path that hits live sources
 *   - unifiedFetch / webIntelligenceFetch — crawler/scraper pipelines
 */

import { rfpDb as db } from "@workspace/db";
import { opportunitiesTable } from "@workspace/db/schema";
import { eq, ilike, or, and, gte, gt, inArray, sql, desc, asc, getTableColumns, type SQL } from "drizzle-orm";
import type { Opportunity } from "@workspace/db/schema";
import { classifyOpportunityQuality, plainSummaryIneligibilityReason, summaryIneligibilityReason, type OpportunityQualityView, type SummaryIneligibilityReason } from "../opportunityQuality";
import { meaningfulLocalSearchTerms } from "./localSearchPolicy";
import { matchedServiceLines } from "./profileServiceLines";
import { getRelevanceProfile } from "./relevanceProfile";
import { envFlag } from "../config/env";
import {
  DEFAULT_RERANK_TOP_N,
  DEFAULT_RRF_K,
  runHybridRetrieval,
  selectiveRerank,
  type FusedCandidate,
  type HybridMode,
  type MethodDiagnostics,
  type MethodHit,
  type RerankDiagnostics,
  type RetrievalFailure,
  type RetrievalMethod,
} from "./hybridFusion";
import { searchVectorIndex } from "./vectorIndex";
import { isSemanticRerankEnabled, semanticRerank } from "./semanticRerank";

export { meaningfulLocalSearchTerms } from "./localSearchPolicy";

export interface SearchFilters {
  source?: string;
  agency?: string;
  state?: string;
  dateRange?: number;
  activeOnly?: boolean;
  includeNonActionable?: boolean;
}

/** Discovery-ranking evidence for one result. Separate from matchScore/quality, which ranking never changes. */
export interface SearchRanking {
  methods: RetrievalMethod[];
  lexicalRank: number | null;
  lexicalScore: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  rrfScore: number;
  /** Position in the fused list before eligibility filtering and rerank. */
  fusedRank: number;
  rerankSimilarity: number | null;
  /** Position in the final ordered result list (1-based). */
  finalRank: number;
}

export interface SearchResult {
  id: string;
  title: string;
  agency: string;
  subAgency: string | null;
  description: string | null;
  source: string;
  providerName: string | null;
  sourceUrl: string | null;
  postedDate: Date;
  responseDeadline: Date | null;
  naicsCode: string | null;
  placeOfPerformance: string | null;
  status: "active" | "archived";
  matchScore: number;
  matchReasons: string[];
  quality: OpportunityQualityView;
  summaryEligible: boolean;
  summaryIneligibilityReasonCode: SummaryIneligibilityReason | null;
  summaryIneligibilityReason: string | null;
  ranking: SearchRanking;
}

export interface SearchOptions {
  /** RRF constant; defaults to HYBRID_RRF_K or 60. */
  rrfK?: number;
  /** How many fused results are semantically reranked; defaults to HYBRID_RERANK_TOP_N or 20. 0 disables. */
  rerankTopN?: number;
}

export interface SearchDiagnostics {
  mode: HybridMode;
  fusion: { method: "rrf"; k: number };
  methods: Record<RetrievalMethod, MethodDiagnostics>;
  candidates: {
    lexical: number;
    vector: number;
    /** Found by both methods. */
    overlap: number;
    lexicalOnly: number;
    vectorOnly: number;
    fused: number;
    /** Fused ids with no stored row passing the request filters (e.g. a vector hit for an expired notice). */
    filteredOut: number;
    /** Hard actionability exclusions (closed, expired), the same rule the lexical path always applied. */
    ineligible: number;
    eligible: number;
    returned: number;
  };
  /** Share of the fused list each method found (null when nothing was fused). */
  coverage: { lexical: number | null; vector: number | null; both: number | null };
  rerank: RerankDiagnostics;
  failures: RetrievalFailure[];
  /** Each method's original list, in its own order, so the pre-fusion candidates are recoverable. */
  candidateLists: Record<RetrievalMethod, Array<MethodHit & { rank: number }>>;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  timing: {
    dbMs: number;
    totalMs: number;
  };
  diagnostics: SearchDiagnostics;
}

const LEXICAL_CANDIDATE_LIMIT = 500;
const VECTOR_CANDIDATE_LIMIT = 100;
const VECTOR_TIMEOUT_MS = 8_000;

function boundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function dateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
}

function money(value: unknown): string | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n}`;
}

function providerLabel(opp: Opportunity): string {
  const raw = opp.providerName || opp.source || "manual";
  const labels: Record<string, string> = {
    samGov: "SAM.gov",
    sam_gov: "SAM.gov",
    grantsGov: "Grants.gov",
    usaSpending: "USASpending",
    statePortals: "State Portals",
    serper: "Serper",
    tavily: "Tavily",
    exa: "Exa",
    firecrawl: "Firecrawl",
    jina: "Jina",
    olostep: "Olostep",
    browseAi: "Browse AI",
    you: "You.com",
    langsearch: "Langsearch",
    websearch: "WebSearch",
    tango: "Tango",
    bidnet: "BidNet",
    csv_import: "CSV Import",
    manual: "Manual",
  };
  return labels[raw] ?? raw;
}

function compact(value: unknown, max = 170): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function serviceLines(opp: Opportunity): string[] {
  // Service lines are the profile categories the record's text evidences; none are defined here.
  return matchedServiceLines(`${opp.title} ${opp.description ?? ""} ${opp.notes ?? ""} ${opp.naicsDescription ?? ""}`, { max: 3 });
}

function cardReasons(opp: Opportunity, score: number, keywordReasons: string[]): string[] {
  const lines = serviceLines(opp);
  const due = dateOnly(opp.responseDeadline);
  const posted = dateOnly(opp.postedDate);
  const value = money(opp.estimatedValue ?? opp.awardAmount ?? opp.ceilingValue ?? opp.floorValue);
  const buyer = opp.agency && opp.agency !== "Unknown" ? opp.agency : "Unknown buyer";
  const source = providerLabel(opp);
  const hasUrl = Boolean(opp.samUrl);
  const confidence = opp.sourceConfidence || (score >= getRelevanceProfile().thresholds.acceptMin && lines.length ? "high" : lines.length ? "medium" : "low");
  const decision = lines.length >= 2
    ? "Strong review candidate"
    : lines.length === 1
      ? "Possible fit — verify source"
      : "Needs source check before spending time";
  const missing = [
    !due ? "deadline" : null,
    !value ? "value" : null,
    buyer === "Unknown buyer" ? "buyer" : null,
    !opp.placeOfPerformance ? "location" : null,
    !hasUrl ? "source link" : null,
    lines.length === 0 ? "specific Occu-Med scope" : null,
  ].filter(Boolean).join(", ");

  return Array.from(new Set([
    `Decision: ${decision} (${confidence} confidence).`,
    lines.length ? `Scope: ${lines.join(", ")}.` : `Scope unclear from saved text${compact(opp.description) ? `: ${compact(opp.description)}` : "."}`,
    `Source: ${source}${hasUrl ? " with link" : " without link"}; ${posted ? `posted ${posted}` : "posted date missing"}; ${due ? `due ${due}` : "deadline missing"}.`,
    `Buyer/data: ${buyer}${opp.placeOfPerformance ? ` · ${opp.placeOfPerformance}` : ""}${value ? ` · ${value}` : " · value missing"}.`,
    missing ? `Missing before bid/no-bid: ${missing}.` : "Enough saved data for first-pass review; verify source before action.",
    ...keywordReasons,
  ])).slice(0, 7);
}

function buildMatchReasons(opp: Opportunity, terms: string[], query: string): { reasons: string[]; score: number } {
  const reasons: string[] = [];
  let score = 0;
  const textFields = [opp.title, opp.description, opp.agency, opp.subAgency, opp.solicitationNumber, opp.naicsCode, opp.naicsDescription, opp.placeOfPerformance].filter(Boolean) as string[];
  const normFields = textFields.map((f) => ` ${f.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `);
  const normTerms = terms.map((t) => t.toLowerCase());
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedTitle = opp.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedDescription = (opp.description ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  if (normalizedQuery.length >= 4 && normalizedTitle.includes(normalizedQuery)) {
    reasons.push("Full search phrase appears in title");
    score += 35;
  } else if (normalizedQuery.length >= 4 && normalizedDescription.includes(normalizedQuery)) {
    reasons.push("Full search phrase appears in saved source description");
    score += 20;
  }

  for (const term of normTerms) {
    const titleNorm = ` ${opp.title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    if (titleNorm.includes(` ${term} `)) { reasons.push("Query appears directly in title"); score += 40; continue; }
    if (opp.title.toLowerCase().includes(term)) { reasons.push("Query appears in title"); score += 30; continue; }
    if (opp.description?.toLowerCase().includes(term)) { reasons.push("Query appears in saved source description"); score += 20; continue; }
    if (opp.agency.toLowerCase().includes(term) || opp.subAgency?.toLowerCase().includes(term)) { reasons.push("Query matches buyer/agency"); score += 15; continue; }
    if (opp.solicitationNumber?.toLowerCase().includes(term) || opp.naicsCode?.toLowerCase().includes(term) || opp.naicsDescription?.toLowerCase().includes(term) || opp.placeOfPerformance?.toLowerCase().includes(term)) { reasons.push("Query matches solicitation metadata"); score += 10; continue; }
    if (normFields.some((f) => f.includes(` ${term} `))) { reasons.push("Query appears in searchable record text"); score += 5; }
  }

  return { reasons: Array.from(new Set(reasons)), score: Math.min(100, score) };
}

function rankAdjust(opp: Opportunity, baseScore: number, quality: OpportunityQualityView): number {
  const now = new Date();
  let freshness = 0;
  if (opp.responseDeadline && opp.responseDeadline > now) {
    const daysUntil = Math.ceil((opp.responseDeadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    freshness += daysUntil <= 30 ? 5 : daysUntil <= 90 ? 3 : 1;
  }
  const daysSincePosted = Math.ceil((now.getTime() - opp.postedDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysSincePosted <= 7) freshness += 3;
  else if (daysSincePosted <= 30) freshness += 2;
  const officialSource = opp.source === "sam_gov" || opp.providerName === "samGov" ? 3 : 0;
  const score = baseScore * 0.52 + quality.relevanceScore * 0.4 + freshness + officialSource;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function filterConditions(filters: SearchFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.source) conditions.push(or(ilike(opportunitiesTable.source, `%${escapeLike(filters.source.toLowerCase())}%`), ilike(opportunitiesTable.providerName, `%${escapeLike(filters.source.toLowerCase())}%`))!);
  if (filters.agency) conditions.push(ilike(opportunitiesTable.agency, `%${escapeLike(filters.agency)}%`));
  if (filters.state) conditions.push(ilike(opportunitiesTable.placeOfPerformance, `%${escapeLike(filters.state)}%`));
  if (filters.dateRange && filters.dateRange > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - filters.dateRange);
    conditions.push(gte(opportunitiesTable.postedDate, cutoff));
  }
  if (!filters.includeNonActionable) {
    conditions.push(eq(opportunitiesTable.status, "active"));
    conditions.push(gt(opportunitiesTable.responseDeadline, new Date()));
  } else if (filters.activeOnly) {
    conditions.push(eq(opportunitiesTable.status, "active"));
  }
  return conditions;
}

/** The original lexical rule: every meaningful term appears in some searchable field (substring match). */
function allTermsLikeCondition(terms: string[]): SQL | undefined {
  if (terms.length === 0) return undefined;
  return and(...terms.map((term) => {
    const pattern = `%${escapeLike(term)}%`;
    return or(
      ilike(opportunitiesTable.title, pattern),
      ilike(opportunitiesTable.description, pattern),
      ilike(opportunitiesTable.agency, pattern),
      ilike(opportunitiesTable.subAgency, pattern),
      ilike(opportunitiesTable.solicitationNumber, pattern),
      ilike(opportunitiesTable.naicsCode, pattern),
      ilike(opportunitiesTable.naicsDescription, pattern),
      ilike(opportunitiesTable.placeOfPerformance, pattern),
    );
  }));
}

/** Weighted document: title A, description B, buyer and solicitation metadata C. Computed on the fly (no column). */
const searchDocument = sql`(
  setweight(to_tsvector('english', coalesce(${opportunitiesTable.title}, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(${opportunitiesTable.description}, '')), 'B') ||
  setweight(to_tsvector('english', concat_ws(' ', ${opportunitiesTable.agency}, ${opportunitiesTable.subAgency}, ${opportunitiesTable.solicitationNumber}, ${opportunitiesTable.naicsCode}, ${opportunitiesTable.naicsDescription}, ${opportunitiesTable.placeOfPerformance})), 'C')
)`;

/**
 * Any-term prefix query ("exam:* | firefighter:*"). Terms are already [a-z0-9]+ (meaningfulLocalSearchTerms), and
 * anything else is dropped here, so no tsquery syntax can be injected. ts_rank_cd rewards records that match more
 * terms closer together; records matching only some terms are kept for fusion rather than excluded.
 */
export function lexicalTsQueryText(terms: string[]): string {
  return terms.filter((term) => /^[a-z0-9]+$/.test(term)).map((term) => `${term}:*`).join(" | ");
}

interface LexicalRow {
  opp: Opportunity;
  tsRank: number;
  keywordScore: number;
}

async function lexicalCandidates(terms: string[], query: string, filters: SearchFilters): Promise<LexicalRow[]> {
  const tsQueryText = lexicalTsQueryText(terms);
  const tsQuery = tsQueryText ? sql`to_tsquery('english', ${tsQueryText})` : null;
  const rank = tsQuery
    ? sql<number>`ts_rank_cd(${searchDocument}, ${tsQuery})`.mapWith(Number)
    : sql<number>`0`.mapWith(Number);
  const like = allTermsLikeCondition(terms);
  const match = tsQuery ? or(sql`${searchDocument} @@ ${tsQuery}`, like) : like;
  const conditions = [...filterConditions(filters), ...(match ? [match] : [])];

  const rows = await db
    .select({ ...getTableColumns(opportunitiesTable), lexicalRank: rank })
    .from(opportunitiesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(rank), asc(opportunitiesTable.id))
    .limit(LEXICAL_CANDIDATE_LIMIT);

  return rows
    .map(({ lexicalRank, ...opp }: Opportunity & { lexicalRank: number }) => ({
      opp: opp as Opportunity,
      tsRank: Number.isFinite(lexicalRank) ? lexicalRank : 0,
      keywordScore: buildMatchReasons(opp as Opportunity, terms, query).score,
    }))
    // Full-text rank first; the existing keyword score breaks FTS ties; id makes the order reproducible.
    .sort((a: LexicalRow, b: LexicalRow) =>
      b.tsRank - a.tsRank || b.keywordScore - a.keywordScore || (a.opp.id < b.opp.id ? -1 : a.opp.id > b.opp.id ? 1 : 0));
}

function toSearchResult(opp: Opportunity, terms: string[], query: string, quality: OpportunityQualityView, ranking: SearchRanking): SearchResult {
  const { reasons, score } = buildMatchReasons(opp, terms, query);
  const finalScore = rankAdjust(opp, score, quality);
  const reasonCode = summaryIneligibilityReason(quality, quality.summaryEligible);
  return {
    id: opp.id,
    title: opp.title,
    agency: opp.agency,
    subAgency: opp.subAgency,
    description: opp.description,
    source: opp.providerName || opp.source,
    providerName: opp.providerName,
    sourceUrl: opp.samUrl,
    postedDate: opp.postedDate,
    responseDeadline: opp.responseDeadline,
    naicsCode: opp.naicsCode,
    placeOfPerformance: opp.placeOfPerformance,
    status: opp.status,
    matchScore: finalScore,
    matchReasons: cardReasons(opp, finalScore, reasons),
    quality,
    summaryEligible: quality.summaryEligible,
    summaryIneligibilityReasonCode: reasonCode,
    summaryIneligibilityReason: reasonCode ? plainSummaryIneligibilityReason(reasonCode) : null,
    ranking,
  };
}

function rankingFor(candidate: FusedCandidate): SearchRanking {
  return {
    methods: candidate.methods,
    lexicalRank: candidate.ranks.lexical ?? null,
    lexicalScore: candidate.scores.lexical ?? null,
    vectorRank: candidate.ranks.vector ?? null,
    vectorScore: candidate.scores.vector ?? null,
    rrfScore: round(candidate.rrfScore),
    fusedRank: candidate.fusedRank,
    rerankSimilarity: null,
    finalRank: 0,
  };
}

function rerankText(result: SearchResult): string {
  return [result.title, result.agency, result.naicsCode, result.placeOfPerformance, result.description]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4_000);
}

export async function searchOpportunities(
  query: string,
  limit = 50,
  filters: SearchFilters = {},
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const totalStart = performance.now();
  const terms = meaningfulLocalSearchTerms(query);
  const k = options.rrfK ?? boundedIntegerEnv("HYBRID_RRF_K", DEFAULT_RRF_K, 1, 1_000);
  const rerankTopN = options.rerankTopN ?? boundedIntegerEnv("HYBRID_RERANK_TOP_N", DEFAULT_RERANK_TOP_N, 0, 100);
  const rowsById = new Map<string, Opportunity>();
  let dbMs = 0;

  const retrieval = await runHybridRetrieval(
    {
      lexical: async () => {
        const started = performance.now();
        const rows = await lexicalCandidates(terms, query, filters);
        dbMs += performance.now() - started;
        for (const row of rows) rowsById.set(row.opp.id, row.opp);
        return {
          hits: rows.map((row) => ({ id: row.opp.id, score: round(row.tsRank) })),
          detail: { engine: "postgres_fts+ilike", tsQuery: lexicalTsQueryText(terms) || null },
        };
      },
      vector: envFlag("ENABLE_HYBRID_VECTOR_SEARCH", true)
        ? () => searchVectorIndex(query, VECTOR_CANDIDATE_LIMIT)
        : null,
    },
    { k, timeoutMs: { vector: VECTOR_TIMEOUT_MS } },
  );
  if (retrieval.mode === "failed") {
    throw new Error(retrieval.failures.map((failure) => `${failure.method}: ${failure.message}`).join("; ") || "No retrieval method ran");
  }

  // Vector-only hits are loaded under the same request filters; a hit that fails them is counted, not shown.
  const missing = retrieval.fused.map((candidate) => candidate.id).filter((id) => !rowsById.has(id));
  if (missing.length > 0) {
    const started = performance.now();
    const rows: Opportunity[] = await db
      .select()
      .from(opportunitiesTable)
      .where(and(inArray(opportunitiesTable.id, missing), ...filterConditions(filters)));
    dbMs += performance.now() - started;
    for (const row of rows) rowsById.set(row.id, row);
  }

  let filteredOut = 0;
  let ineligible = 0;
  const eligible: Array<SearchResult & { rrfScore: number; fusedRank: number }> = [];
  for (const candidate of retrieval.fused) {
    const opp = rowsById.get(candidate.id);
    if (!opp) { filteredOut++; continue; }
    const quality = classifyOpportunityQuality(opp);
    if (!filters.includeNonActionable && !quality.actionable) { ineligible++; continue; }
    eligible.push({
      ...toSearchResult(opp, terms, query, quality, rankingFor(candidate)),
      rrfScore: candidate.rrfScore,
      fusedRank: candidate.fusedRank,
    });
  }

  // Selective rerank: only the fused head is sent to semanticRerank; the rest keeps fused order.
  const reranked = await selectiveRerank(
    eligible,
    rerankTopN,
    isSemanticRerankEnabled()
      ? async (head) => {
          const scored = await semanticRerank(
            head.map((item) => ({ item, baseScore: 0, text: rerankText(item) })),
            head.length,
            query,
          );
          return new Map(scored.flatMap((row) => (row.similarity == null ? [] : [[row.item.id, row.similarity] as const])));
        }
      : null,
  );

  const ranked: SearchResult[] = reranked.items.map(({ rrfScore: _rrf, fusedRank: _fused, rerankSimilarity, ...result }, index) => ({
    ...result,
    ranking: {
      ...result.ranking,
      rerankSimilarity: rerankSimilarity == null ? null : round(rerankSimilarity, 4),
      finalRank: index + 1,
    },
  }));
  const results = ranked.slice(0, limit);

  const fused = retrieval.fused.length;
  const overlap = retrieval.fused.filter((candidate) => candidate.methods.length > 1).length;
  const lexicalOnly = retrieval.fused.filter((candidate) => candidate.methods.length === 1 && candidate.methods[0] === "lexical").length;
  const vectorOnly = retrieval.fused.filter((candidate) => candidate.methods.length === 1 && candidate.methods[0] === "vector").length;
  const share = (count: number) => (fused > 0 ? round(count / fused, 4) : null);

  return {
    results,
    total: ranked.length,
    timing: { dbMs: Math.round(dbMs), totalMs: Math.round(performance.now() - totalStart) },
    diagnostics: {
      mode: retrieval.mode,
      fusion: { method: "rrf", k: retrieval.k },
      methods: retrieval.methods,
      candidates: {
        lexical: retrieval.methods.lexical.candidates,
        vector: retrieval.methods.vector.candidates,
        overlap,
        lexicalOnly,
        vectorOnly,
        fused,
        filteredOut,
        ineligible,
        eligible: eligible.length,
        returned: results.length,
      },
      coverage: { lexical: share(lexicalOnly + overlap), vector: share(vectorOnly + overlap), both: share(overlap) },
      rerank: reranked.diagnostics,
      failures: [...retrieval.failures, ...(reranked.failure ? [reranked.failure] : [])],
      candidateLists: retrieval.lists,
    },
  };
}
