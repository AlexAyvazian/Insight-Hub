import { createHash } from "crypto";
import { geminiProvider } from "../providers/gemini";
import { exaProvider } from "../providers/exa";
import { firecrawlProvider } from "../providers/firecrawl";
import { jinaProvider } from "../providers/jina";
import { keenableProvider } from "../providers/keenable";
import { tinyfishProvider } from "../providers/tinyfish";
import { browserbaseProvider } from "../providers/browserbase";
import { microlinkProvider } from "../providers/microlink";
import { youProvider } from "../providers/you";
import { langsearchProvider } from "../providers/langsearch";
import { parallelProvider } from "../providers/parallel";
import { linkupProvider } from "../providers/linkup";
import { socrataProvider } from "../providers/socrata";
import { websearchProvider } from "../providers/websearch";
import { rssAggregatorProvider } from "../providers/rssAggregator";
import { selfHostedCrawlerProvider } from "../providers/selfHostedCrawler";
import { selfHostedSearchProvider } from "../providers/selfHostedSearch";
import { extractMetadataFromText } from "./heuristicExtract";
import { extractOpportunitiesBatch } from "./aiExtract";
import {
  classifyResult,
  isBlockedDomain as isBlockedDomainShared,
  isRfpCandidate as isRfpCandidateShared,
  type RelevanceResult,
} from "./relevance";
import { decideRelevance } from "./relevanceDecision";
import { REASON_CODES } from "./relevanceReasonCodes";
import { getRelevanceProfile } from "./relevanceProfile";
import {
  profileBooleanQueries,
  profileExclusionOperators,
  profileLeadPhrases,
  profileNaturalQueries,
  profileProcurementTerms,
  profileScopeOperand,
  queryRotationCursor,
  spreadSample,
} from "./profileWebQueries";
import type { NormalizedOpportunity } from "../providers/types";
import type { ProviderName } from "../config/providerConfig";
import { buildSignalWeights } from "../learning/feedbackModel";
import { runLimitedProviderPool } from "../limitedProviderPool";

const ENRICHMENT_MAX_URLS = 10;
const EXA_RESULTS_PER_QUERY = 20;
const DAY_MS = 86_400_000;

type SearchCandidateProvider =
  | "rssAggregator"
  | "selfHostedSearch"
  | "you"
  | "browserbase"
  | "keenable"
  | "tinyfish"
  | "parallel"
  | "exa"
  | "firecrawl"
  | "langsearch"
  | "linkup"
  | "socrata"
  | "websearch";

/** Boolean-operator queries, one per profile search bundle (rendered at call time from the Neon profile). */
/** Max discovery queries per run (unchanged), and the share AI-generated queries may take of it. */
export const MAX_DISCOVERY_QUERIES = 10;
export const MAX_GENERATED_QUERIES = 3;

/**
 * Bounded query plan: the user's keyword queries first, then at most MAX_GENERATED_QUERIES AI-generated queries,
 * then profile/coverage queries spread across every bundle (rotating daily). AI queries can never crowd out the
 * canonical profile coverage, and the per-run total is unchanged.
 */
export function planDiscoveryQueries(
  keywordQueries: string[],
  generated: string[],
  profileQueries: string[],
  cursor: number,
): string[] {
  const plan = Array.from(new Set([...keywordQueries, ...generated.slice(0, MAX_GENERATED_QUERIES)].map((q) => q.trim()).filter(Boolean)));
  const remaining = Math.max(0, MAX_DISCOVERY_QUERIES - plan.length);
  const profile = Array.from(new Set(profileQueries)).filter((q) => !plan.includes(q));
  return [...plan, ...spreadSample(profile, remaining, cursor)].slice(0, MAX_DISCOVERY_QUERIES);
}

function discoveryQueryPlanCounts(plan: string[], keyword: string[], generated: string[]) {
  const k = new Set(keyword);
  const g = new Set(generated);
  return {
    keyword: plan.filter((q) => k.has(q)).length,
    generated: plan.filter((q) => !k.has(q) && g.has(q)).length,
    profile: plan.filter((q) => !k.has(q) && !g.has(q)).length,
  };
}

function occumedWebQueries(year: number): string[] {
  return profileBooleanQueries(year);
}

/** Natural-language queries for neural engines, one per profile search bundle. */
function exaQueries(year: number): string[] {
  return profileNaturalQueries(year);
}

function boundedDateRange(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.min(3_650, Math.max(1, Math.floor(value!)))
    : 30;
}

export interface WebIntelligenceResult {
  opportunities: NormalizedOpportunity[];
  stats: {
    youResults: number;
    browserbaseResults: number;
    keenableResults: number;
    tinyfishResults: number;
    parallelResults: number;
    exaResults: number;
    firecrawlResults: number;
    langsearchResults: number;
    linkupResults: number;
    socrataResults: number;
    websearchResults: number;
    rssAggregatorResults: number;
    selfHostedSearchResults: number;
    totalCandidates: number;
    dateFiltered: number;
    preFiltered: number;
    /** Candidates kept for enrichment because the snippet alone was review-band (not yet accepted). */
    reviewBandKept: number;
    /** Discovery queries by origin for this run (keyword / AI-generated / profile coverage). */
    queryPlan: { keyword: number; generated: number; profile: number };
    /** Why candidates were skipped before enrichment, by reason (no candidate disappears without a reason). */
    skippedByReason: Record<string, number>;
    jinaEnriched: number;
    keenableEnriched: number;
    browserbaseEnriched: number;
    firecrawlEnriched: number;
    microlinkEnriched: number;
    selfHostedCrawlerEnriched: number;
    extracted: number;
    heuristicExtracted: number;
    rejected: number;
    expiredRejected: number;
    geminiRateLimited: boolean;
    aiCacheHits: number;
    aiScorers: string[];
  };
  errors: string[];
}

interface Candidate {
  title: string;
  url: string;
  content: string;
  sourceProvider: SearchCandidateProvider;
  dateRaw?: string;
  enrichedBy?: string;
}

export type DiscoveryTriage =
  | { keep: true; band: "accept" | "review" }
  | { keep: false; reason: "blocked_domain" | "hard_reject" | "no_procurement_signal" | "insufficient_relevance" };

/**
 * Pre-enrichment triage of a search hit from its title/snippet alone. Only cheap, safe exclusions happen here
 * (job boards, profile hard rejects, no procurement wording, no service evidence at all). Review-band snippets are
 * kept so the page can be fetched and judged on its full text; a short snippet is not grounds to discard.
 */
export function triageDiscoveryCandidate(candidate: Pick<Candidate, "title" | "content" | "url">): DiscoveryTriage {
  if (isBlockedDomainShared(candidate.url)) return { keep: false, reason: "blocked_domain" };
  const r = classifyResult({ title: candidate.title, snippet: candidate.content, url: candidate.url, allowHistorical: true });
  if (r.reasonCodes.includes(REASON_CODES.hardReject)) return { keep: false, reason: "hard_reject" };
  if (r.matchedProcurementSignals.length === 0) return { keep: false, reason: "no_procurement_signal" };
  const verdict = decideRelevance(r).verdict;
  if (verdict === "reject") return { keep: false, reason: "insufficient_relevance" };
  return { keep: true, band: verdict };
}

/** Legacy accept-only gate, kept for callers outside discovery triage. */
export function isRfpCandidate(candidate: Candidate): boolean {
  return isRfpCandidateShared(candidate.title, candidate.content, candidate.url);
}

function buildWebOpportunity(
  candidate: Candidate,
  fields: {
    title: string;
    agency: string;
    description?: string;
    deadline?: Date;
    location?: string;
    estimatedValue?: number;
    relevanceScore: number;
    relevanceReason: string;
    cls: RelevanceResult;
    fallback: boolean;
    extra?: Record<string, unknown>;
  },
): NormalizedOpportunity {
  const { cls } = fields;
  const urlHash = createHash("sha256")
    .update(candidate.url)
    .digest("hex")
    .slice(0, 20);
  const dateUnknown = cls.publishedDate == null;
  const tags: string[] = [];
  if (cls.category) tags.push(cls.category);
  if (dateUnknown) tags.push("date-unknown");
  if (cls.stale) tags.push("stale");
  if (fields.fallback) tags.push("ai-pending");

  return {
    externalId: `web-${urlHash}`,
    title: fields.title,
    agency: fields.agency,
    type: "Solicitation",
    status: "active",
    // Never invent a posted date. When the source states none, use the epoch
    // sentinel the rest of the app treats as "unknown" (paired with the
    // date-unknown tag) instead of stamping the fetch time as if it were real.
    postedDate: cls.publishedDate ?? new Date(0),
    responseDeadline: fields.deadline,
    description: fields.description,
    placeOfPerformance: fields.location,
    estimatedValue: fields.estimatedValue,
    sourceUrl: candidate.url,
    source: candidate.sourceProvider as ProviderName,
    rawData: {
      url: candidate.url,
      providerName: candidate.sourceProvider,
      relevanceScore: fields.relevanceScore,
      relevanceReason: fields.relevanceReason,
      relevanceReasons: cls.reasons,
      category: cls.category,
      dateUnknown,
      stale: cls.stale,
      tags,
      fallback: fields.fallback,
      extractedFrom: candidate.sourceProvider,
      enrichedBy: candidate.enrichedBy,
      ...(fields.extra ?? {}),
    },
  };
}

function isExpiredDeadline(deadline: Date | undefined | null): boolean {
  if (!deadline) return false;
  return deadline < new Date(Date.now() - DAY_MS);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Web intelligence discovery aborted");
  }
}

function addCandidate(candidates: Candidate[], seen: Set<string>, candidate: Candidate) {
  if (!candidate.url || seen.has(candidate.url) || isBlockedDomainShared(candidate.url)) return;
  seen.add(candidate.url);
  candidates.push(candidate);
}

export async function webIntelligenceFetch(options: {
  keywords?: string;
  dateRange?: number;
  useGemini?: boolean;
  useExa?: boolean;
  useFirecrawl?: boolean;
  useYou?: boolean;
  useKeenable?: boolean;
  useTinyfish?: boolean;
  useBrowserbase?: boolean;
  useLangsearch?: boolean;
  useParallel?: boolean;
  useLinkup?: boolean;
  useSocrata?: boolean;
  useWebsearch?: boolean;
  useRssAggregator?: boolean;
  useSelfHostedSearch?: boolean;
  useSelfHostedCrawler?: boolean;
  discoveryPoolId?: string;
  discoveryQueries?: string[];
  candidateUrlFilter?: (url: string) => boolean;
  signal?: AbortSignal;
}): Promise<WebIntelligenceResult> {
  throwIfAborted(options.signal);
  // Load the Occu-Med profile phrases the relevance gate reads synchronously.
  await import("./occumedSearchProfile")
    .then((module) => module.getOccuMedSearchProfile())
    .catch(() => undefined);
  const errors: string[] = [];
  const dateRangeDays = boundedDateRange(options.dateRange);
  const publishedAfter = new Date(Date.now() - dateRangeDays * DAY_MS);
  const publishedAfterIso = publishedAfter.toISOString();
  const runtimeYear = new Date().getFullYear();
  const stats: WebIntelligenceResult["stats"] = {
    youResults: 0,
    browserbaseResults: 0,
    keenableResults: 0,
    tinyfishResults: 0,
    parallelResults: 0,
    exaResults: 0,
    firecrawlResults: 0,
    langsearchResults: 0,
    linkupResults: 0,
    socrataResults: 0,
    websearchResults: 0,
    rssAggregatorResults: 0,
    selfHostedSearchResults: 0,
    totalCandidates: 0,
    dateFiltered: 0,
    preFiltered: 0,
    reviewBandKept: 0,
    queryPlan: { keyword: 0, generated: 0, profile: 0 },
    skippedByReason: {} as Record<string, number>,
    jinaEnriched: 0,
    keenableEnriched: 0,
    browserbaseEnriched: 0,
    firecrawlEnriched: 0,
    microlinkEnriched: 0,
    selfHostedCrawlerEnriched: 0,
    extracted: 0,
    heuristicExtracted: 0,
    rejected: 0,
    expiredRejected: 0,
    geminiRateLimited: false,
    aiCacheHits: 0,
    aiScorers: [],
  };

  const useGemini = options.useGemini === true;
  const useExa = options.useExa === true;
  const useFirecrawl = options.useFirecrawl === true;
  const useYou = options.useYou === true;
  const useKeenable = options.useKeenable === true;
  const useTinyfish = options.useTinyfish === true;
  const useBrowserbase = options.useBrowserbase === true;
  const useLangsearch = options.useLangsearch === true;
  const useParallel = options.useParallel === true;
  const useLinkup = options.useLinkup === true;
  const useSocrata = options.useSocrata === true;
  const useWebsearch = options.useWebsearch === true;
  const useRssAggregator = options.useRssAggregator !== false;
  const useSelfHostedSearch = options.useSelfHostedSearch === true;
  const useSelfHostedCrawler = options.useSelfHostedCrawler === true;

  const profileQueries = [...occumedWebQueries(runtimeYear), ...exaQueries(runtimeYear)];
  const keywordQueryList: string[] = [];
  let generatedQueries: string[] = [];
  if (options.keywords?.trim()) {
    const kw = options.keywords.trim();
    const procurement = profileProcurementTerms(getRelevanceProfile(), 5).map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(" OR ");
    const scope = profileScopeOperand();
    keywordQueryList.push(
      [`(${kw})`, procurement ? `(${procurement})` : "", scope, "government", String(runtimeYear), profileExclusionOperators()].filter(Boolean).join(" "),
      `active open government procurement opportunity for ${kw} ${profileLeadPhrases(undefined, 3).join(" ")} ${runtimeYear}`.replace(/\s+/g, " "),
    );
  }

  let feedbackHints = "";
  try {
    const weights = await buildSignalWeights();
    if (weights.totalGrades >= 3) {
      const topAgencies = Object.entries(weights.agencies)
        .filter(([, weight]) => weight > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([key]) => key);
      const topKeywords = Object.entries(weights.keywords)
        .filter(([, weight]) => weight > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([key]) => key);
      feedbackHints = [
        topAgencies.length ? `High-value agencies: ${topAgencies.join(", ")}.` : "",
        topKeywords.length ? `High-signal keywords: ${topKeywords.join(", ")}.` : "",
      ].filter(Boolean).join(" ");
    }
  } catch {}

  if (useGemini) {
    try {
      generatedQueries = await geminiProvider.generateSearchQueries(
        [options.keywords, feedbackHints].filter(Boolean).join(". ") || undefined,
      );
    } catch (error: any) {
      if (error.message?.startsWith("GEMINI_QUOTA_EXCEEDED")) {
        stats.geminiRateLimited = true;
        errors.push("Gemini daily quota reached — using built-in search queries.");
      } else {
        errors.push(`Gemini query generation: ${error.message}`);
      }
    }
  }

  const discoveryQueries = options.discoveryQueries?.length
    ? Array.from(new Set(options.discoveryQueries.map((query) => query.trim()).filter(Boolean)))
    : planDiscoveryQueries(keywordQueryList, generatedQueries, profileQueries, queryRotationCursor());
  stats.queryPlan = discoveryQueryPlanCounts(discoveryQueries, keywordQueryList, generatedQueries);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const query of discoveryQueries) {
    throwIfAborted(options.signal);
    const attempts: Array<{
      name: SearchCandidateProvider;
      isConfigured: () => Promise<boolean>;
      run: (signal?: AbortSignal) => Promise<Candidate[]>;
    }> = [];

    if (useRssAggregator) {
      attempts.push({
        name: "rssAggregator",
        isConfigured: () => rssAggregatorProvider.isConfigured(),
        run: async (attemptSignal) => {
          const result = await rssAggregatorProvider.fetch({ limit: 50, signal: attemptSignal ?? options.signal });
          return result.records.map((record) => ({
            title: record.title,
            url: record.sourceUrl || "",
            content: record.description || record.title,
            sourceProvider: "rssAggregator" as const,
            dateRaw: record.postedDate?.toISOString(),
          }));
        },
      });
    }

    if (useSelfHostedSearch) {
      attempts.push({
        name: "selfHostedSearch",
        isConfigured: () => selfHostedSearchProvider.isConfigured(),
        run: async (attemptSignal) => (await selfHostedSearchProvider.search({ query, limit: 20, signal: attemptSignal ?? options.signal })).map((result) => ({
          title: result.title,
          url: result.url || "",
          content: result.description || result.title,
          sourceProvider: "selfHostedSearch" as const,
        })),
      });
    }

    if (useYou) attempts.push({
      name: "you",
      isConfigured: () => youProvider.isConfigured(),
      run: async (attemptSignal) => (await youProvider.search(query, attemptSignal ?? options.signal)).map((result) => ({ ...result, sourceProvider: "you" as const })),
    });

    if (useBrowserbase) attempts.push({
      name: "browserbase",
      isConfigured: () => browserbaseProvider.isConfigured(),
      run: async (attemptSignal) => (await browserbaseProvider.search(query, 15, attemptSignal ?? options.signal)).map((result) => ({
        title: result.title,
        url: result.url,
        content: result.title,
        sourceProvider: "browserbase" as const,
        dateRaw: result.publishedDate,
      })),
    });

    if (useTinyfish) attempts.push({
      name: "tinyfish",
      isConfigured: () => tinyfishProvider.isConfigured(),
      run: async (attemptSignal) => (await tinyfishProvider.search(query, {
        publishedAfter: publishedAfterIso,
        signal: attemptSignal ?? options.signal,
      })).map(result => ({
        title: result.title,
        url: result.url,
        content: result.snippet || result.title,
        sourceProvider: "tinyfish" as const,
        dateRaw: result.publishedAt,
      })),
    });

    if (useKeenable) attempts.push({
      name: "keenable",
      isConfigured: () => keenableProvider.isConfigured(),
      run: async (attemptSignal) => (await keenableProvider.search(query, { publishedAfter: publishedAfterIso, signal: attemptSignal ?? options.signal })).map((result) => ({
        title: result.title,
        url: result.url,
        content: result.snippet || result.description || result.title,
        sourceProvider: "keenable" as const,
        dateRaw: result.publishedAt ?? result.acquiredAt,
      })),
    });

    if (useParallel) attempts.push({
      name: "parallel",
      isConfigured: () => parallelProvider.isConfigured(),
      run: async (attemptSignal) => (await parallelProvider.search(query, attemptSignal ?? options.signal)).map((result) => ({
        title: result.title,
        url: result.url,
        content: result.excerpts.join(" "),
        sourceProvider: "parallel" as const,
        dateRaw: result.publishDate,
      })),
    });

    if (useExa) attempts.push({
      name: "exa",
      isConfigured: () => exaProvider.isConfigured(),
      run: async (attemptSignal) => (await exaProvider.search(query, { numResults: EXA_RESULTS_PER_QUERY, startPublishedDate: publishedAfterIso, signal: attemptSignal ?? options.signal })).map((result) => ({
        title: result.title ?? "",
        url: result.url ?? "",
        content: (result.highlights ?? []).join(" ") || result.text?.slice(0, 1000) || "",
        sourceProvider: "exa" as const,
        dateRaw: result.publishedDate,
      })),
    });

    if (useFirecrawl) attempts.push({
      name: "firecrawl",
      isConfigured: () => firecrawlProvider.isConfigured(),
      run: async (attemptSignal) => (await firecrawlProvider.search(query, 15, attemptSignal ?? options.signal)).map((result) => ({
        title: result.title,
        url: result.url,
        content: result.description || result.markdown || result.title,
        sourceProvider: "firecrawl" as const,
      })),
    });

    if (useLangsearch) attempts.push({
      name: "langsearch",
      isConfigured: () => langsearchProvider.isConfigured(),
      run: async (attemptSignal) => (await langsearchProvider.search(query, { dateRange: dateRangeDays, signal: attemptSignal ?? options.signal })).map((result) => ({
        title: result.title,
        url: result.url,
        content: result.content,
        sourceProvider: "langsearch" as const,
        dateRaw: result.dateRaw,
      })),
    });

    if (useLinkup) attempts.push({
      name: "linkup",
      isConfigured: () => linkupProvider.isConfigured(),
      run: async (attemptSignal) => (await linkupProvider.search(query, attemptSignal ?? options.signal)).map((result) => ({
        title: result.name,
        url: result.url,
        content: result.content,
        sourceProvider: "linkup" as const,
      })),
    });

    if (useSocrata) attempts.push({
      name: "socrata",
      isConfigured: () => socrataProvider.isConfigured(),
      run: async (attemptSignal) => (await socrataProvider.search(options.keywords?.trim() || `procurement bids solicitations ${profileLeadPhrases(undefined, 1).join(" ")}`.trim(), attemptSignal ?? options.signal)).map((result) => ({
        title: result.title,
        url: result.url,
        content: result.description,
        sourceProvider: "socrata" as const,
        dateRaw: result.updatedAt,
      })),
    });

    if (useWebsearch) attempts.push({
      name: "websearch",
      isConfigured: () => websearchProvider.isConfigured(),
      run: async (attemptSignal) => {
        const result = await websearchProvider.fetch({ keywords: query, dateRange: dateRangeDays, signal: attemptSignal ?? options.signal });
        if (result.records.length === 0 && result.errors.length > 0) throw new Error(result.errors.join("; "));
        return (result.records as any[]).map((record) => ({
          title: record.title ?? "",
          url: record.url ?? record.sourceUrl ?? "",
          content: record.description ?? record.snippet ?? "",
          sourceProvider: "websearch" as const,
          dateRaw: record.postedDate ?? record.date ?? record.updatedAt,
        }));
      },
    });

    const result = await runLimitedProviderPool(
      options.discoveryPoolId ?? "opportunity-web-discovery",
      attempts,
      (value) => value.some((candidate) => options.candidateUrlFilter?.(candidate.url) ?? true),
      { signal: options.signal },
    );
    errors.push(...result.errors);
    if (!result.value || !result.provider) continue;

    const counter = `${result.provider}Results` as keyof typeof stats;
    if (typeof stats[counter] === "number") (stats[counter] as number) += result.value.length;
    for (const candidate of result.value) {
      if (options.candidateUrlFilter && !options.candidateUrlFilter(candidate.url)) continue;
      addCandidate(candidates, seen, candidate);
    }
  }

  stats.totalCandidates = candidates.length;
  const dateBoundedCandidates = candidates.filter((candidate) => {
    if (!candidate.dateRaw) return true;
    const parsed = new Date(candidate.dateRaw);
    return Number.isNaN(parsed.getTime()) || parsed.getTime() >= publishedAfter.getTime();
  });
  stats.dateFiltered = candidates.length - dateBoundedCandidates.length;
  const triaged = dateBoundedCandidates.map((candidate) => ({ candidate, triage: triageDiscoveryCandidate(candidate) }));
  const filtered: Candidate[] = [];
  const reviewBand = new Set<Candidate>();
  for (const { candidate, triage } of triaged) {
    if (triage.keep) {
      filtered.push(candidate);
      if (triage.band === "review") reviewBand.add(candidate);
    } else {
      stats.skippedByReason[triage.reason] = (stats.skippedByReason[triage.reason] ?? 0) + 1;
    }
  }
  if (stats.dateFiltered > 0) stats.skippedByReason.outside_date_range = stats.dateFiltered;
  stats.preFiltered = filtered.length;
  stats.reviewBandKept = reviewBand.size;
  stats.rejected = candidates.length - filtered.length;
  if (filtered.length === 0) return { opportunities: [], stats, errors };

  // Enrichment budget is unchanged (ENRICHMENT_MAX_URLS). Spend it first on review-band hits, which cannot be judged
  // without the page, then on accepted hits whose snippet is still thin.
  const enrichedCandidates = [...filtered];
  const toEnrich = enrichedCandidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.content.length < 800)
    .sort((a, b) => Number(reviewBand.has(b.candidate)) - Number(reviewBand.has(a.candidate)) || a.index - b.index)
    .slice(0, ENRICHMENT_MAX_URLS);

  for (const { candidate, index } of toEnrich) {
    throwIfAborted(options.signal);
    // Cost order is deliberate: Jina's renewable Reader first, then monthly
    // indexed/browser services, then Firecrawl credits, then tiny Microlink daily.
    const enrichmentAttempts = [
      {
        name: "jina" as const,
        isConfigured: () => jinaProvider.isConfigured(),
        run: (attemptSignal?: AbortSignal) => jinaProvider.extractUrl(candidate.url, 5_000, attemptSignal ?? options.signal),
      },
      {
        name: "keenable" as const,
        isConfigured: () => keenableProvider.isConfigured(),
        run: (attemptSignal?: AbortSignal) => keenableProvider.fetchText(candidate.url, 6_000, attemptSignal ?? options.signal),
      },
      {
        name: "browserbase" as const,
        isConfigured: () => browserbaseProvider.isConfigured(),
        run: (attemptSignal?: AbortSignal) => browserbaseProvider.fetchText(candidate.url, 6_000, attemptSignal ?? options.signal),
      },
      {
        name: "firecrawl" as const,
        isConfigured: () => firecrawlProvider.isConfigured(),
        run: async (attemptSignal?: AbortSignal) => (await firecrawlProvider.scrape(candidate.url, attemptSignal ?? options.signal))?.markdown ?? null,
      },
      {
        name: "microlink" as const,
        isConfigured: () => microlinkProvider.isConfigured(),
        run: (attemptSignal?: AbortSignal) => microlinkProvider.fetchText(candidate.url, 6_000, attemptSignal ?? options.signal),
      },
      ...(useSelfHostedCrawler
        ? [{
            name: "selfHostedCrawler" as const,
            isConfigured: () => selfHostedCrawlerProvider.isConfigured(),
            run: (attemptSignal?: AbortSignal) => selfHostedCrawlerProvider.getText(candidate.url, { signal: attemptSignal ?? options.signal }),
          }]
        : []),
    ];
    const enriched = await runLimitedProviderPool(
      "opportunity-page-enrichment",
      enrichmentAttempts,
      (value) => typeof value === "string" && value.length > 120,
      { signal: options.signal },
    );
    errors.push(...enriched.errors);
    if (!enriched.value || !enriched.provider) continue;
    enrichedCandidates[index] = {
      ...candidate,
      content: enriched.value.slice(0, 5_000),
      enrichedBy: enriched.provider,
    };
    const counter = `${enriched.provider}Enriched` as keyof typeof stats;
    if (typeof stats[counter] === "number") (stats[counter] as number)++;
  }

  if (stats.geminiRateLimited) errors.push("Gemini rate limited — falling back to other available scorers.");
  const opportunities: NormalizedOpportunity[] = [];

  try {
    const { extractions, rateLimited, usedScorers, cacheHits } = await extractOpportunitiesBatch(
      enrichedCandidates.map((candidate) => ({ title: candidate.title, url: candidate.url, content: candidate.content })),
      options.signal,
    );
    if (rateLimited) stats.geminiRateLimited = true;
    stats.aiCacheHits = cacheHits;
    stats.aiScorers = usedScorers;

    enrichedCandidates.forEach((candidate, index) => {
      const extraction = extractions[index];
      if (extraction && !extraction.isOpportunity) {
        stats.rejected++;
        return;
      }
      if (extraction?.isOpportunity) {
        const deadline = extraction.deadline ? new Date(extraction.deadline) : undefined;
        const validDeadline = deadline && !Number.isNaN(deadline.getTime()) ? deadline : undefined;
        if (isExpiredDeadline(validDeadline) || (extraction.relevanceScore ?? 0) < getRelevanceProfile().thresholds.reviewMin) {
          stats.expiredRejected += isExpiredDeadline(validDeadline) ? 1 : 0;
          stats.rejected++;
          return;
        }
        const cls = classifyResult({
          title: extraction.title ?? candidate.title,
          snippet: candidate.content,
          description: extraction.description,
          url: candidate.url,
          date: candidate.dateRaw,
          deadlineInFuture: !!validDeadline,
          keywords: options.keywords,
        });
        if (decideRelevance(cls).verdict === "reject") {
          stats.rejected++;
          return;
        }
        opportunities.push(buildWebOpportunity(candidate, {
          title: extraction.title ?? candidate.title,
          // Never substitute a service category for an unknown buyer.
          agency: extraction.agency ?? "Unknown Organization",
          description: extraction.description,
          deadline: validDeadline,
          location: extraction.location ?? undefined,
          estimatedValue: extraction.estimatedValue ?? undefined,
          relevanceScore: extraction.relevanceScore ?? cls.score,
          relevanceReason: extraction.relevanceReason ?? cls.reasons.join("; "),
          cls,
          fallback: false,
          extra: { winnerScorer: extraction.winnerScorer },
        }));
        stats.extracted++;
        return;
      }

      const cls = classifyResult({ title: candidate.title, snippet: candidate.content, url: candidate.url, date: candidate.dateRaw, keywords: options.keywords });
      if (decideRelevance(cls).verdict === "reject") {
        stats.rejected++;
        return;
      }
      const meta = extractMetadataFromText(candidate.content, candidate.title);
      if (isExpiredDeadline(meta.deadline)) {
        stats.expiredRejected++;
        stats.rejected++;
        return;
      }
      opportunities.push(buildWebOpportunity(candidate, {
        title: candidate.title,
        agency: meta.agencyHint ?? "Unknown Organization",
        // Keep the full fetched text (already capped at 5,000 by enrichment) so scope evidence is not judged on 600.
        description: candidate.content.slice(0, 5_000) || undefined,
        deadline: meta.deadline,
        estimatedValue: meta.estimatedValue,
        relevanceScore: cls.score,
        relevanceReason: cls.reasons.join("; "),
        cls,
        fallback: true,
      }));
      stats.extracted++;
      stats.heuristicExtracted++;
    });
  } catch (error: any) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    errors.push(`Web intelligence error: ${error.message}`);
  }

  throwIfAborted(options.signal);
  return {
    opportunities,
    stats,
    errors: Array.from(new Set(errors)).slice(0, 30),
  };
}
