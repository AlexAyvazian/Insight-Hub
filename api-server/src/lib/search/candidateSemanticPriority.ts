import { cloudflareWorkersAi } from "../providers/cloudflareWorkersAi";
import { occumedSemanticProfile } from "./semanticRerank";

const EMBEDDING_BATCH_SIZE = 48;
const DIRECT_RERANK_LIMIT = 80;
const MAX_SAME_SOURCE_STREAK = 4;
const FAIRNESS_SCORE_WINDOW = 0.08;
const DUPLICATE_COSINE_THRESHOLD = 0.965;
const DUPLICATE_TITLE_JACCARD = 0.82;
/** Below this much content a candidate's embedding mostly reflects its title; it is flagged, never dropped for it. */
export const THIN_CANDIDATE_CHARS = 160;

export interface SemanticPriorityCandidate {
  title: string;
  url: string;
  content: string;
  sourceProvider: string;
}

export type PrioritizedCandidate<T extends SemanticPriorityCandidate> = T & {
  cloudflareSemanticScore: number;
  cloudflareSemanticRank: number;
  /** Set when the candidate's snippet is too thin for its semantic score to mean much; it stays in the list. */
  semanticPriorityDeferred?: "thin_snippet";
};

export interface CandidateSemanticPriorityResult<T extends SemanticPriorityCandidate> {
  candidates: PrioritizedCandidate<T>[];
  overflow: PrioritizedCandidate<T>[];
  applied: boolean;
  embedded: number;
  directReranked: number;
  duplicatesRemoved: number;
  /** Near-identical candidates kept because no shared identifier proved them the same procurement. */
  potentialDuplicates?: number;
  /** Thin-snippet candidates kept and flagged with semanticPriorityDeferred (in candidates or overflow). */
  deferred: number;
  errors: string[];
}

interface ScoredCandidate<T extends SemanticPriorityCandidate> {
  candidate: T;
  vector: number[];
  embeddingScore: number;
  rerankScore?: number;
  finalScore: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < length; index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    aNorm += left * left;
    bNorm += right * right;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

export function titleTokenJaccard(left: string, right: string): number {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size < 3 || b.size < 3) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function candidateText(candidate: SemanticPriorityCandidate): string {
  return [candidate.title, candidate.content, candidate.url]
    .filter(Boolean)
    .join(". ")
    .slice(0, 12_000);
}

export function isThinCandidate(candidate: SemanticPriorityCandidate): boolean {
  return candidate.content.replace(/\s+/g, " ").trim().length < THIN_CANDIDATE_CHARS;
}

function withPriority<T extends SemanticPriorityCandidate>(
  candidate: T,
  score: number,
  rank: number,
): PrioritizedCandidate<T> {
  return {
    ...candidate,
    cloudflareSemanticScore: score,
    cloudflareSemanticRank: rank,
    ...(isThinCandidate(candidate) ? { semanticPriorityDeferred: "thin_snippet" as const } : {}),
  };
}

/** Every candidate in its original order, unscored. Used whenever semantic prioritization cannot run. */
function unprioritized<T extends SemanticPriorityCandidate>(
  candidates: T[],
  error?: string,
): CandidateSemanticPriorityResult<T> {
  const kept = candidates.map((candidate, index) => withPriority(candidate, 0, index + 1));
  return {
    candidates: kept,
    overflow: [],
    applied: false,
    embedded: 0,
    directReranked: 0,
    duplicatesRemoved: 0,
    deferred: kept.filter((candidate) => candidate.semanticPriorityDeferred).length,
    errors: error ? [error] : [],
  };
}

function semanticQuery(focus?: string): string {
  const normalized = focus?.trim();
  return normalized
    ? `${occumedSemanticProfile()} Current search focus: ${normalized}. Rank currently open procurement evidence above generic mentions.`
    : `${occumedSemanticProfile()} Rank currently open procurement evidence above generic mentions.`;
}

const IDENTIFIER_LABEL =
  /\b(?:solicitation|notice|rfp|rfq|rfi|ifb|itb|bid|tender|contract|reference|ref)\s*(?:no\.?|number|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9._/-]{4,40})/gi;

/** Solicitation-style identifiers stated in a candidate's text or URL, upper-cased. */
export function procurementIdentifiers(candidate: SemanticPriorityCandidate): Set<string> {
  const ids = new Set<string>();
  for (const match of `${candidate.title} ${candidate.content.slice(0, 6_000)}`.matchAll(IDENTIFIER_LABEL)) {
    const id = match[1]!.replace(/[.,;:]+$/, "").toUpperCase();
    if (/\d/.test(id)) ids.add(id);
  }
  return ids;
}

/**
 * Near-identical text is a signal, not proof, that two candidates are the same procurement: agencies reuse
 * titles and templates across separate solicitations. A candidate is removed only when it also shares a stated
 * solicitation identifier with the kept one (or is the same URL). Similar candidates without shared identity are
 * kept as potential matches for the identity step after extraction.
 */
function deduplicateBySemanticEvidence<T extends SemanticPriorityCandidate>(
  ranked: ScoredCandidate<T>[],
): { kept: ScoredCandidate<T>[]; removed: number; potentialMatches: number } {
  const kept: ScoredCandidate<T>[] = [];
  const keptIds: Set<string>[] = [];
  let removed = 0;
  let potentialMatches = 0;

  for (const row of ranked) {
    const ids = procurementIdentifiers(row.candidate);
    let similar = false;
    const duplicate = kept.some((existing, index) => {
      if (existing.candidate.url === row.candidate.url) return true;
      if (
        titleTokenJaccard(row.candidate.title, existing.candidate.title) <
          DUPLICATE_TITLE_JACCARD ||
        cosineSimilarity(row.vector, existing.vector) < DUPLICATE_COSINE_THRESHOLD
      ) {
        return false;
      }
      similar = true;
      return [...ids].some((id) => keptIds[index]!.has(id));
    });
    if (duplicate) {
      removed++;
      continue;
    }
    if (similar) potentialMatches++;
    kept.push(row);
    keptIds.push(ids);
  }

  return { kept, removed, potentialMatches };
}

/**
 * Preserve semantic quality while preventing a single search backend from
 * occupying long consecutive stretches of the candidate budget. An alternate
 * source is used only when its score is close to the current best score.
 */
export function applySourceFairness<T extends SemanticPriorityCandidate>(
  ranked: Array<{ candidate: T; finalScore: number }>,
): Array<{ candidate: T; finalScore: number }> {
  const remaining = [...ranked];
  const ordered: Array<{ candidate: T; finalScore: number }> = [];
  let lastSource = "";
  let streak = 0;

  while (remaining.length > 0) {
    let selectedIndex = 0;
    const best = remaining[0]!;
    if (
      lastSource === best.candidate.sourceProvider &&
      streak >= MAX_SAME_SOURCE_STREAK
    ) {
      const alternate = remaining.findIndex(
        (row) =>
          row.candidate.sourceProvider !== lastSource &&
          best.finalScore - row.finalScore <= FAIRNESS_SCORE_WINDOW,
      );
      if (alternate > 0) selectedIndex = alternate;
    }

    const selected = remaining.splice(selectedIndex, 1)[0]!;
    ordered.push(selected);
    if (selected.candidate.sourceProvider === lastSource) {
      streak++;
    } else {
      lastSource = selected.candidate.sourceProvider;
      streak = 1;
    }
  }

  return ordered;
}

export function finalizeSemanticPriority<T extends SemanticPriorityCandidate>(
  candidates: T[],
  vectors: number[][],
  queryVector: number[],
  rerankScores: Map<number, number> = new Map(),
  maxCandidates = 240,
): CandidateSemanticPriorityResult<T> {
  // An embedding failure is not a reason to lose candidates: keep all of them in their original order.
  if (vectors.length !== candidates.length) {
    return unprioritized(candidates, "Cloudflare embedding count did not match candidate count.");
  }

  const scored = candidates.map((candidate, index) => {
    const embeddingScore = clamp01(cosineSimilarity(queryVector, vectors[index]!));
    const rerankScore = rerankScores.get(index);
    const finalScore =
      rerankScore == null
        ? embeddingScore
        : clamp01(embeddingScore * 0.35 + clamp01(rerankScore) * 0.65);
    return {
      candidate,
      vector: vectors[index]!,
      embeddingScore,
      rerankScore,
      finalScore,
    };
  });

  scored.sort((left, right) => right.finalScore - left.finalScore);
  const deduplicated = deduplicateBySemanticEvidence(scored);
  const fair = applySourceFairness(deduplicated.kept).map((row) =>
    deduplicated.kept.find((candidate) => candidate.candidate.url === row.candidate.url)!,
  );

  const prioritized = fair.map((row, index) =>
    withPriority(row.candidate, Math.round(row.finalScore * 10_000) / 100, index + 1),
  );
  const safeLimit = Math.max(20, Math.min(500, maxCandidates));

  return {
    candidates: prioritized.slice(0, safeLimit),
    overflow: prioritized.slice(safeLimit),
    applied: true,
    embedded: candidates.length,
    directReranked: rerankScores.size,
    duplicatesRemoved: deduplicated.removed,
    potentialDuplicates: deduplicated.potentialMatches,
    deferred: prioritized.filter((candidate) => candidate.semanticPriorityDeferred).length,
    errors: [],
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

/**
 * Rank raw deterministic candidates before enrichment and Cerebras extraction.
 * Cloudflare failure is deliberately non-fatal: callers keep their original
 * deterministic order and continue ingestion.
 */
export async function prioritizeCandidatesWithCloudflare<
  T extends SemanticPriorityCandidate,
>(
  candidates: T[],
  focus?: string,
  maxCandidates = 240,
): Promise<CandidateSemanticPriorityResult<T>> {
  const passthrough = (error?: string) => unprioritized(candidates, error);

  if (candidates.length < 2) return passthrough();
  if (!(await cloudflareWorkersAi.isConfigured())) return passthrough();

  const query = semanticQuery(focus);
  try {
    const queryVectors = await cloudflareWorkersAi.embed([query]);
    const queryVector = queryVectors?.[0];
    if (!queryVector) return passthrough("Cloudflare returned no query embedding.");

    const vectors: number[][] = [];
    for (const batch of chunk(candidates, EMBEDDING_BATCH_SIZE)) {
      const result = await cloudflareWorkersAi.embed(batch.map(candidateText));
      if (!result || result.length !== batch.length) {
        return passthrough("Cloudflare returned incomplete candidate embeddings.");
      }
      vectors.push(...result);
    }

    const embeddingOrder = candidates
      .map((candidate, index) => ({
        candidate,
        index,
        score: clamp01(cosineSimilarity(queryVector, vectors[index]!)),
      }))
      .sort((left, right) => right.score - left.score);
    const directHead = embeddingOrder.slice(0, DIRECT_RERANK_LIMIT);
    const rerankScores = new Map<number, number>();

    try {
      const direct = await cloudflareWorkersAi.rerank(
        query,
        directHead.map((row) => candidateText(row.candidate)),
      );
      for (const score of direct ?? []) {
        const original = directHead[score.index];
        if (original) rerankScores.set(original.index, score.score);
      }
    } catch (error) {
      // Embedding ranking remains fully usable when the direct reranker is busy.
      console.warn(
        `[candidateSemanticPriority] Cloudflare direct rerank failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return finalizeSemanticPriority(
      candidates,
      vectors,
      queryVector,
      rerankScores,
      maxCandidates,
    );
  } catch (error) {
    return passthrough(
      `Cloudflare semantic prioritization failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
