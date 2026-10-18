/**
 * Hybrid discovery ranking: PostgreSQL lexical retrieval and vector retrieval fused with Reciprocal Rank Fusion,
 * then a bounded semantic rerank of the fused head only.
 *
 * This module only orders candidates. It never reads or writes a record's relevance decision, quality or score
 * fields: qualification stays in classifyOpportunityQuality / decideRelevance, discovery ranking lives here.
 *
 * Pure (no database or provider imports) so fusion, fallback and tie-breaking are unit-testable. The retrieval legs
 * are injected by the caller (localSearch.ts).
 */

export type RetrievalMethod = "lexical" | "vector";

export const RETRIEVAL_METHODS: readonly RetrievalMethod[] = ["lexical", "vector"];
export const DEFAULT_RRF_K = 60;
export const DEFAULT_RERANK_TOP_N = 20;
/** Same weight semanticRerank.ts gives a similarity of 1.0 on its 0-100 base scale. */
const RERANK_BLEND = 25;
/** RRF sums are compared at this precision so float noise can never decide an order; ties fall to rank, then id. */
const SCORE_EPSILON = 1e-12;

/** One hit from a retrieval method, already in that method's order (best first). */
export interface MethodHit {
  id: string;
  score: number;
}

export interface MethodRetrieval {
  hits: MethodHit[];
  detail?: Record<string, unknown>;
}

/** A retrieval leg failure with a stable code for diagnostics (e.g. vector_index_unavailable). */
export class RetrievalMethodError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RetrievalMethodError";
  }
}

export interface FusedCandidate {
  id: string;
  rrfScore: number;
  /** 1-based position in the fused list, before eligibility filtering or rerank. */
  fusedRank: number;
  /** 1-based rank within each method that found the candidate; a missing key means that method did not. */
  ranks: Partial<Record<RetrievalMethod, number>>;
  scores: Partial<Record<RetrievalMethod, number>>;
  methods: RetrievalMethod[];
}

function bestRank(candidate: Pick<FusedCandidate, "ranks">): number {
  const ranks = Object.values(candidate.ranks).filter((rank): rank is number => typeof rank === "number");
  return ranks.length ? Math.min(...ranks) : Number.POSITIVE_INFINITY;
}

/** Deterministic order: higher score, then better single-method rank, then id (byte order, locale-independent). */
function compareFused(
  left: Pick<FusedCandidate, "id" | "rrfScore" | "ranks">,
  right: Pick<FusedCandidate, "id" | "rrfScore" | "ranks">,
): number {
  const delta = right.rrfScore - left.rrfScore;
  if (Math.abs(delta) > SCORE_EPSILON) return delta;
  const rankDelta = bestRank(left) - bestRank(right);
  if (rankDelta !== 0) return rankDelta;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ 1 / (k + rank_m(d)) over the methods m that returned d.
 * A candidate found by only one method keeps that one contribution, so single-method results are never lost.
 * Duplicate ids inside one list keep their first (best) position.
 */
export function reciprocalRankFusion(
  lists: ReadonlyArray<{ method: RetrievalMethod; hits: readonly MethodHit[] }>,
  k: number = DEFAULT_RRF_K,
): FusedCandidate[] {
  const safeK = Number.isFinite(k) && k > 0 ? k : DEFAULT_RRF_K;
  const byId = new Map<string, Omit<FusedCandidate, "fusedRank">>();

  for (const list of lists) {
    let rank = 0;
    const seen = new Set<string>();
    for (const hit of list.hits) {
      if (!hit.id || seen.has(hit.id)) continue;
      seen.add(hit.id);
      rank++;
      const entry = byId.get(hit.id) ?? { id: hit.id, rrfScore: 0, ranks: {}, scores: {}, methods: [] };
      entry.rrfScore += 1 / (safeK + rank);
      entry.ranks[list.method] = rank;
      entry.scores[list.method] = hit.score;
      entry.methods.push(list.method);
      byId.set(hit.id, entry);
    }
  }

  return [...byId.values()]
    .sort(compareFused)
    .map((entry, index) => ({ ...entry, fusedRank: index + 1 }));
}

export type MethodStatus = "ok" | "failed" | "disabled";

export interface MethodDiagnostics {
  status: MethodStatus;
  candidates: number;
  ms: number;
  code?: string;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface RetrievalFailure {
  method: RetrievalMethod | "rerank";
  code: string;
  message: string;
}

export type HybridMode = "hybrid" | "lexical_only" | "vector_only" | "failed";

export interface HybridRetrievalResult {
  mode: HybridMode;
  k: number;
  fused: FusedCandidate[];
  methods: Record<RetrievalMethod, MethodDiagnostics>;
  /** Each method's own list in its own order, so the original candidates stay recoverable. */
  lists: Record<RetrievalMethod, Array<MethodHit & { rank: number }>>;
  failures: RetrievalFailure[];
}

/** A leg is a function, or null when it is turned off by configuration (reported as disabled, not as a failure). */
export type RetrievalLeg = (() => Promise<MethodRetrieval>) | null;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, method: RetrievalMethod): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RetrievalMethodError(`${method}_timeout`, `${method} retrieval exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runLeg(
  method: RetrievalMethod,
  leg: RetrievalLeg,
  timeoutMs: number | undefined,
): Promise<{ diagnostics: MethodDiagnostics; hits: MethodHit[]; failure?: RetrievalFailure }> {
  if (!leg) return { diagnostics: { status: "disabled", candidates: 0, ms: 0 }, hits: [] };
  const started = performance.now();
  try {
    const result = await withTimeout(leg(), timeoutMs, method);
    return {
      diagnostics: {
        status: "ok",
        candidates: result.hits.length,
        ms: Math.round(performance.now() - started),
        ...(result.detail ? { detail: result.detail } : {}),
      },
      hits: result.hits,
    };
  } catch (error) {
    const code = error instanceof RetrievalMethodError ? error.code : `${method}_failed`;
    const message = error instanceof Error ? error.message : String(error);
    const detail = error instanceof RetrievalMethodError ? error.detail : undefined;
    return {
      diagnostics: {
        status: "failed",
        candidates: 0,
        ms: Math.round(performance.now() - started),
        code,
        error: message,
        ...(detail ? { detail } : {}),
      },
      hits: [],
      failure: { method, code, message },
    };
  }
}

/**
 * Run both legs in parallel and fuse what succeeded. One failed leg degrades to the other (lexical_only /
 * vector_only) with the failure recorded; mode is "failed" only when no leg produced a result.
 */
export async function runHybridRetrieval(
  legs: Record<RetrievalMethod, RetrievalLeg>,
  options: { k?: number; timeoutMs?: Partial<Record<RetrievalMethod, number>> } = {},
): Promise<HybridRetrievalResult> {
  const k = options.k ?? DEFAULT_RRF_K;
  const [lexical, vector] = await Promise.all(
    RETRIEVAL_METHODS.map((method) => runLeg(method, legs[method], options.timeoutMs?.[method])),
  );
  const outcomes = { lexical: lexical!, vector: vector! };
  const ok = RETRIEVAL_METHODS.filter((method) => outcomes[method].diagnostics.status === "ok");
  const mode: HybridMode =
    ok.length === 2 ? "hybrid" : ok[0] === "lexical" ? "lexical_only" : ok[0] === "vector" ? "vector_only" : "failed";

  const lists = {} as HybridRetrievalResult["lists"];
  for (const method of RETRIEVAL_METHODS) {
    lists[method] = outcomes[method].hits.map((hit, index) => ({ ...hit, rank: index + 1 }));
  }

  return {
    mode,
    k,
    fused: reciprocalRankFusion(ok.map((method) => ({ method, hits: outcomes[method].hits })), k),
    methods: { lexical: outcomes.lexical.diagnostics, vector: outcomes.vector.diagnostics },
    lists,
    failures: RETRIEVAL_METHODS.flatMap((method) => (outcomes[method].failure ? [outcomes[method].failure!] : [])),
  };
}

export interface RerankDiagnostics {
  enabled: boolean;
  applied: boolean;
  topN: number;
  /** Items handed to the reranker: min(topN, eligible). Everything below stays in fused order. */
  considered: number;
  /** Items the reranker actually scored. */
  reranked: number;
  ms: number;
  code?: string;
  error?: string;
}

/** Similarity in [0, 1] by id; ids missing from the map (or a null result) keep their fused position. */
export type RerankScorer<T> = (head: T[]) => Promise<Map<string, number> | null>;

/**
 * Rerank only the fused top-N. The head is reordered by a 0-100 normalized RRF score plus similarity × 25 (the
 * semanticRerank.ts blend); ties keep fused order. The tail is untouched. Reranker failure is non-fatal.
 */
export async function selectiveRerank<T extends { id: string; rrfScore: number; fusedRank: number }>(
  items: T[],
  topN: number,
  scorer: RerankScorer<T> | null,
): Promise<{
  items: Array<T & { rerankSimilarity: number | null }>;
  diagnostics: RerankDiagnostics;
  failure?: RetrievalFailure;
}> {
  const safeTopN = Math.max(0, Math.floor(topN));
  const head = items.slice(0, safeTopN);
  const tail = items.slice(safeTopN);
  const unchanged = () => items.map((item) => ({ ...item, rerankSimilarity: null }));
  const base = { enabled: Boolean(scorer), applied: false, topN: safeTopN, considered: 0, reranked: 0, ms: 0 };
  if (!scorer || head.length < 2) return { items: unchanged(), diagnostics: base };

  const started = performance.now();
  let scores: Map<string, number> | null;
  try {
    scores = await scorer(head);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      items: unchanged(),
      diagnostics: { ...base, considered: head.length, ms: Math.round(performance.now() - started), code: "rerank_failed", error: message },
      failure: { method: "rerank", code: "rerank_failed", message },
    };
  }
  const ms = Math.round(performance.now() - started);
  if (!scores || scores.size === 0) {
    return { items: unchanged(), diagnostics: { ...base, considered: head.length, ms } };
  }

  const maxRrf = Math.max(...head.map((item) => item.rrfScore), SCORE_EPSILON);
  const rescored = head.map((item) => {
    const raw = scores!.get(item.id);
    const similarity = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : null;
    return { item: { ...item, rerankSimilarity: similarity }, combined: (100 * item.rrfScore) / maxRrf + (similarity ?? 0) * RERANK_BLEND };
  });
  rescored.sort((left, right) => {
    const delta = right.combined - left.combined;
    if (Math.abs(delta) > SCORE_EPSILON) return delta;
    return left.item.fusedRank - right.item.fusedRank;
  });

  return {
    items: [...rescored.map((row) => row.item), ...tail.map((item) => ({ ...item, rerankSimilarity: null }))],
    diagnostics: {
      ...base,
      applied: true,
      considered: head.length,
      reranked: rescored.filter((row) => row.item.rerankSimilarity !== null).length,
      ms,
    },
  };
}
