import type {
  DataSourceProvider,
  FetchOptions,
  NormalizedOpportunity,
  ProviderFetchResult,
  ProviderProgressEvent,
  ProviderStatus,
} from "./types";
import { publicPortalProvidersProvider as publishedPortalInventory } from "./publicPortalProviders";
import type { PublicPortalSource } from "./publicPortalProviders/catalog";
import {
  failedPortalStatus,
  loadPublicPortalHealth,
  savePublicPortalHealth,
  selectFairPortalSources,
  type PublicPortalSourceRunStatus,
} from "./publicPortalProviders/portalHealthStore";
import { runAdapterWithDeadline } from "./adapterExecution";
import {
  partitionProviderRecordsForQuery,
  type ProviderQueryPartition,
} from "./providerQueryMatch";
import { fairMergeOpportunityGroups } from "./fairOpportunityMerge";
import {
  getRegisteredPublicPortalAdapter,
  isRegisteredPublicPortalAdapter,
} from "./publicPortalAdapterRegistry";

const SOURCE_TIMEOUT_MS = 20_000;
const ROTATION_BATCH_SIZE = 20;
const SOURCE_SCAN_LIMIT = 200;
const RESULT_LIMIT = 100;
const SOURCE_RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 750;
const QUERY_REJECTION_SAMPLE_LIMIT = 2;

const TRANSIENT_ADAPTER_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_ADAPTER_MESSAGE =
  /timed out|timeout|temporarily unavailable|connection (?:reset|closed|terminated)|network is unreachable|fetch failed|socket hang up|HTTP (?:408|425|429|5\d\d)\b|rate.?limit/i;

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  errors?: unknown;
}

export function isTransientPortalAdapterError(
  value: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (!value || seen.has(value)) return false;
  seen.add(value);
  if (typeof value === "string") return TRANSIENT_ADAPTER_MESSAGE.test(value);
  if (typeof value !== "object") return false;

  const error = value as ErrorLike;
  if (
    typeof error.code === "string" &&
    TRANSIENT_ADAPTER_CODES.has(error.code.toUpperCase())
  ) {
    return true;
  }
  if (
    typeof error.message === "string" &&
    TRANSIENT_ADAPTER_MESSAGE.test(error.message)
  ) {
    return true;
  }
  if (isTransientPortalAdapterError(error.cause, seen)) return true;
  return (
    Array.isArray(error.errors) &&
    error.errors.some((nested) => isTransientPortalAdapterError(nested, seen))
  );
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("Adapter run cancelled"),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Adapter run cancelled"),
      );
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRunnableSource(source: PublicPortalSource): boolean {
  return isRegisteredPublicPortalAdapter(source.id);
}

function normalizeSourceRecord(
  record: NormalizedOpportunity,
  source: PublicPortalSource,
): NormalizedOpportunity {
  const tags = Array.isArray(record.rawData?.tags)
    ? record.rawData.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    ...record,
    source: "publicPortalProviders",
    providerName: "publicPortalProviders",
    rawData: {
      ...(record.rawData ?? {}),
      sourceId: source.id,
      agencyName: source.agencyName,
      portalPlatform: source.portalPlatform,
      sourceConfidence:
        record.rawData?.sourceConfidence === "low" ||
        record.rawData?.sourceConfidence === "medium" ||
        record.rawData?.sourceConfidence === "high"
          ? record.rawData.sourceConfidence
          : "high",
      tags: Array.from(
        new Set([
          ...tags,
          "official-procurement-portal",
          `portal:${source.id}`,
        ]),
      ),
    },
  };
}

function successfulYieldStatus(
  source: PublicPortalSource,
  prior: PublicPortalSourceRunStatus | undefined,
  checkedAt: Date,
  rawCount: number,
  matchedCount: number,
): PublicPortalSourceRunStatus {
  const yieldedRelevantRecord = matchedCount > 0;
  return {
    sourceId: source.id,
    sourceName: source.agencyName,
    domain: source.domain,
    lastCheckedAt: checkedAt,
    lastSuccessAt: checkedAt,
    lastFailureAt: prior?.lastFailureAt,
    lastFailureReason: prior?.lastFailureReason,
    resultCount: rawCount,
    matchedCount,
    lifetimeResultCount: (prior?.lifetimeResultCount ?? 0) + rawCount,
    totalAttempts: (prior?.totalAttempts ?? 0) + 1,
    totalSuccesses: (prior?.totalSuccesses ?? 0) + 1,
    totalFailures: prior?.totalFailures ?? 0,
    consecutiveFailures: 0,
    consecutiveNoResultSuccesses: yieldedRelevantRecord
      ? 0
      : (prior?.consecutiveNoResultSuccesses ?? 0) + 1,
    lastOutcome: yieldedRelevantRecord ? "success" : "no_results",
  };
}

interface SourceCollection {
  source: PublicPortalSource;
  partition: ProviderQueryPartition;
  records: NormalizedOpportunity[];
  errors: string[];
}

async function emitProgress(
  options: FetchOptions,
  event: ProviderProgressEvent,
  errors: string[],
): Promise<void> {
  if (!options.onProgress) return;
  try {
    await options.onProgress(event);
  } catch (error) {
    errors.push(
      `${event.sourceId ?? event.provider}: progress persistence failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function saveHealthSafely(
  status: PublicPortalSourceRunStatus,
  errors: string[],
): Promise<void> {
  try {
    await savePublicPortalHealth(status);
  } catch (error) {
    errors.push(
      `${status.sourceId}: portal health persistence failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function collectRawSourceRecords(
  source: PublicPortalSource,
  options: FetchOptions,
): Promise<ProviderFetchResult> {
  const provider = getRegisteredPublicPortalAdapter(source.id);
  if (!provider) {
    return {
      records: [],
      total: 0,
      errors: [`${source.id}: registered adapter is unavailable at runtime`],
    };
  }

  // Adapter-specific OR-word matchers are intentionally bypassed. The shared
  // query classifier runs after normalization and before any global cap.
  return runAdapterWithDeadline(
    source.id,
    provider,
    {
      ...options,
      keywords: undefined,
      offset: 0,
      limit: SOURCE_SCAN_LIMIT,
      onProgress: undefined,
    },
    SOURCE_TIMEOUT_MS,
  );
}

async function collectWithRetry(
  source: PublicPortalSource,
  options: FetchOptions,
  index: number,
  total: number,
  errors: string[],
): Promise<ProviderFetchResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= SOURCE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const result = await collectRawSourceRecords(source, options);
      const reportedTransientFailure =
        result.records.length === 0 &&
        result.errors.length > 0 &&
        result.errors.every((error) => isTransientPortalAdapterError(error));
      if (reportedTransientFailure) {
        throw new Error(result.errors.join("; "));
      }
      return result;
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
      const canRetry =
        attempt < SOURCE_RETRY_ATTEMPTS &&
        isTransientPortalAdapterError(error);
      if (!canRetry) throw error;

      await emitProgress(
        options,
        {
          provider: "publicPortalProviders",
          phase: "source_retry",
          sourceId: source.id,
          sourceName: source.agencyName,
          index,
          total,
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        },
        errors,
      );
      await wait(RETRY_DELAY_MS * attempt, options.signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${source.id}: adapter attempts exhausted`);
}

async function collectSource(
  source: PublicPortalSource,
  prior: PublicPortalSourceRunStatus | undefined,
  options: FetchOptions,
  index: number,
  total: number,
): Promise<SourceCollection> {
  const checkedAt = new Date();
  const errors: string[] = [];
  await emitProgress(
    options,
    {
      provider: "publicPortalProviders",
      phase: "source_start",
      sourceId: source.id,
      sourceName: source.agencyName,
      index,
      total,
      attempt: 1,
    },
    errors,
  );

  let rawResult: ProviderFetchResult;
  try {
    rawResult = await collectWithRetry(
      source,
      options,
      index,
      total,
      errors,
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    await saveHealthSafely(
      failedPortalStatus(source, prior, new Date(), reason),
      errors,
    );
    errors.unshift(`${source.id}: ${reason}`);
    await emitProgress(
      options,
      {
        provider: "publicPortalProviders",
        phase: "source_failed",
        sourceId: source.id,
        sourceName: source.agencyName,
        index,
        total,
        error: reason,
        recordCount: 0,
      },
      errors,
    );
    return {
      source,
      partition: {
        matched: [],
        deferred: [],
        rejectedSamples: [],
        rawCount: 0,
        matchedCount: 0,
        rejectedCount: 0,
        deferredByReason: { thin_snippet: 0, query_terms_absent: 0 },
      },
      records: [],
      errors,
    };
  }

  const normalized = rawResult.records.map((record) =>
    normalizeSourceRecord(record, source),
  );
  const partition = partitionProviderRecordsForQuery(
    normalized,
    options.keywords,
    QUERY_REJECTION_SAMPLE_LIMIT,
  );
  errors.push(...rawResult.errors);
  const failedWithoutAnyRows =
    partition.rawCount === 0 && rawResult.errors.length > 0;
  const status = failedWithoutAnyRows
    ? failedPortalStatus(
        source,
        prior,
        checkedAt,
        rawResult.errors.join("; "),
      )
    : successfulYieldStatus(
        source,
        prior,
        checkedAt,
        partition.rawCount,
        partition.matchedCount,
      );
  await saveHealthSafely(status, errors);

  await emitProgress(
    options,
    {
      provider: "publicPortalProviders",
      phase: failedWithoutAnyRows ? "source_failed" : "source_complete",
      sourceId: source.id,
      sourceName: source.agencyName,
      index,
      total,
      recordCount: partition.rawCount,
      error: failedWithoutAnyRows ? rawResult.errors.join("; ") : undefined,
    },
    errors,
  );

  return {
    source,
    partition,
    // Query non-matches are deferred, not dropped: the fair merge admits them only after every source's matches.
    records: [...partition.matched, ...partition.deferred],
    errors,
  };
}

function uniqueInventory(): PublicPortalSource[] {
  const byId = new Map<string, PublicPortalSource>();
  for (const source of publishedPortalInventory.getSources()) {
    if (isRegisteredPublicPortalAdapter(source.id)) byId.set(source.id, source);
  }
  return Array.from(byId.values());
}

export class AuditedPublicPortalProvider implements DataSourceProvider {
  readonly name = "publicPortalProviders" as const;
  private readonly inventory = uniqueInventory();
  private lastAttempt?: Date;
  private lastSuccess?: Date;
  private recordCount = 0;
  private lastError?: string;

  async getRunnableSources(): Promise<PublicPortalSource[]> {
    return this.inventory.filter(isRunnableSource);
  }

  async isConfigured(): Promise<boolean> {
    return (await this.getRunnableSources()).length > 0;
  }

  getSources(): PublicPortalSource[] {
    return [...this.inventory];
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    this.lastAttempt = new Date();
    const statuses = await loadPublicPortalHealth().catch(
      () => new Map<string, PublicPortalSourceRunStatus>(),
    );
    const runnable = await this.getRunnableSources();
    const dedicatedIds = new Set(runnable.map((source) => source.id));
    const selection = selectFairPortalSources(
      runnable,
      statuses,
      ROTATION_BATCH_SIZE,
      dedicatedIds,
    );

    // Deliberately sequential. One adapter owns the network and progress slot at
    // a time, so a timeout or malformed source cannot obscure every other source.
    const collections: SourceCollection[] = [];
    for (let offset = 0; offset < selection.selected.length; offset += 1) {
      if (options.signal?.aborted) {
        const reason = options.signal.reason;
        throw reason instanceof Error ? reason : new Error("Portal run cancelled");
      }
      const source = selection.selected[offset];
      if (!source) continue;
      collections.push(
        await collectSource(
          source,
          statuses.get(source.id),
          options,
          offset + 1,
          selection.selected.length,
        ),
      );
    }

    const requestedLimit = Math.min(
      RESULT_LIMIT,
      Math.max(1, options.limit ?? RESULT_LIMIT),
    );
    const records = fairMergeOpportunityGroups(
      collections.map((collection) => ({
        sourceId: collection.source.id,
        records: collection.records,
      })),
      requestedLimit,
    );
    const errors = collections.flatMap((collection) => collection.errors);

    this.recordCount = records.length;
    this.lastError = errors.length ? errors.join("; ").slice(0, 2_000) : undefined;
    if (records.length > 0 || errors.length === 0) this.lastSuccess = new Date();

    return {
      records,
      total: collections.reduce(
        (sum, collection) => sum + collection.partition.matchedCount,
        0,
      ),
      errors,
    };
  }

  async getStatus(): Promise<ProviderStatus> {
    const runnableIds = new Set(
      (await this.getRunnableSources()).map((source) => source.id),
    );
    const statuses = Array.from(
      (await loadPublicPortalHealth().catch(
        () => new Map<string, PublicPortalSourceRunStatus>(),
      )).values(),
    ).filter((status) => runnableIds.has(status.sourceId));
    const failures = statuses.filter(
      (status) =>
        status.lastOutcome === "failed" ||
        status.lastOutcome === "validation_failed",
    );
    return {
      name: this.name,
      configured: runnableIds.size > 0,
      healthy: failures.length === 0,
      errorMessage:
        this.lastError ??
        (failures.length
          ? `${failures.length} registered portal adapters are currently failing`
          : undefined),
      recordCount: statuses.reduce(
        (sum, status) => sum + status.matchedCount,
        0,
      ),
      lastAttempt:
        this.lastAttempt ??
        statuses.reduce<Date | undefined>(
          (latest, status) =>
            !latest || status.lastCheckedAt > latest
              ? status.lastCheckedAt
              : latest,
          undefined,
        ),
      lastSuccess: this.lastSuccess,
    };
  }
}

export const auditedPublicPortalProvider = new AuditedPublicPortalProvider();
export { successfulYieldStatus };
