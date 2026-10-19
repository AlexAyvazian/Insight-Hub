import { createHash } from "crypto";
import { getOccuMedPromptContext, renderPromptContext } from "./occumedPromptContext";
import { geminiProvider, occumedProfileView } from "../providers/gemini";
import { SCOPE_BLOCK_HEADER, judgeScopeBlock, scoreGuidance } from "./profileText";
import { getRelevanceProfile } from "./relevanceProfile";
import { groqProvider } from "../providers/groq";
import { openrouterProvider } from "../providers/openrouter";
import { minimaxProvider } from "../providers/minimax";
import { clodProvider } from "../providers/clod";
import {
  cerebrasProvider,
  deepseekProvider,
  mistralProvider,
  nvidiaProvider,
} from "../providers/openAiCompatible";
import { prioritizeCandidatesWithCloudflare } from "./candidateSemanticPriority";
import { runLimitedProviderPool } from "../limitedProviderPool";
import { WORKER_ID, awaitOtherWorkers, canonicalCandidateUrl, sharedWorkStore } from "./sharedWork";

export interface AiExtraction {
  isOpportunity: boolean;
  title?: string;
  agency?: string;
  description?: string;
  deadline?: string | null;
  estimatedValue?: number | null;
  location?: string | null;
  relevanceScore?: number;
  relevanceReason?: string;
  winnerScorer?: string;
  validatedBy?: string;
  validationReason?: string;
  reason?: string;
}

export interface BatchExtractInput {
  title: string;
  url: string;
  content: string;
  sourceProvider?: string;
  cloudflareSemanticScore?: number;
  cloudflareSemanticRank?: number;
}

export interface BatchExtractResult {
  extractions: (AiExtraction | null)[];
  rateLimited: boolean;
  usedScorers: string[];
  cacheHits: number;
  cloudflarePrioritized: boolean;
  cloudflareEmbedded: number;
  cloudflareDirectReranked: number;
  cloudflareDuplicatesRemoved: number;
  cloudflareAiBudgetDeferred: number;
  cloudflareErrors: string[];
}

interface AiTextProvider {
  name: string;
  isConfigured(): Promise<boolean>;
  complete(
    prompt: string,
    maxTokens?: number,
    signal?: AbortSignal,
  ): Promise<string>;
}

/**
 * External AI extraction is bounded and fallback-driven. Cerebras is the normal
 * low-cost path, followed by additional configured trial providers. The old
 * self-hosted local-LLM path is deliberately excluded from this runtime so the
 * production process has one predictable extraction ownership model.
 */
export const AI_EXTRACTION_PROVIDER_ORDER = [
  "cloudflare-workers-ai",
  "cerebras",
  "groq",
  "gemini",
  "openrouter",
  "mistral",
  "deepseek",
  "nvidia",
  "minimax",
  "clod",
] as const;

const PRIMARY_PROVIDERS: AiTextProvider[] = [
  cerebrasProvider,
  groqProvider,
  geminiProvider,
  openrouterProvider,
  mistralProvider,
  deepseekProvider,
  nvidiaProvider,
  minimaxProvider,
  clodProvider,
];

const CROSS_CHECK_PROVIDERS: AiTextProvider[] = [
  groqProvider,
  geminiProvider,
  openrouterProvider,
  mistralProvider,
  deepseekProvider,
  nvidiaProvider,
  minimaxProvider,
  clodProvider,
];
const CHUNK_SIZE = 10;
const CONTENT_CHARS = 2_200;
const MAX_OUTPUT_TOKENS = 3_000;
const REVIEW_OUTPUT_TOKENS = 1_800;
const CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
export const MAX_EXTRACTION_CACHE_ENTRIES = 256;
const DEFAULT_AI_CANDIDATE_LIMIT = 240;

interface CacheEntry {
  value: AiExtraction;
  expires: number;
}

const extractionCache = new Map<string, CacheEntry>();

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("AI extraction aborted");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * The same page found by several search providers is one extraction: the key is the canonical URL and the page
 * content, not each provider's title wording or tracking parameters.
 */
function cacheKey(input: BatchExtractInput): string {
  return createHash("sha256")
    .update(canonicalCandidateUrl(input.url))
    .update("\n")
    .update(input.content.slice(0, 6_000))
    .digest("hex")
    .slice(0, 24);
}

const EXTRACTION_KIND = "ai_extraction";
const EXTRACTION_LEASE_MS = 3 * 60_000;
const EXTRACTION_WAIT_MS = 20_000;

/** Extractions in progress in another batch (a parallel provider run), shared instead of requested twice. */
const inflightExtractions = new Map<string, Promise<AiExtraction | null>>();

function pruneExtractionCache(now = Date.now()): void {
  for (const [key, entry] of extractionCache) {
    if (entry.expires <= now) extractionCache.delete(key);
  }
  while (extractionCache.size >= MAX_EXTRACTION_CACHE_ENTRIES) {
    const oldest = extractionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    extractionCache.delete(oldest);
  }
}

function getCached(input: BatchExtractInput): AiExtraction | undefined {
  const key = cacheKey(input);
  const entry = extractionCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    extractionCache.delete(key);
    return undefined;
  }
  // Refresh insertion order so the bounded cache behaves as a simple LRU.
  extractionCache.delete(key);
  extractionCache.set(key, entry);
  return entry.value;
}

function setCached(input: BatchExtractInput, value: AiExtraction): void {
  pruneExtractionCache();
  const key = cacheKey(input);
  extractionCache.delete(key);
  extractionCache.set(key, {
    value,
    expires: Date.now() + CACHE_TTL_MS,
  });
}

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /QUOTA_EXCEEDED|RATE_LIMITED|\b429\b|rate limit/i.test(message);
}

function stripJson(text: string): string {
  return text
    .replace(/```json\n?/g, "")
    .replace(/```/g, "")
    .trim();
}

function parseJsonArray(text: string): unknown[] | null {
  const cleaned = stripJson(text);
  try {
    const direct = JSON.parse(cleaned) as unknown;
    if (Array.isArray(direct)) return direct;
    if (
      direct &&
      typeof direct === "object" &&
      Array.isArray((direct as { results?: unknown[] }).results)
    ) {
      return (direct as { results: unknown[] }).results;
    }
  } catch {}

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch {}
  }
  return null;
}

function numberOrUndefined(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function extractionFromObject(
  raw: unknown,
  scorer: string,
): AiExtraction | null {
  if (!raw || typeof raw !== "object") return null;
  const object = raw as Record<string, unknown>;
  return {
    isOpportunity: object.isOpportunity === true,
    title: typeof object.title === "string" ? object.title : undefined,
    agency: typeof object.agency === "string" ? object.agency : undefined,
    description:
      typeof object.description === "string" ? object.description : undefined,
    deadline: typeof object.deadline === "string" ? object.deadline : null,
    estimatedValue: numberOrUndefined(object.estimatedValue) ?? null,
    location: typeof object.location === "string" ? object.location : null,
    relevanceScore: numberOrUndefined(object.relevanceScore),
    relevanceReason:
      typeof object.relevanceReason === "string"
        ? object.relevanceReason
        : undefined,
    reason: typeof object.reason === "string" ? object.reason : undefined,
    winnerScorer: scorer,
  };
}

/** Occu-Med service lines for the prompt, read from the profile on every call (the profile can refresh). */
function orgServices(): string {
  return occumedProfileView().services.join("; ");
}

/** Scope rules (unless the profile context already carries them) plus the canonical score guidance. */
function scopeAndScore(profileContext: string): string {
  return [profileContext.includes(SCOPE_BLOCK_HEADER) ? "" : judgeScopeBlock(), scoreGuidance()].filter(Boolean).join("\n");
}

export function buildBatchPrompt(
  items: BatchExtractInput[],
  today: string,
  profileContext = "",
): string {
  const blocks = items
    .map((item, index) => {
      const semantic =
        item.cloudflareSemanticScore == null
          ? "unavailable"
          : `${item.cloudflareSemanticScore.toFixed(2)}/100 (rank ${item.cloudflareSemanticRank ?? "?"})`;
      return `[${index}]\nTitle: ${item.title}\nURL: ${item.url}\nCloudflare semantic priority: ${semantic}\nContent: ${item.content.slice(0, CONTENT_CHARS)}`;
    })
    .join("\n\n");

  return `You are the primary procurement intelligence engine for Occu-Med.
Occu-Med services: ${orgServices()}.
Today's date: ${today}.
${profileContext ? `\n${profileContext}\n` : ""}
Cloudflare Workers AI has already semantically prioritized this batch. Its score is supporting evidence only; independently verify the page itself.

Analyze EVERY indexed item. Determine whether it is a CURRENTLY OPEN procurement opportunity that Occu-Med could realistically pursue. Understand semantic equivalents of the service lines listed above.

Reject awards, expired or closed notices, news coverage, jobs, regulations, and pages without evidence that proposals are currently accepted.
${scopeAndScore(profileContext)}

Return ONLY a JSON array in the same order. Every object must include index and isOpportunity.
Accepted objects must include title, agency, description, deadline (YYYY-MM-DD or null), estimatedValue, location, relevanceScore (0-100), and relevanceReason.
Rejected objects must include a specific reason.

ITEMS:
${blocks}`;
}

export function shouldCrossCheckExtraction(
  extraction: AiExtraction,
): boolean {
  if (!extraction.isOpportunity) return false;
  const score = extraction.relevanceScore ?? 0;
  // An accepted record scoring below the canonical accept threshold is internally inconsistent: verify it.
  return (
    score < getRelevanceProfile().thresholds.acceptMin ||
    !extraction.agency?.trim() ||
    (extraction.description?.trim().length ?? 0) < 80
  );
}

/** Backward-compatible export retained for existing callers/tests. */
export const shouldEscalateToCerebras = shouldCrossCheckExtraction;

function buildCrossCheckPrompt(
  items: Array<{
    localIndex: number;
    input: BatchExtractInput;
    preliminary: AiExtraction;
  }>,
  today: string,
  profileContext = "",
): string {
  const blocks = items
    .map(
      ({ localIndex, input, preliminary }) =>
        `[${localIndex}]\nTITLE: ${input.title}\nURL: ${input.url}\nCONTENT: ${input.content.slice(0, 2_000)}\nPRIMARY VERDICT: ${JSON.stringify(preliminary)}`,
    )
    .join("\n\n");

  return `Cross-check the following ambiguous ACCEPT decisions from the primary procurement analysis.
Today: ${today}.
${profileContext ? `\n${profileContext}\n` : ""}${scoreGuidance()}
Return ONLY {"results":[...]}. Preserve an acceptance only when the source supports a currently open procurement relevant to Occu-Med. Correct dates, agency names, descriptions, and scores. Each result must include index, isOpportunity, relevanceScore, validationReason, and corrected fields.

${blocks}`;
}

interface ProviderAttemptResult {
  rows: unknown[] | null;
  scorer: string | null;
  rateLimited: boolean;
}

async function runProviderChain(
  providers: AiTextProvider[],
  prompt: string,
  maxTokens: number,
  skipProvider?: string,
  signal?: AbortSignal,
): Promise<ProviderAttemptResult> {
  throwIfAborted(signal);
  const result = await runLimitedProviderPool(
    "opportunity-ai-extraction",
    providers
      .filter((provider) => provider.name !== skipProvider)
      .map((provider) => ({
        name: provider.name,
        isConfigured: () => provider.isConfigured(),
        run: async (attemptSignal) =>
          parseJsonArray(
            await provider.complete(prompt, maxTokens, attemptSignal),
          ),
      })),
    (rows) => Array.isArray(rows),
    { signal },
  );
  throwIfAborted(signal);
  return {
    rows: result.value,
    scorer: result.provider,
    rateLimited: [...result.errors, ...result.recoveredErrors].some((error) =>
      isRateLimit(error),
    ),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function sourceKey(input: BatchExtractInput): string {
  if (input.sourceProvider?.trim()) return input.sourceProvider.trim();
  try {
    return new URL(input.url).hostname.replace(/^www\./, "") || "unknown";
  } catch {
    return "unknown";
  }
}

function aiCandidateLimit(): number {
  const configured = Number.parseInt(
    process.env.WEB_INTELLIGENCE_AI_CANDIDATE_LIMIT ?? "",
    10,
  );
  if (!Number.isFinite(configured)) return DEFAULT_AI_CANDIDATE_LIMIT;
  return Math.max(20, Math.min(500, configured));
}

export async function extractOpportunitiesBatch(
  inputs: BatchExtractInput[],
  signal?: AbortSignal,
): Promise<BatchExtractResult> {
  throwIfAborted(signal);
  const extractions: (AiExtraction | null)[] = new Array(inputs.length).fill(
    null,
  );
  const usedScorers = new Set<string>();
  let rateLimited = false;
  let cacheHits = 0;
  let cloudflarePrioritized = false;
  let cloudflareEmbedded = 0;
  let cloudflareDirectReranked = 0;
  let cloudflareDuplicatesRemoved = 0;
  let cloudflareAiBudgetDeferred = 0;
  let cloudflareErrors: string[] = [];

  pruneExtractionCache();
  let pending: Array<{ input: BatchExtractInput; index: number }> = [];
  const joined: Array<{ index: number; promise: Promise<AiExtraction | null> }> = [];
  const owned = new Map<string, { resolve: (value: AiExtraction | null) => void; indexes: number[] }>();
  inputs.forEach((input, index) => {
    const cached = getCached(input);
    if (cached) {
      extractions[index] = cached;
      cacheHits += 1;
      return;
    }
    const key = cacheKey(input);
    const mine = owned.get(key);
    if (mine) {
      // The same page twice in one batch: extract once.
      mine.indexes.push(index);
      return;
    }
    const other = inflightExtractions.get(key);
    if (other) {
      joined.push({ index, promise: other });
      return;
    }
    let resolve!: (value: AiExtraction | null) => void;
    const promise = new Promise<AiExtraction | null>((done) => (resolve = done));
    inflightExtractions.set(key, promise);
    owned.set(key, { resolve, indexes: [index] });
    pending.push({ input, index });
  });

  // Across workers and deploys: reuse extractions already stored, and wait briefly for pages another worker is
  // extracting right now, instead of sending the same page to a model twice.
  const store = sharedWorkStore();
  const claimed = new Set<string>();
  if (store && pending.length > 0) {
    const keyOf = new Map(pending.map((entry) => [entry.index, cacheKey(entry.input)]));
    const fill = (found: Map<string, unknown>) => {
      for (const entry of pending) {
        const value = found.get(keyOf.get(entry.index)!) as AiExtraction | undefined;
        if (!value || typeof value !== "object") continue;
        for (const index of owned.get(keyOf.get(entry.index)!)?.indexes ?? [entry.index]) extractions[index] = value;
        setCached(entry.input, value);
        cacheHits += 1;
      }
      pending = pending.filter((entry) => !found.has(keyOf.get(entry.index)!));
    };
    fill(await store.getMany(EXTRACTION_KIND, [...new Set(keyOf.values())]).catch(() => new Map<string, unknown>()));
    const wanted = pending.map((entry) => keyOf.get(entry.index)!);
    const mine = await store.claimMany(EXTRACTION_KIND, wanted, WORKER_ID, EXTRACTION_LEASE_MS).catch(() => new Set(wanted));
    for (const key of mine) claimed.add(key);
    const elsewhere = wanted.filter((key) => !mine.has(key));
    if (elsewhere.length > 0) fill(await awaitOtherWorkers(store, EXTRACTION_KIND, elsewhere, EXTRACTION_WAIT_MS, 1_000));
  }

  const releaseOwned = () => {
    for (const [key, entry] of owned) {
      const value = entry.indexes.map((index) => extractions[index]).find((row): row is AiExtraction => Boolean(row)) ?? null;
      for (const index of entry.indexes) if (!extractions[index] && value) extractions[index] = value;
      entry.resolve(value);
      if (inflightExtractions.get(key)) inflightExtractions.delete(key);
    }
    owned.clear();
  };
  const settleDurable = async () => {
    if (!store || claimed.size === 0) return;
    const finished: Array<{ key: string; value: unknown }> = [];
    for (const [key, entry] of owned) {
      if (!claimed.has(key)) continue;
      const value = entry.indexes.map((index) => extractions[index]).find((row): row is AiExtraction => Boolean(row));
      if (value) finished.push({ key, value });
    }
    const done = new Set(finished.map((entry) => entry.key));
    await store.completeMany(EXTRACTION_KIND, finished, WORKER_ID, CACHE_TTL_MS).catch(() => undefined);
    await store.abandonMany(EXTRACTION_KIND, [...claimed].filter((key) => !done.has(key)), WORKER_ID).catch(() => undefined);
    claimed.clear();
  };
  try {
    const result = await extractPending();
    await settleDurable();
    // Release this batch's pages before waiting on another batch's, so two batches sharing pages never wait on
    // each other.
    releaseOwned();
    // Pages shared with another batch take that batch's result; a page it could not extract stays unextracted here
    // (and is retried by the next run), rather than being requested twice in parallel.
    for (const { index, promise } of joined) {
      const value = await promise;
      if (value) {
        extractions[index] = value;
        result.cacheHits += 1;
      }
    }
    return result;
  } finally {
    await settleDurable();
    releaseOwned();
  }

  async function extractPending(): Promise<BatchExtractResult> {
    if (pending.length === 0) {
      return {
        extractions,
        rateLimited,
        usedScorers: [...usedScorers],
        cacheHits,
        cloudflarePrioritized,
        cloudflareEmbedded,
        cloudflareDirectReranked,
        cloudflareDuplicatesRemoved,
        cloudflareAiBudgetDeferred,
        cloudflareErrors,
      };
    }

    throwIfAborted(signal);
    let prioritizedPending = pending;
    const semantic = await prioritizeCandidatesWithCloudflare(
      pending.map((entry) => ({
        ...entry.input,
        sourceProvider: sourceKey(entry.input),
        originalIndex: entry.index,
      })),
      undefined,
      aiCandidateLimit(),
    );
    throwIfAborted(signal);

    cloudflarePrioritized = semantic.applied;
    cloudflareEmbedded = semantic.embedded;
    cloudflareDirectReranked = semantic.directReranked;
    cloudflareDuplicatesRemoved = semantic.duplicatesRemoved;
    cloudflareErrors = semantic.errors;
    cloudflareAiBudgetDeferred = Math.max(
      0,
      pending.length - semantic.candidates.length,
    );

    if (semantic.applied) {
      usedScorers.add("cloudflare-workers-ai");
      prioritizedPending = semantic.candidates.map((candidate) => ({
        index: candidate.originalIndex,
        input: {
          title: candidate.title,
          url: candidate.url,
          content: candidate.content,
          sourceProvider: candidate.sourceProvider,
          cloudflareSemanticScore: candidate.cloudflareSemanticScore,
          cloudflareSemanticRank: candidate.cloudflareSemanticRank,
        },
      }));
    }

    const today = new Date().toISOString().split("T")[0] ?? "";

    for (const group of chunk(prioritizedPending, CHUNK_SIZE)) {
      throwIfAborted(signal);
      const primary = await runProviderChain(
        PRIMARY_PROVIDERS,
        buildBatchPrompt(
          group.map((entry) => entry.input),
          today,
          renderPromptContext(await getOccuMedPromptContext()),
        ),
        MAX_OUTPUT_TOKENS,
        undefined,
        signal,
      );
      if (primary.rateLimited) rateLimited = true;
      if (!primary.rows || !primary.scorer) continue;
      usedScorers.add(primary.scorer);

      const provisional = new Map<number, AiExtraction>();
      primary.rows.forEach((raw, order) => {
        if (!raw || typeof raw !== "object") return;
        const object = raw as Record<string, unknown>;
        const localIndex =
          typeof object.index === "number" &&
          object.index >= 0 &&
          object.index < group.length
            ? object.index
            : order;
        if (!group[localIndex]) return;
        const extraction = extractionFromObject(
          raw,
          primary.scorer ?? "unknown",
        );
        if (extraction) provisional.set(localIndex, extraction);
      });

      const reviewItems = [...provisional.entries()]
        .filter(([, extraction]) => shouldCrossCheckExtraction(extraction))
        .map(([localIndex, preliminary]) => ({
          localIndex,
          input: group[localIndex]!.input,
          preliminary,
        }));

      if (reviewItems.length > 0) {
        throwIfAborted(signal);
        const reviewers =
          primary.scorer === "cerebras"
            ? CROSS_CHECK_PROVIDERS
            : [cerebrasProvider, ...CROSS_CHECK_PROVIDERS];
        const review = await runProviderChain(
          reviewers,
          buildCrossCheckPrompt(reviewItems, today, renderPromptContext(await getOccuMedPromptContext())),
          REVIEW_OUTPUT_TOKENS,
          primary.scorer,
          signal,
        );
        if (review.rateLimited) rateLimited = true;
        if (review.rows?.length && review.scorer) {
          const reviewerName = review.scorer;
          usedScorers.add(reviewerName);
          review.rows.forEach((raw, order) => {
            if (!raw || typeof raw !== "object") return;
            const object = raw as Record<string, unknown>;
            const localIndex =
              typeof object.index === "number"
                ? object.index
                : reviewItems[order]?.localIndex;
            if (
              typeof localIndex !== "number" ||
              !provisional.has(localIndex)
            ) {
              return;
            }
            const corrected = extractionFromObject(
              raw,
              primary.scorer ?? "unknown",
            );
            if (!corrected) return;
            corrected.validatedBy = reviewerName;
            corrected.validationReason =
              typeof object.validationReason === "string"
                ? object.validationReason
                : undefined;
            corrected.winnerScorer = `${primary.scorer}+${reviewerName}`;
            provisional.set(localIndex, corrected);
          });
        }
      }

      throwIfAborted(signal);
      for (const [localIndex, extraction] of provisional) {
        const target = group[localIndex];
        if (!target) continue;
        extractions[target.index] = extraction;
        setCached(target.input, extraction);
      }
    }

    throwIfAborted(signal);
    return {
      extractions,
      rateLimited,
      usedScorers: [...usedScorers],
      cacheHits,
      cloudflarePrioritized,
      cloudflareEmbedded,
      cloudflareDirectReranked,
      cloudflareDuplicatesRemoved,
      cloudflareAiBudgetDeferred,
      cloudflareErrors,
    };
  }
}

export function clearExtractionCache(): void {
  extractionCache.clear();
  inflightExtractions.clear();
}

export function extractionCacheSize(): number {
  pruneExtractionCache();
  return extractionCache.size;
}
