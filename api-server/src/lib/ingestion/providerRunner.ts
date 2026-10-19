import type { StructuredDecisionMarker } from "./opportunityIdentity";
import type {
  NormalizedOpportunity,
  ProviderProgressEvent,
} from "../providers/types";
import {
  classifyProviderRecordRelevance,
  normalizeProviderPostedDate,
  partitionProviderRecordsForQuery,
  recordMatchesProviderQuery,
} from "../providers/providerQueryMatch";
import { decideRelevance } from "../search/relevanceDecision";
import { releaseCFlags } from "../releaseC/flags";
import { exclusionSamples, recordCoverage } from "../releaseC/coverage";
import { summarizeSamVerification, verifySamPublicRecords } from "../providers/samGovPageVerification";
import { filterExpiredOpportunities } from "./opportunityExpiration";
import {
  calculateCompletenessScore,
  calculateOpportunityDedupeKeys,
  calculateSourceConfidence,
} from "./opportunityIdentity";
import {
  providerBudgetAvailable,
  recordProviderFailure,
  recordProviderSuccess,
} from "../providerBudget";
import {
  discoveryQuotaPolicy,
  selectQuotaAwareDiscoveryProviders,
} from "../discoveryQuotaPolicy";
import { credentialPoolTelemetry } from "../providers/freeTierCredentialPool";
import {
  recordDiscoverySelection,
  recordIngestionProviderTelemetry,
} from "./ingestionRuntimeTelemetry";

export const PROVIDER_ALIASES = new Map<string, string>([
  ["sam_gov", "samGov"],
  ["tango_api", "tango"],
  ["tangoApi", "tango"],
  ["ai_discovery", "aiDiscovery"],
  ["webIntelligence", "aiDiscovery"],
  ["publicPortalProviders", "aiDiscovery"],
  ["eunaBonfire", "aiDiscovery"],
  ["internationalPublicPortals", "internationalPublicPortals"],
  ["public_portal_providers", "aiDiscovery"],
  ["publicPortals", "aiDiscovery"],
  ["public_portals", "aiDiscovery"],
  ["statePortals", "aiDiscovery"],
  ["euna_bonfire", "aiDiscovery"],
  ["eunaSupplierNetwork", "aiDiscovery"],
  ["international_public_portals", "internationalPublicPortals"],
  ["internationalOpportunities", "internationalPublicPortals"],
  ["canadaEurope", "internationalPublicPortals"],
  ["canadaBuys", "internationalPublicPortals"],
  ["ted", "internationalPublicPortals"],
  ["rss_aggregator", "rssAggregator"],
  ["rssAggregator", "rssAggregator"],
  ["review_queue", "reviewQueue"],
]);

export const FEDERAL_MANUAL_PROVIDERS = ["samGov", "tango"] as const;
export const MANUAL_RFP_PROVIDERS = new Set([
  ...FEDERAL_MANUAL_PROVIDERS,
  "internationalPublicPortals",
  "aiDiscovery",
  "emailNotifications",
  "rssAggregator",
]);
/** Release C: internal provider that drains the persistent AI review queue through normal staging/promotion. */
export const INTERNAL_RFP_PROVIDERS = new Set(["reviewQueue"]);

const DEFAULT_OCCUMED_QUERY = "occupational health services";
const DEFAULT_MANUAL_PROVIDERS = [
  "samGov",
  "tango",
  "internationalPublicPortals",
  "aiDiscovery",
] as const;
const DISCOVERY_PROVIDER_ORDER = [
  "tinyfish",
  "keenable",
  "you",
  "browserbase",
  "parallel",
  "exa",
  "firecrawl",
  "langsearch",
  "linkup",
  "socrata",
  "websearch",
] as const;
const WEB_DISCOVERY_PROVIDERS = new Set<string>(DISCOVERY_PROVIDER_ORDER);
const MAX_DISCOVERY_ENSEMBLE = 5;

type StructuredFederalProvider = (typeof FEDERAL_MANUAL_PROVIDERS)[number];
type DiscoveryProvider = (typeof DISCOVERY_PROVIDER_ORDER)[number];

export interface ProviderRunResult {
  records: NormalizedOpportunity[];
  /** Records approved for promotion; `records` may also carry held/rejected records staged for audit only. */
  approvedCount?: number;
  errors: string[];
  expiredSkipped?: number;
  diagnostics?: Record<string, unknown>;
}

export interface ProviderRunnerOptions {
  runId?: string;
  /** Wall-clock budget for adaptive AI review inside this provider call. */
  reviewTimeBudgetMs?: number;
  keywords?: string;
  dateRange?: number;
  signal?: AbortSignal;
  onProgress?: (event: ProviderProgressEvent) => void | Promise<void>;
}

function isStructuredFederalProvider(
  provider: string,
): provider is StructuredFederalProvider {
  return provider === "samGov" || provider === "tango";
}

export function resolveManualProviders(providers?: string[]): string[] {
  const resolved = Array.from(
    new Set(
      (providers?.length ? providers : [...DEFAULT_MANUAL_PROVIDERS]).map(
        (provider) => PROVIDER_ALIASES.get(provider) ?? provider,
      ),
    ),
  );
  const unsupported = resolved.filter(
    (provider) => !MANUAL_RFP_PROVIDERS.has(provider) && !INTERNAL_RFP_PROVIDERS.has(provider),
  );
  if (unsupported.length > 0) {
    throw new Error(`Unsupported RFP provider(s): ${unsupported.join(", ")}`);
  }
  return resolved;
}

export function effectiveProviderQuery(keywords?: string): string {
  return keywords?.trim() || DEFAULT_OCCUMED_QUERY;
}

interface GuardedProviderResult extends ProviderRunResult {
  /** Records the query partition excluded and the canonical classifier also rejects (staged as rejected, not dropped). */
  partitionExcluded: NormalizedOpportunity[];
}

/**
 * Query partition + expiry guards. Release C audit: records the partition excludes are no longer dropped silently.
 * Any excluded record the canonical relevance decision would still keep (accept or review) is a potential missed
 * opportunity and is rescued into the normal decision path; the rest are returned for staging as rejected with the
 * partition reason. Every call writes a coverage event (returned / matched / excluded / rescued / errors per query).
 */
function applyProviderGuards(
  provider: string,
  records: NormalizedOpportunity[],
  errors: string[],
  keywords?: string,
  diagnostics?: Record<string, unknown>,
  runId?: string,
): GuardedProviderResult {
  const query = effectiveProviderQuery(keywords);
  const partition = partitionProviderRecordsForQuery(records, query, 0);
  const audit = releaseCFlags().coverageTracking;
  let matched = partition.matched;
  let partitionExcluded: NormalizedOpportunity[] = [];
  let rescued = 0;
  if (partition.rejectedCount > 0) {
    if (audit) {
      const excluded = records
        .filter((record) => !recordMatchesProviderQuery(record, query))
        .map(normalizeProviderPostedDate);
      const keep: NormalizedOpportunity[] = [];
      for (const record of excluded) {
        if (decideRelevance(classifyProviderRecordRelevance(record)).verdict === "reject") {
          partitionExcluded.push(withStructuredDecision(record, {
            status: "rejected",
            code: "provider_query_partition_excluded",
            reason: `Did not match the provider query "${query.slice(0, 120)}" and the canonical relevance decision rejects it.`,
          }));
        } else {
          keep.push(record);
        }
      }
      rescued = keep.length;
      matched = [...matched, ...keep];
    }
    console.info(
      JSON.stringify({
        event: "rfp_provider_query_partitioned",
        provider,
        query,
        returned: partition.rawCount,
        matched: partition.matchedCount,
        rejected: partition.rejectedCount,
        deferredByReason: partition.deferredByReason,
        rescued,
        stagedAsRejected: partitionExcluded.length,
      }),
    );
  }
  const filtered = filterExpiredOpportunities(matched);
  if (filtered.expiredSkipped > 0) {
    console.info(
      JSON.stringify({
        event: "rfp_expired_records_skipped",
        provider,
        expiredSkipped: filtered.expiredSkipped,
        reasons: filtered.reasons,
      }),
    );
  }
  if (audit) {
    const queryResults = Array.isArray(diagnostics?.queryResults)
      ? (diagnostics!.queryResults as Array<{ query: string; family: string; returned: number; truncated: boolean; error?: string }>)
      : [];
    void recordCoverage([
      {
        runId,
        provider,
        query,
        returned: partition.rawCount,
        matched: partition.matchedCount,
        excluded: partition.rejectedCount,
        staged: filtered.records.length,
        error: errors.length > 0 ? errors.slice(0, 3).join(" | ") : null,
        details: {
          rescuedFromPartition: rescued,
          partitionStagedAsRejected: partitionExcluded.length,
          expiredSkipped: filtered.expiredSkipped,
          samples: exclusionSamples(partitionExcluded),
        },
      },
      ...queryResults.map((row) => ({
        runId,
        provider,
        serviceFamily: row.family,
        query: row.query,
        returned: row.returned,
        matched: row.returned,
        excluded: 0,
        error: row.error ?? null,
        details: { truncatedPage: row.truncated },
      })),
    ]);
  } else {
    partitionExcluded = [];
  }
  return {
    records: filtered.records,
    errors,
    expiredSkipped: filtered.expiredSkipped,
    diagnostics,
    partitionExcluded,
  };
}

/** Direct (non-structured) providers: excluded records travel with the result flagged as rejected. */
function directProviderResult(guarded: GuardedProviderResult): ProviderRunResult {
  const { partitionExcluded, ...result } = guarded;
  if (partitionExcluded.length === 0) return result;
  return { ...result, records: [...result.records, ...partitionExcluded], approvedCount: result.records.length };
}

function withStructuredDecision(
  record: NormalizedOpportunity,
  decision: StructuredDecisionMarker,
): NormalizedOpportunity {
  return { ...record, rawData: { ...(record.rawData ?? {}), structuredDecision: decision } };
}

/** Approved records in a provider result (held/rejected audit records excluded). */
export function approvedRecordCount(result: ProviderRunResult): number {
  return result.approvedCount ?? result.records.length;
}

export async function applyStructuredFederalDecision(
  provider: string,
  records: NormalizedOpportunity[],
  errors: string[],
  options: ProviderRunnerOptions,
  diagnostics?: Record<string, unknown>,
): Promise<ProviderRunResult> {
  // Load the Occu-Med profile phrases the relevance gate reads synchronously.
  await import("../search/occumedSearchProfile")
    .then((module) => module.getOccuMedSearchProfile())
    .catch(() => undefined);
  const guarded = applyProviderGuards(
    provider,
    records,
    errors,
    options.keywords,
    diagnostics,
    options.runId,
  );
  if (guarded.records.length === 0) return directProviderResult(guarded);
  const { decideStructuredOpportunities } = await import(
    "../search/structuredOpportunityDecision"
  );
  const decided = await decideStructuredOpportunities(guarded.records, {
    provider,
    signal: options.signal,
    ...(options.reviewTimeBudgetMs ? { timeBudgetMs: options.reviewTimeBudgetMs } : {}),
  });
  if (decided.diagnostics.length > 0) {
    console.warn(
      JSON.stringify({
        event: "rfp_structured_review_recovered",
        provider,
        reviewer: decided.reviewer,
        diagnostics: decided.diagnostics,
      }),
    );
  }
  console.info(
    JSON.stringify({
      event: "rfp_structured_decision",
      provider,
      candidates: guarded.records.length,
      approved: decided.approved.length,
      deterministicApproved: decided.deterministicApproved,
      aiApproved: decided.aiApproved,
      rejected: decided.rejected,
      reviewHeld: decided.reviewHeld,
      reviewer: decided.reviewer,
      review: decided.review,
      partitionStagedAsRejected: guarded.partitionExcluded.length,
    }),
  );
  // Held and rejected records are returned (flagged) so ingestion stages them in raw/staging with a non-accepted
  // quality status: they stay auditable and reviewable, and decideOpportunityQuality never promotes them.
  const audited = [
    ...decided.held.map(({ record, code, reason }) =>
      withStructuredDecision(record, { status: "held", code, reason })),
    ...decided.rejectedRecords.map((record) =>
      withStructuredDecision(record, { status: "rejected", code: "structured_relevance_reject", reason: "Canonical relevance decision rejected the record." })),
    ...guarded.partitionExcluded,
  ];
  return {
    records: [...decided.approved, ...audited],
    approvedCount: decided.approved.length,
    errors: guarded.errors,
    expiredSkipped: guarded.expiredSkipped,
    diagnostics: {
      ...(guarded.diagnostics ?? {}),
      structuredReviewer: decided.reviewer,
      structuredCandidates: guarded.records.length,
      structuredApproved: decided.approved.length,
      structuredRejected: decided.rejected,
      structuredReviewHeld: decided.reviewHeld,
      structuredReview: decided.review,
    },
  };
}

async function recordStructuredProviderOutcome(
  provider: StructuredFederalProvider,
  rawRecordCount: number,
  upstreamErrors: string[],
  usefulRecordCount: number,
): Promise<void> {
  if (rawRecordCount === 0 && upstreamErrors.length > 0) {
    await recordProviderFailure(provider, new Error(upstreamErrors.join("; ")));
    return;
  }
  await recordProviderSuccess(provider, usefulRecordCount);
}

export function isSamGovRecoverableApiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SAM_API_KEY_NOT_CONFIGURED|SAM\.gov.*(?:429|quota|throttled|900804|nextAccessTime)/i.test(
    message,
  );
}

export function isOfficialSamOpportunityUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      (host === "sam.gov" || host.endsWith(".sam.gov")) &&
      /^\/opp\/[^/]+\/view\/?$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

async function activeAccountSlot(provider: string): Promise<string | null> {
  const prefix = provider.toLowerCase();
  const pools = await credentialPoolTelemetry().catch(() => []);
  return (
    pools.find((pool) => {
      const id = pool.id.toLowerCase();
      return id === prefix || id.startsWith(`${prefix}-`);
    })?.activeSlot ?? null
  );
}

function numericDiagnostic(
  diagnostics: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = diagnostics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayDiagnostic(
  diagnostics: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const value = diagnostics?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

async function fetchSamGovPublicSearchFallback(
  options: ProviderRunnerOptions,
  structuredError: unknown,
): Promise<ProviderRunResult | null> {
  const runtime = await loadDiscoveryRuntime();
  const focus = options.keywords?.trim();
  const samSearch = [
    "site:sam.gov/opp/ inurl:/view",
    focus
      ? `(${focus})`
      : "(occupational OR medical OR health OR testing OR surveillance)",
    '(solicitation OR "combined synopsis/solicitation")',
  ].join(" ");
  const result = await runtime.webIntelligenceFetch({
    keywords: focus,
    discoveryQueries: [samSearch],
    candidateUrlFilter: isOfficialSamOpportunityUrl,
    dateRange: options.dateRange,
    useYou: true,
    useBrowserbase: true,
    useKeenable: true,
    useTinyfish: true,
    useExa: true,
    useLangsearch: true,
    useParallel: true,
    useFirecrawl: true,
    useLinkup: true,
    useSocrata: false,
    useWebsearch: true,
    useRssAggregator: false,
    useSelfHostedSearch: false,
    useSelfHostedCrawler: false,
    discoveryPoolId: "sam-gov-public-search",
    signal: options.signal,
  });
  const candidates = result.opportunities
    .filter((record) => isOfficialSamOpportunityUrl(record.sourceUrl))
    .map((record) => ({
      ...record,
      source: "samGov" as const,
      rawData: {
        ...(record.rawData ?? {}),
        providerName: "samGovPublicSearch",
        evidenceType: "discovery",
        samGovKeylessFallback: true,
      },
    }));
  // Search hits carry no trustworthy dates or agency. Read each page and keep
  // only notices whose posted date and status are confirmed on it.
  const verification = await verifySamPublicRecords(candidates, {
    dateRangeDays: Math.max(1, Math.min(364, options.dateRange ?? 30)),
    signal: options.signal,
  });
  const records = verification.verified;
  const verificationNotes = summarizeSamVerification(verification);
  if (records.length === 0) return null;
  const diagnostics = {
    queryCount: 1,
    queries: [samSearch],
    targetedQueries: true,
    recoveryUsed: true,
    recovered: records.length,
    recoveryCandidates: candidates.length,
    recoveryDropped: verification.dropped.length,
    aiScorers: result.stats.aiScorers,
  };
  const guarded = await applyStructuredFederalDecision(
    "samGov",
    records,
    [
      `SAM.gov structured API unavailable; recovered ${records.length} page-verified SAM.gov notices through renewable web discovery.`,
      ...verificationNotes,
      ...result.errors,
    ],
    options,
    diagnostics,
  );
  await recordProviderSuccess("samGov", approvedRecordCount(guarded));
  recordIngestionProviderTelemetry(options.runId, {
    provider: "samGov",
    status: "warning",
    queryCount: 1,
    queries: [samSearch],
    accepted: approvedRecordCount(guarded),
    aiScorers: result.stats.aiScorers,
    spent: true,
    note: "Structured SAM API recovered through official SAM.gov public pages",
  });
  console.warn(
    JSON.stringify({
      event: "sam_gov_public_search_recovered",
      records: approvedRecordCount(guarded),
      structuredError:
        structuredError instanceof Error
          ? structuredError.message
          : String(structuredError),
    }),
  );
  return guarded;
}

async function fetchStructuredFederalProvider(
  provider: StructuredFederalProvider,
  options: ProviderRunnerOptions,
): Promise<ProviderRunResult> {
  if (!(await providerBudgetAvailable(provider))) {
    if (provider === "samGov") {
      const recovered = await fetchSamGovPublicSearchFallback(
        options,
        new Error(
          "SAM.gov structured API is cooling down after quota exhaustion",
        ),
      ).catch(() => null);
      if (recovered) return recovered;
    }
    recordIngestionProviderTelemetry(options.runId, {
      provider,
      status: "skipped",
      spent: false,
      note: "Provider-level budget/cooldown prevented this source from running",
    });
    return {
      records: [],
      errors: [
        `${provider} is temporarily cooling down after an upstream quota or reliability failure.`,
      ],
    };
  }

  try {
    if (provider === "samGov") {
      const { samGovProvider } = await import("../providers/samGov");
      const result = await samGovProvider.fetch({
        keywords: options.keywords,
        dateRange: options.dateRange,
        limit: 1000,
        signal: options.signal,
      });
      const upstreamErrors = result.errors ?? [];
      const decided = await applyStructuredFederalDecision(
        provider,
        result.records,
        upstreamErrors,
        options,
        result.diagnostics,
      );
      await recordStructuredProviderOutcome(
        provider,
        result.records.length,
        upstreamErrors,
        approvedRecordCount(decided),
      );
      recordIngestionProviderTelemetry(options.runId, {
        provider,
        status: upstreamErrors.length > 0 ? "warning" : "used",
        queryCount: numericDiagnostic(result.diagnostics, "queryCount"),
        queries: stringArrayDiagnostic(result.diagnostics, "queries"),
        candidates: result.records.length,
        accepted: approvedRecordCount(decided),
        spent: true,
        note: result.diagnostics?.recoveryUsed
          ? "SAM structured search used official-page recovery"
          : "SAM targeted structured search",
      });
      return decided;
    }

    const { tangoProvider } = await import("../providers/tango");
    const result = await tangoProvider.fetch({
      keywords: options.keywords,
      dateRange: options.dateRange,
      limit: 100,
      signal: options.signal,
    });
    const upstreamErrors = result.errors ?? [];
    const decided = await applyStructuredFederalDecision(
      provider,
      result.records,
      upstreamErrors,
      options,
      result.diagnostics,
    );
    await recordStructuredProviderOutcome(
      provider,
      result.records.length,
      upstreamErrors,
      approvedRecordCount(decided),
    );
    recordIngestionProviderTelemetry(options.runId, {
      provider,
      status: upstreamErrors.length > 0 ? "warning" : "used",
      candidates: result.records.length,
      accepted: approvedRecordCount(decided),
      spent: true,
      note: "Independent structured federal source",
    });
    return decided;
  } catch (error) {
    if (provider === "samGov" && isSamGovRecoverableApiError(error)) {
      const recovered = await fetchSamGovPublicSearchFallback(options, error).catch(
        () => null,
      );
      if (recovered) return recovered;
    }
    recordIngestionProviderTelemetry(options.runId, {
      provider,
      status: "failed",
      spent: true,
      note: error instanceof Error ? error.message : String(error),
    });
    await recordProviderFailure(provider, error);
    throw error;
  }
}

async function loadDiscoveryRuntime() {
  const [
    exa,
    langsearch,
    parallel,
    linkup,
    you,
    socrata,
    websearch,
    firecrawl,
    browserbase,
    keenable,
    tinyfish,
    intelligence,
  ] = await Promise.all([
    import("../providers/exa"),
    import("../providers/langsearch"),
    import("../providers/parallel"),
    import("../providers/linkup"),
    import("../providers/you"),
    import("../providers/socrata"),
    import("../providers/websearch"),
    import("../providers/firecrawl"),
    import("../providers/browserbase"),
    import("../providers/keenable"),
    import("../providers/tinyfish"),
    import("../search/webIntelligence"),
  ]);
  return {
    exaProvider: exa.exaProvider,
    langsearchProvider: langsearch.langsearchProvider,
    parallelProvider: parallel.parallelProvider,
    linkupProvider: linkup.linkupProvider,
    youProvider: you.youProvider,
    socrataProvider: socrata.socrataProvider,
    websearchProvider: websearch.websearchProvider,
    firecrawlProvider: firecrawl.firecrawlProvider,
    browserbaseProvider: browserbase.browserbaseProvider,
    keenableProvider: keenable.keenableProvider,
    tinyfishProvider: tinyfish.tinyfishProvider,
    webIntelligenceFetch: intelligence.webIntelligenceFetch,
    discoverWebCandidates: intelligence.discoverWebCandidates,
    mergeWebDiscoveryBatches: intelligence.mergeWebDiscoveryBatches,
    consolidatedDuplicateCount: intelligence.consolidatedDuplicateCount,
    processWebCandidates: intelligence.processWebCandidates,
    ENRICHMENT_MAX_URLS: intelligence.ENRICHMENT_MAX_URLS,
  };
}

function discoveryIdentityKey(record: NormalizedOpportunity): string {
  const keys = calculateOpportunityDedupeKeys(record);
  for (const type of ["solicitation", "url", "fingerprint"] as const) {
    const match = keys.find((key) => key.type === type);
    if (match) return match.value;
  }
  return (
    keys.find((key) => key.type === "provider")?.value ??
    `id:${record.externalId}`
  );
}

function discoveryRecordRank(record: NormalizedOpportunity): number {
  const relevance = Number(record.rawData?.relevanceScore);
  const relevanceScore = Number.isFinite(relevance) ? relevance : 0;
  const confidence = calculateSourceConfidence(record);
  const completeness = calculateCompletenessScore(record);
  const futureDeadline = Boolean(
    record.responseDeadline &&
      !Number.isNaN(record.responseDeadline.getTime()) &&
      record.responseDeadline.getTime() > Date.now(),
  );
  return (
    relevanceScore * 10_000 +
    confidence * 100 +
    completeness * 10 +
    (futureDeadline ? 250 : 0) +
    Math.min(200, record.description?.trim().length ?? 0)
  );
}

export function mergeDiscoveryRecords(
  records: NormalizedOpportunity[],
): NormalizedOpportunity[] {
  const best = new Map<
    string,
    { record: NormalizedOpportunity; rank: number }
  >();
  for (const record of records) {
    const key = discoveryIdentityKey(record);
    const rank = discoveryRecordRank(record);
    const existing = best.get(key);
    if (!existing || rank > existing.rank) best.set(key, { record, rank });
  }
  return [...best.values()].map((entry) => entry.record);
}

function discoveryOptions(provider: DiscoveryProvider) {
  return {
    useYou: provider === "you",
    useBrowserbase: provider === "browserbase",
    useKeenable: provider === "keenable",
    useTinyfish: provider === "tinyfish",
    useExa: provider === "exa",
    useLangsearch: provider === "langsearch",
    useParallel: provider === "parallel",
    useFirecrawl: provider === "firecrawl",
    useLinkup: provider === "linkup",
    useSocrata: provider === "socrata",
    useWebsearch: provider === "websearch",
    useRssAggregator: false,
    useSelfHostedSearch: false,
    useSelfHostedCrawler: false,
  } as const;
}

async function fetchConfiguredAiDiscovery(
  options: ProviderRunnerOptions,
): Promise<ProviderRunResult> {
  const runtime = await loadDiscoveryRuntime();
  const configuredChecks: Record<DiscoveryProvider, () => Promise<boolean>> = {
    keenable: () => runtime.keenableProvider.isConfigured(),
    tinyfish: () => runtime.tinyfishProvider.isConfigured(),
    you: () => runtime.youProvider.isConfigured(),
    browserbase: () => runtime.browserbaseProvider.isConfigured(),
    parallel: () => runtime.parallelProvider.isConfigured(),
    exa: () => runtime.exaProvider.isConfigured(),
    firecrawl: () => runtime.firecrawlProvider.isConfigured(),
    langsearch: () => runtime.langsearchProvider.isConfigured(),
    linkup: () => runtime.linkupProvider.isConfigured(),
    socrata: () => runtime.socrataProvider.isConfigured(),
    websearch: () => runtime.websearchProvider.isConfigured(),
  };

  const configured = (
    await Promise.all(
      DISCOVERY_PROVIDER_ORDER.map(async (provider) => ({
        provider,
        configured: await configuredChecks[provider]().catch(() => false),
      })),
    )
  )
    .filter((row) => row.configured)
    .map((row) => row.provider);

  if (configured.length === 0) {
    return {
      records: [],
      errors: [
        "AI Opportunity Discovery could not run because no supported browser/search provider is configured.",
      ],
    };
  }

  const selected = (await selectQuotaAwareDiscoveryProviders(
    configured,
    MAX_DISCOVERY_ENSEMBLE,
  )) as DiscoveryProvider[];
  recordDiscoverySelection(options.runId, { configured, selected });

  if (selected.length === 0) {
    return {
      records: [],
      errors: [
        "Configured browser/search providers are temporarily cooling down after quota or upstream failures.",
      ],
    };
  }

  // Raw discovery runs in parallel per provider (search only). The candidates are then consolidated by canonical URL
  // and enriched, extracted and qualified once, so a page several providers found costs one page fetch and one AI
  // extraction instead of one per provider.
  const discovered = await Promise.allSettled(
    selected.map(async (provider) => ({
      provider,
      batch: await runtime.discoverWebCandidates({
        keywords: options.keywords,
        dateRange: options.dateRange,
        signal: options.signal,
        ...discoveryOptions(provider),
      }),
    })),
  );
  const batches = discovered
    .filter((entry): entry is PromiseFulfilledResult<{ provider: DiscoveryProvider; batch: Awaited<ReturnType<typeof runtime.discoverWebCandidates>> }> => entry.status === "fulfilled")
    .map((entry) => entry.value);
  const consolidated = runtime.mergeWebDiscoveryBatches(batches);
  const duplicatesConsolidated = runtime.consolidatedDuplicateCount(batches, consolidated);
  let shared: Awaited<ReturnType<typeof runtime.processWebCandidates>> | null = null;
  let sharedError: unknown = null;
  if (batches.length > 0) {
    try {
      // The per-provider enrichment allowance is kept in total; it is now spent once per distinct page.
      shared = await runtime.processWebCandidates(consolidated, {
        keywords: options.keywords,
        signal: options.signal,
        enrichmentMaxUrls: runtime.ENRICHMENT_MAX_URLS * batches.length,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      sharedError = error;
    }
  }
  const foundBy = (record: NormalizedOpportunity): string[] => {
    const raw = record.rawData as Record<string, unknown> | undefined;
    const list = Array.isArray(raw?.discoveredBy) ? (raw!.discoveredBy as unknown[]).map(String) : [];
    return list.length > 0 ? list : [String(raw?.providerName ?? record.source)];
  };

  const allRecords: NormalizedOpportunity[] = shared ? [...shared.opportunities] : [];
  const errors: string[] = shared ? [...shared.errors] : [...consolidated.errors];
  if (sharedError) errors.push(`shared enrichment/extraction: ${sharedError instanceof Error ? sharedError.message : String(sharedError)}`);
  const diagnostics: Array<Record<string, unknown>> = [];
  const enrichment = shared
    ? {
        jina: shared.stats.jinaEnriched,
        keenable: shared.stats.keenableEnriched,
        browserbase: shared.stats.browserbaseEnriched,
        firecrawl: shared.stats.firecrawlEnriched,
        microlink: shared.stats.microlinkEnriched,
      }
    : null;
  for (let index = 0; index < discovered.length; index += 1) {
    const entry = discovered[index]!;
    const provider = selected[index]!;
    const policy = discoveryQuotaPolicy(provider);
    const accountSlot = await activeAccountSlot(provider);
    if (entry.status === "rejected") {
      const message =
        entry.reason instanceof Error
          ? entry.reason.message
          : String(entry.reason);
      await recordProviderFailure(provider, entry.reason);
      errors.push(`${provider}: ${message}`);
      diagnostics.push({ provider, status: "failed", quota: policy });
      recordIngestionProviderTelemetry(options.runId, {
        provider,
        status: "failed",
        renewal: policy?.renewal ?? null,
        accountSlot,
        spent: true,
        note: message,
      });
      continue;
    }

    const member = entry.value.batch;
    const accepted = allRecords.filter((record) => foundBy(record).includes(provider)).length;
    if (accepted > 0) await recordProviderSuccess(provider, accepted);
    else if (member.errors.length > 0) await recordProviderFailure(provider, member.errors.join("; "));
    else await recordProviderSuccess(provider, 0);
    diagnostics.push({
      provider,
      quota: policy,
      status: member.errors.length > 0 ? "warning" : "ok",
      candidates: member.candidates.length,
      accepted,
      aiScorers: shared?.stats.aiScorers ?? [],
      enrichment,
      errors: member.errors.length,
    });
    recordIngestionProviderTelemetry(options.runId, {
      provider,
      status: member.errors.length > 0 ? "warning" : "used",
      renewal: policy?.renewal ?? null,
      accountSlot,
      candidates: member.candidates.length,
      accepted,
      aiScorers: shared?.stats.aiScorers ?? [],
      ...(enrichment ? { enrichment } : {}),
      spent: true,
      note:
        accepted > 0
          ? "Discovery provider returned usable opportunity candidates"
          : "Discovery provider ran but returned no accepted opportunities",
    });
  }

  const merged = mergeDiscoveryRecords(allRecords);
  const uniqueErrors = Array.from(new Set(errors)).slice(0, 20);
  const aiScorers = Array.from(
    new Set(
      diagnostics.flatMap((row) =>
        Array.isArray(row.aiScorers)
          ? row.aiScorers.filter((value): value is string => typeof value === "string")
          : [],
      ),
    ),
  );
  console.info(
    JSON.stringify({
      event: "ai_opportunity_discovery_ensemble",
      query: options.keywords,
      configured,
      selected,
      selectionPolicy: selected.map((provider) =>
        discoveryQuotaPolicy(provider),
      ),
      memberRuns: diagnostics,
      acceptedBeforeDedupe: allRecords.length,
      acceptedAfterDedupe: merged.length,
      candidatesBeforeConsolidation: consolidated.candidates.length + duplicatesConsolidated,
      candidatesConsolidated: consolidated.candidates.length,
      duplicateCandidatesSkipped: duplicatesConsolidated,
      failures: uniqueErrors.length,
    }),
  );
  return {
    records: merged,
    errors: uniqueErrors,
    diagnostics: {
      configured,
      selected,
      memberRuns: diagnostics,
      aiScorers,
      acceptedBeforeDedupe: allRecords.length,
      acceptedAfterDedupe: merged.length,
      candidatesConsolidated: consolidated.candidates.length,
      duplicateCandidatesSkipped: duplicatesConsolidated,
    },
  };
}

export const REVIEW_QUEUE_CLAIM_LIMIT = 90;
export const REVIEW_QUEUE_TIME_BUDGET_MS = 8 * 60_000;

/**
 * Reviews queued ambiguous records with whatever free AI capacity is available now. Claimed records that are
 * approved come back for staging/promotion; those still unreviewed return to the queue (never dropped).
 */
async function fetchReviewQueue(options: ProviderRunnerOptions): Promise<ProviderRunResult> {
  const { cachedQueueDecisions, claimDueItems, completeItem } = await import("../releaseC/reviewQueue");
  const { opportunityKey } = await import("../releaseC/identity");
  await import("../search/occumedSearchProfile")
    .then((module) => module.getOccuMedSearchProfile())
    .catch(() => undefined);
  const items = await claimDueItems(REVIEW_QUEUE_CLAIM_LIMIT);
  if (items.length === 0) {
    return { records: [], approvedCount: 0, errors: [], diagnostics: { reviewQueueClaimed: 0 } };
  }
  const { decideStructuredOpportunities } = await import("../search/structuredOpportunityDecision");
  const decided = await decideStructuredOpportunities(
    items.map((item) => item.record),
    {
      provider: "reviewQueue",
      signal: options.signal,
      timeBudgetMs: options.reviewTimeBudgetMs ?? REVIEW_QUEUE_TIME_BUDGET_MS,
      claimedHashes: new Map(items.map((item) => [item.opportunityKey, item.contentHash])),
    },
  );
  // A newer version of an opportunity may have been decided (or queued) by ingestion while this drain reviewed the
  // claimed snapshot. Its row then carries the newer hash, and this drain's result for the old snapshot is dropped
  // rather than promoted over the newer decision.
  const current = await cachedQueueDecisions(items.map((item) => item.opportunityKey)).catch(() => null);
  const superseded = new Set(
    current
      ? items
          .map((item) => item.opportunityKey)
          .filter((key) => current.get(key) && current.get(key)!.contentHash !== decided.contentHashes.get(key))
      : [],
  );
  if (superseded.size > 0) {
    const keep = (record: NormalizedOpportunity) => !superseded.has(opportunityKey(record));
    decided.approved = decided.approved.filter(keep);
    decided.rejectedRecords = decided.rejectedRecords.filter(keep);
    decided.held = decided.held.filter((entry) => keep(entry.record));
  }
  // Records decided outside the AI path (deterministic approval once documents arrived, or a relevance reject after
  // a profile change) are closed here; AI-path records were settled by the decision itself.
  const closed = new Map<string, Record<string, unknown>>();
  for (const record of decided.approved) {
    if ((record.rawData as Record<string, unknown> | undefined)?.opportunityDecisionMethod === "deterministic") {
      closed.set(opportunityKey(record), { kind: "approved", method: "deterministic" });
    }
  }
  for (const record of decided.rejectedRecords) closed.set(opportunityKey(record), { kind: "rejected", code: "structured_relevance_reject" });
  for (const item of items) {
    const decision = closed.get(item.opportunityKey);
    if (decision && !superseded.has(item.opportunityKey)) {
      await completeItem(item.id, { status: "decided", decision }, decided.contentHashes.get(item.opportunityKey) ?? null).catch(() => undefined);
    }
  }
  console.info(
    JSON.stringify({
      event: "rfp_review_queue_drained",
      claimed: items.length,
      approved: decided.approved.length,
      aiApproved: decided.aiApproved,
      held: decided.reviewHeld,
      rejected: decided.rejected,
      review: decided.review,
    }),
  );
  if (decided.diagnostics.length > 0) {
    console.warn(JSON.stringify({ event: "rfp_review_queue_diagnostics", diagnostics: decided.diagnostics }));
  }
  const audited = [
    ...decided.held.map(({ record, code, reason }) => withStructuredDecision(record, { status: "held", code, reason })),
    ...decided.rejectedRecords.map((record) =>
      withStructuredDecision(record, { status: "rejected", code: "structured_relevance_reject", reason: "Canonical relevance decision rejected the record." })),
  ];
  recordIngestionProviderTelemetry(options.runId, {
    provider: "reviewQueue",
    status: decided.diagnostics.length > 0 ? "warning" : "used",
    candidates: items.length,
    accepted: decided.approved.length,
    spent: decided.review.judgeCalls > 0,
    note: `Persistent AI review queue: ${decided.review.reviewed} reviewed, ${decided.review.queued} still queued (${decided.review.stopReason ?? "complete"})`,
  });
  return {
    records: [...decided.approved, ...audited],
    approvedCount: decided.approved.length,
    errors: decided.review.stopReason === "no_reviewer_configured" ? ["No AI reviewer is configured; queued records stay queued."] : [],
    diagnostics: {
      reviewQueueClaimed: items.length,
      structuredApproved: decided.approved.length,
      structuredReviewHeld: decided.reviewHeld,
      structuredReview: decided.review,
      structuredReviewer: decided.reviewer,
    },
  };
}

export async function fetchOneProvider(
  provider: string,
  options: ProviderRunnerOptions,
): Promise<ProviderRunResult> {
  if (provider === "reviewQueue") {
    return fetchReviewQueue(options);
  }

  if (provider === "aiDiscovery") {
    const result = await fetchConfiguredAiDiscovery(options);
    return directProviderResult(applyProviderGuards(
      provider,
      result.records,
      result.errors,
      options.keywords,
      result.diagnostics,
      options.runId,
    ));
  }

  if (provider === "rssAggregator") {
    const { rssAggregatorProvider } = await import("../providers/rssAggregator");
    const result = await rssAggregatorProvider.fetch({
      limit: 100,
      signal: options.signal,
    });
    return directProviderResult(applyProviderGuards(
      provider,
      result.records,
      result.errors ?? [],
      options.keywords,
      result.diagnostics,
      options.runId,
    ));
  }

  if (isStructuredFederalProvider(provider)) {
    return fetchStructuredFederalProvider(provider, options);
  }

  if (WEB_DISCOVERY_PROVIDERS.has(provider)) {
    const { webIntelligenceFetch } = await loadDiscoveryRuntime();
    const result = await webIntelligenceFetch({
      keywords: options.keywords,
      dateRange: options.dateRange,
      useYou: provider === "you",
      useBrowserbase: provider === "browserbase",
      useKeenable: provider === "keenable",
    useTinyfish: provider === "tinyfish",
      useExa: provider === "exa",
      useLangsearch: provider === "langsearch",
      useParallel: provider === "parallel",
      useFirecrawl: provider === "firecrawl",
      useLinkup: provider === "linkup",
      useSocrata: provider === "socrata",
      useWebsearch: provider === "websearch",
      useRssAggregator: false,
      useSelfHostedSearch: false,
      useSelfHostedCrawler: false,
      signal: options.signal,
    });
    const filtered = result.opportunities.filter(
      (record) => record.source === provider,
    );
    recordIngestionProviderTelemetry(options.runId, {
      provider,
      status: result.errors.length > 0 ? "warning" : "used",
      renewal: discoveryQuotaPolicy(provider)?.renewal ?? null,
      accountSlot: await activeAccountSlot(provider),
      candidates: result.stats.totalCandidates,
      accepted: filtered.length,
      aiScorers: result.stats.aiScorers,
      enrichment: {
        jina: result.stats.jinaEnriched,
        keenable: result.stats.keenableEnriched,
        browserbase: result.stats.browserbaseEnriched,
        firecrawl: result.stats.firecrawlEnriched,
        microlink: result.stats.microlinkEnriched,
      },
      spent: true,
    });
    return directProviderResult(applyProviderGuards(
      provider,
      filtered,
      result.errors,
      options.keywords,
      { aiScorers: result.stats.aiScorers },
      options.runId,
    ));
  }

  const { providerRegistry } = await import("../providers");
  const source = providerRegistry[provider as keyof typeof providerRegistry];
  if (!source) throw new Error(`Unknown RFP provider: ${provider}`);
  const result = await source.fetch({
    keywords: options.keywords,
    dateRange: options.dateRange,
    limit: 100,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return directProviderResult(applyProviderGuards(
    provider,
    result.records,
    result.errors ?? [],
    options.keywords,
    result.diagnostics,
    options.runId,
  ));
}
