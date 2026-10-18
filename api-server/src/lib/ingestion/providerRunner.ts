import type { StructuredDecisionMarker } from "./opportunityIdentity";
import type {
  NormalizedOpportunity,
  ProviderProgressEvent,
} from "../providers/types";
import { partitionProviderRecordsForQuery } from "../providers/providerQueryMatch";
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
]);

export const FEDERAL_MANUAL_PROVIDERS = ["samGov", "tango"] as const;
export const MANUAL_RFP_PROVIDERS = new Set([
  ...FEDERAL_MANUAL_PROVIDERS,
  "internationalPublicPortals",
  "aiDiscovery",
  "emailNotifications",
  "rssAggregator",
]);

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
    (provider) => !MANUAL_RFP_PROVIDERS.has(provider),
  );
  if (unsupported.length > 0) {
    throw new Error(`Unsupported RFP provider(s): ${unsupported.join(", ")}`);
  }
  return resolved;
}

export function effectiveProviderQuery(keywords?: string): string {
  return keywords?.trim() || DEFAULT_OCCUMED_QUERY;
}

function applyProviderGuards(
  provider: string,
  records: NormalizedOpportunity[],
  errors: string[],
  keywords?: string,
  diagnostics?: Record<string, unknown>,
): ProviderRunResult {
  const query = effectiveProviderQuery(keywords);
  const partition = partitionProviderRecordsForQuery(records, query, 0);
  if (partition.rejectedCount > 0) {
    console.info(
      JSON.stringify({
        event: "rfp_provider_query_partitioned",
        provider,
        query,
        returned: partition.rawCount,
        matched: partition.matchedCount,
        rejected: partition.rejectedCount,
      }),
    );
  }
  const filtered = filterExpiredOpportunities(partition.matched);
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
  return {
    records: filtered.records,
    errors,
    expiredSkipped: filtered.expiredSkipped,
    diagnostics,
  };
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
  );
  if (guarded.records.length === 0) return guarded;
  const { decideStructuredOpportunities } = await import(
    "../search/structuredOpportunityDecision"
  );
  const decided = await decideStructuredOpportunities(guarded.records);
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
    }),
  );
  // Held and rejected records are returned (flagged) so ingestion stages them in raw/staging with a non-accepted
  // quality status: they stay auditable and reviewable, and decideOpportunityQuality never promotes them.
  const audited = [
    ...decided.held.map(({ record, code, reason }) =>
      withStructuredDecision(record, { status: "held", code, reason })),
    ...decided.rejectedRecords.map((record) =>
      withStructuredDecision(record, { status: "rejected", code: "structured_relevance_reject", reason: "Canonical relevance decision rejected the record." })),
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

  const settled = await Promise.allSettled(
    selected.map(async (provider) => {
      try {
        const result = await runtime.webIntelligenceFetch({
          keywords: options.keywords,
          dateRange: options.dateRange,
          signal: options.signal,
          ...discoveryOptions(provider),
        });
        if (result.opportunities.length > 0) {
          await recordProviderSuccess(provider, result.opportunities.length);
        } else if (result.errors.length > 0) {
          await recordProviderFailure(provider, result.errors.join("; "));
        } else {
          await recordProviderSuccess(provider, 0);
        }
        return { provider, result };
      } catch (error) {
        await recordProviderFailure(provider, error);
        throw error;
      }
    }),
  );

  const allRecords: NormalizedOpportunity[] = [];
  const errors: string[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  for (let index = 0; index < settled.length; index += 1) {
    const entry = settled[index]!;
    const provider = selected[index]!;
    const policy = discoveryQuotaPolicy(provider);
    const accountSlot = await activeAccountSlot(provider);
    if (entry.status === "rejected") {
      const message =
        entry.reason instanceof Error
          ? entry.reason.message
          : String(entry.reason);
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

    const member = entry.value.result;
    allRecords.push(...member.opportunities);
    errors.push(...member.errors.map((error) => `${provider}: ${error}`));
    const enrichment = {
      jina: member.stats.jinaEnriched,
      keenable: member.stats.keenableEnriched,
      browserbase: member.stats.browserbaseEnriched,
      firecrawl: member.stats.firecrawlEnriched,
      microlink: member.stats.microlinkEnriched,
    };
    diagnostics.push({
      provider,
      quota: policy,
      status: member.errors.length > 0 ? "warning" : "ok",
      candidates: member.stats.totalCandidates,
      accepted: member.opportunities.length,
      aiScorers: member.stats.aiScorers,
      enrichment,
      errors: member.errors.length,
    });
    recordIngestionProviderTelemetry(options.runId, {
      provider,
      status: member.errors.length > 0 ? "warning" : "used",
      renewal: policy?.renewal ?? null,
      accountSlot,
      candidates: member.stats.totalCandidates,
      accepted: member.opportunities.length,
      aiScorers: member.stats.aiScorers,
      enrichment,
      spent: true,
      note:
        member.opportunities.length > 0
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
    },
  };
}

export async function fetchOneProvider(
  provider: string,
  options: ProviderRunnerOptions,
): Promise<ProviderRunResult> {
  if (provider === "aiDiscovery") {
    const result = await fetchConfiguredAiDiscovery(options);
    return applyProviderGuards(
      provider,
      result.records,
      result.errors,
      options.keywords,
      result.diagnostics,
    );
  }

  if (provider === "rssAggregator") {
    const { rssAggregatorProvider } = await import("../providers/rssAggregator");
    const result = await rssAggregatorProvider.fetch({
      limit: 100,
      signal: options.signal,
    });
    return applyProviderGuards(
      provider,
      result.records,
      result.errors ?? [],
      options.keywords,
      result.diagnostics,
    );
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
    return applyProviderGuards(
      provider,
      filtered,
      result.errors,
      options.keywords,
      { aiScorers: result.stats.aiScorers },
    );
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
  return applyProviderGuards(
    provider,
    result.records,
    result.errors ?? [],
    options.keywords,
    result.diagnostics,
  );
}
