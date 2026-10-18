import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { rfpDb } from "@workspace/db";
import {
  opportunitiesTable,
  opportunityDedupeKeysTable,
  opportunityIngestionRunsTable,
  opportunityIngestionRunSourcesTable,
  opportunityRawRecordsTable,
  opportunitySourceRegistryTable,
  opportunityStagingTable,
  type OpportunityIngestionRun,
} from "@workspace/db/schema/rfp";
import type {
  NormalizedOpportunity,
  ProviderProgressEvent,
} from "../providers/types";
import { normalizedToDbRecord } from "../search/normalization";
import {
  evidenceStrengthFromStored,
  normalizeOpportunityEvidence,
} from "../opportunityEvidence";
import {
  isTransientDatabaseError,
  withTransientDatabaseRetry,
} from "../databaseReliability";
import {
  calculateOpportunityDedupeKeys,
  canonicalizeOpportunityUrl,
  decideOpportunityQuality,
  generatedProviderNativeId,
  providerKeyForOpportunity,
  serializeOpportunity,
  type OpportunityDedupeKey,
} from "./opportunityIdentity";
import {
  fetchOneProvider,
  resolveManualProviders,
  type ProviderRunResult,
} from "./providerRunner";
import {
  classifyIdentityMatch,
  failedProvidersForRetry,
  finalIngestionStatus,
  mergeSourceRefresh,
  opportunityIdentityLockKeys,
  protectedLineageKeys,
  shouldProtectCanonicalFromRefresh,
  STALE_INGESTION_RUN_AFTER_MS,
} from "./pipelineRules";
import { conciseIngestionError } from "./ingestionError";

const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const RETRYABLE_RUN_STATUSES = new Set([
  "completed",
  "completed_with_errors",
  "failed",
]);
const STALE_RUN_RECOVERY_ERROR =
  "Run was marked failed during a later manual start because its durable heartbeat expired.";
export const PROVIDER_DEADLINE_MS = 90_000;
export const PUBLIC_PORTAL_PROVIDER_DEADLINE_MS = 12 * 60 * 1000;
/** The review-queue drain reviews for up to 8 minutes (REVIEW_QUEUE_TIME_BUDGET_MS) and then stages results. */
export const REVIEW_QUEUE_PROVIDER_DEADLINE_MS = 10 * 60 * 1000;
export const RUN_DEADLINE_MS = 20 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 5_000;
const activeRunControllers = new Map<string, AbortController>();

export class ActiveIngestionRunError extends Error {
  constructor(public readonly runId: string) {
    super(`An ingestion run is already active: ${runId}`);
  }
}

export class IngestionRunNotRetryableError extends Error {}

export interface StartIngestionRequest {
  keywords?: string;
  dateRange?: number;
  providers?: string[];
  retryOfRunId?: string;
}

export interface ProcessingCounts {
  staged: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  created: number;
  updated: number;
}

export interface IngestionRunView extends OpportunityIngestionRun {
  sources: Array<typeof opportunityIngestionRunSourcesTable.$inferSelect>;
  providerErrors: Array<{ provider: string; error: string }>;
}

export type ProviderFetcher = (
  provider: string,
  options: {
    keywords?: string;
    dateRange?: number;
    signal?: AbortSignal;
    onProgress?: (event: ProviderProgressEvent) => void | Promise<void>;
  },
) => Promise<ProviderRunResult>;

function providerDisplayName(provider: string): string {
  if (provider === "reviewQueue") return "AI Review Queue";
  if (provider === "aiDiscovery") return "AI Opportunity Discovery";
  if (provider === "tango") return "Tango Federal Opportunities";
  if (provider === "samGov") return "SAM.gov Official API";
  return provider;
}

const conciseError = conciseIngestionError;

function evidenceFromRecord(
  record: NormalizedOpportunity,
): Record<string, unknown> | null {
  const raw = record.rawData ?? {};
  const evidenceEntries = Object.entries(raw).filter(([key]) =>
    /evidence|document|portal|source|url|extracted|tenant|platform|response/i.test(
      key,
    ),
  );
  return evidenceEntries.length > 0
    ? Object.fromEntries(evidenceEntries)
    : null;
}

function toStagingJson(record: NormalizedOpportunity): Record<string, unknown> {
  return serializeOpportunity(record);
}

async function getRunRow(runId: string) {
  const [run] = await rfpDb
    .select()
    .from(opportunityIngestionRunsTable)
    .where(eq(opportunityIngestionRunsTable.id, runId))
    .limit(1);
  return run ?? null;
}

export async function getIngestionRun(
  runId: string,
): Promise<IngestionRunView | null> {
  const run = await getRunRow(runId);
  if (!run) return null;
  const sources = await rfpDb
    .select()
    .from(opportunityIngestionRunSourcesTable)
    .where(eq(opportunityIngestionRunSourcesTable.runId, runId))
    .orderBy(opportunityIngestionRunSourcesTable.position);
  return {
    ...run,
    sources,
    providerErrors: sources
      .filter((source) => source.error)
      .map((source) => ({ provider: source.provider, error: source.error! })),
  };
}

export async function getCurrentIngestionRun(): Promise<IngestionRunView | null> {
  const [run] = await rfpDb
    .select()
    .from(opportunityIngestionRunsTable)
    .orderBy(desc(opportunityIngestionRunsTable.createdAt))
    .limit(1);
  return run ? getIngestionRun(run.id) : null;
}

export async function listRecentIngestionRuns(
  limit = 20,
): Promise<IngestionRunView[]> {
  const runs = await rfpDb
    .select()
    .from(opportunityIngestionRunsTable)
    .orderBy(desc(opportunityIngestionRunsTable.createdAt))
    .limit(Math.min(50, Math.max(1, limit)));
  return Promise.all(
    runs.map((run) => getIngestionRun(run.id) as Promise<IngestionRunView>),
  );
}

async function createPersistedRun(
  request: StartIngestionRequest,
): Promise<IngestionRunView> {
  const providers = resolveManualProviders(request.providers);
  const runId = randomUUID();
  const now = new Date();

  await rfpDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('manual-rfp-ingestion-active-run', 0))`,
    );
    const staleBefore = new Date(now.getTime() - STALE_INGESTION_RUN_AFTER_MS);
    const staleRuns = await tx
      .update(opportunityIngestionRunsTable)
      .set({
        status: "failed",
        currentProvider: null,
        errors: sql`coalesce(${opportunityIngestionRunsTable.errors}, '[]'::jsonb) || ${JSON.stringify([STALE_RUN_RECOVERY_ERROR])}::jsonb`,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          inArray(opportunityIngestionRunsTable.status, [
            ...ACTIVE_RUN_STATUSES,
          ]),
          lte(
            sql`coalesce(${opportunityIngestionRunsTable.heartbeatAt}, ${opportunityIngestionRunsTable.updatedAt})`,
            staleBefore,
          ),
        ),
      )
      .returning({ id: opportunityIngestionRunsTable.id });

    if (staleRuns.length > 0) {
      await tx
        .update(opportunityIngestionRunSourcesTable)
        .set({
          status: "failed",
          error: STALE_RUN_RECOVERY_ERROR,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            inArray(
              opportunityIngestionRunSourcesTable.runId,
              staleRuns.map((run) => run.id),
            ),
            inArray(opportunityIngestionRunSourcesTable.status, [
              ...ACTIVE_RUN_STATUSES,
            ]),
          ),
        );
    }

    const [active] = await tx
      .select({ id: opportunityIngestionRunsTable.id })
      .from(opportunityIngestionRunsTable)
      .where(
        inArray(opportunityIngestionRunsTable.status, [...ACTIVE_RUN_STATUSES]),
      )
      .limit(1);
    if (active) throw new ActiveIngestionRunError(active.id);

    await tx.insert(opportunityIngestionRunsTable).values({
      id: runId,
      status: "queued",
      selectedProviders: providers,
      query: request.keywords?.trim() || null,
      dateRange: request.dateRange ?? null,
      retryOfRunId: request.retryOfRunId ?? null,
      providersTotal: providers.length,
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      statusMessage: "Queued manual ingestion run",
    });
    await tx.insert(opportunityIngestionRunSourcesTable).values(
      providers.map((provider, position) => ({
        id: randomUUID(),
        runId,
        provider,
        position,
        status: "queued" as const,
        updatedAt: now,
      })),
    );
  });

  return (await getIngestionRun(runId))!;
}

async function findExistingOpportunity(
  tx: any,
  record: NormalizedOpportunity,
  keys: OpportunityDedupeKey[],
): Promise<{
  opportunityId: string;
  matchType: OpportunityDedupeKey["type"];
} | null> {
  if (keys.length > 0) {
    const rows = await tx
      .select({
        opportunityId: opportunityDedupeKeysTable.opportunityId,
        dedupeKey: opportunityDedupeKeysTable.dedupeKey,
      })
      .from(opportunityDedupeKeysTable)
      .where(
        inArray(
          opportunityDedupeKeysTable.dedupeKey,
          keys.map((key) => key.value),
        ),
      );
    const match = classifyIdentityMatch(
      keys,
      new Map(
        rows.map((row: { dedupeKey: string; opportunityId: string }) => [
          row.dedupeKey,
          row.opportunityId,
        ]),
      ),
    );
    if (match) return match;
  }

  const providerKey = providerKeyForOpportunity(record);
  const providerNativeId = generatedProviderNativeId(record);
  const [providerMatch] = await tx
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.providerKey, providerKey),
        eq(opportunitiesTable.noticeId, providerNativeId),
      ),
    )
    .limit(1);
  if (providerMatch)
    return { opportunityId: providerMatch.id, matchType: "provider" };

  if (record.solicitationNumber?.trim() && record.agency?.trim()) {
    const [solicitationMatch] = await tx
      .select({ id: opportunitiesTable.id })
      .from(opportunitiesTable)
      .where(
        and(
          sql`lower(regexp_replace(coalesce(${opportunitiesTable.solicitationNumber}, ''), '[^a-zA-Z0-9]', '', 'g')) = ${record.solicitationNumber.replace(/[^a-z0-9]/gi, "").toLowerCase()}`,
          sql`lower(regexp_replace(${opportunitiesTable.agency}, '[^a-zA-Z0-9]+', ' ', 'g')) = ${record.agency
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim()}`,
        ),
      )
      .limit(1);
    if (solicitationMatch)
      return { opportunityId: solicitationMatch.id, matchType: "solicitation" };
  }

  const canonicalUrl = canonicalizeOpportunityUrl(record.sourceUrl);
  if (canonicalUrl) {
    const [urlMatch] = await tx
      .select({ id: opportunitiesTable.id })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.samUrl, canonicalUrl))
      .limit(1);
    if (urlMatch) return { opportunityId: urlMatch.id, matchType: "url" };
  }
  return null;
}

async function registerLineage(
  tx: any,
  opportunityId: string,
  provider: string,
  providerNativeId: string,
  sourceUrl: string | undefined,
  rawRecordId: string,
  keys: OpportunityDedupeKey[],
  now: Date,
) {
  const [existingSource] = await tx
    .select({ id: opportunitySourceRegistryTable.id })
    .from(opportunitySourceRegistryTable)
    .where(
      and(
        eq(opportunitySourceRegistryTable.provider, provider),
        eq(opportunitySourceRegistryTable.providerNativeId, providerNativeId),
      ),
    )
    .limit(1);
  if (existingSource) {
    await tx
      .update(opportunitySourceRegistryTable)
      .set({
        opportunityId,
        sourceUrl: sourceUrl ?? null,
        canonicalUrl: canonicalizeOpportunityUrl(sourceUrl),
        latestRawRecordId: rawRecordId,
        lastSeenAt: now,
      })
      .where(eq(opportunitySourceRegistryTable.id, existingSource.id));
  } else {
    await tx.insert(opportunitySourceRegistryTable).values({
      id: randomUUID(),
      opportunityId,
      provider,
      providerNativeId,
      sourceUrl: sourceUrl ?? null,
      canonicalUrl: canonicalizeOpportunityUrl(sourceUrl),
      latestRawRecordId: rawRecordId,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  for (const key of keys) {
    await tx
      .insert(opportunityDedupeKeysTable)
      .values({
        id: randomUUID(),
        opportunityId,
        keyType: key.type,
        dedupeKey: key.value,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: opportunityDedupeKeysTable.dedupeKey,
        set: { lastSeenAt: now },
      });
  }
}

async function processOneRecord(
  runId: string,
  runSourceId: string,
  provider: string,
  record: NormalizedOpportunity,
): Promise<Omit<ProcessingCounts, "staged"> & { staged: 1 }> {
  const now = new Date();
  const rawRecordId = randomUUID();
  const stagingId = randomUUID();
  const providerNativeId = generatedProviderNativeId(record);
  const keys = calculateOpportunityDedupeKeys({
    ...record,
    externalId: providerNativeId,
  });
  const quality = decideOpportunityQuality(record);

  return rfpDb.transaction(async (tx) => {
    await tx.insert(opportunityRawRecordsTable).values({
      id: rawRecordId,
      runId,
      runSourceId,
      provider,
      providerNativeId,
      sourceUrl: record.sourceUrl ?? null,
      providerRecord: serializeOpportunity(record),
      sourceEvidence: evidenceFromRecord(record),
      collectedAt: now,
    });
    await tx.insert(opportunityStagingTable).values({
      id: stagingId,
      runId,
      rawRecordId,
      provider,
      providerNativeId,
      title: record.title ?? null,
      agency: record.agency ?? null,
      solicitationNumber: record.solicitationNumber ?? null,
      sourceUrl: record.sourceUrl ?? null,
      postedDate: record.postedDate ?? null,
      responseDeadline: record.responseDeadline ?? null,
      normalizedRecord: toStagingJson(record),
      qualityStatus: "pending",
      completenessScore: String(quality.completenessScore),
      sourceConfidence: String(quality.sourceConfidence),
      dedupeKeys: keys.map((key) => key.value),
      createdAt: now,
      updatedAt: now,
    });

    if (quality.status !== "accepted") {
      await tx
        .update(opportunityStagingTable)
        .set({
          qualityStatus: quality.status,
          qualityReason: quality.reason,
          updatedAt: now,
        })
        .where(eq(opportunityStagingTable.id, stagingId));
      return {
        staged: 1,
        accepted: 0,
        rejected: 1,
        duplicates: 0,
        created: 0,
        updated: 0,
      };
    }

    const lockKeys = opportunityIdentityLockKeys(
      keys,
      `${provider}:${providerNativeId}`,
    );
    for (const lockKey of lockKeys) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
    }
    const existing = await findExistingOpportunity(
      tx,
      { ...record, externalId: providerNativeId },
      keys,
    );
    let existingCanonical: typeof opportunitiesTable.$inferSelect | undefined;
    if (existing) {
      [existingCanonical] = await tx
        .select()
        .from(opportunitiesTable)
        .where(eq(opportunitiesTable.id, existing.opportunityId))
        .limit(1);
    }
    const incomingEvidence = normalizeOpportunityEvidence(record);
    const existingStrength = existingCanonical
      ? evidenceStrengthFromStored(existingCanonical)
      : 0;
    const incomingWeakensCanonical = Boolean(
      existingCanonical && incomingEvidence.strength < existingStrength,
    );
    const protectedDuplicate =
      existing &&
      (incomingWeakensCanonical ||
        shouldProtectCanonicalFromRefresh(
          existing.matchType,
          record.rawData?.fallback === true ||
            incomingEvidence.evidenceType === "discovery" ||
            incomingEvidence.evidenceType === "aggregator" ||
            incomingEvidence.evidenceType === "landing-page",
        ));
    let opportunityId = existing?.opportunityId ?? randomUUID();
    let created = 0;
    let updated = 0;

    if (protectedDuplicate) {
      await registerLineage(
        tx,
        opportunityId,
        provider,
        providerNativeId,
        record.sourceUrl,
        rawRecordId,
        protectedLineageKeys(keys, existing.matchType),
        now,
      );
      await tx
        .update(opportunityStagingTable)
        .set({
          qualityStatus: "duplicate",
          qualityReason: incomingWeakensCanonical
            ? `Weaker ${incomingEvidence.evidenceType} record resolved to stronger canonical opportunity by ${existing.matchType} identity without refreshing canonical fields.`
            : record.rawData?.fallback === true
              ? `Fallback record resolved to canonical opportunity by ${existing.matchType} identity without refreshing canonical fields.`
              : `Resolved to canonical opportunity by ${existing.matchType} identity.`,
          canonicalOpportunityId: opportunityId,
          updatedAt: now,
        })
        .where(eq(opportunityStagingTable.id, stagingId));
      return {
        staged: 1,
        accepted: 0,
        rejected: 0,
        duplicates: 1,
        created: 0,
        updated: 0,
      };
    }

    const normalized = normalizedToDbRecord({
      ...record,
      externalId: providerNativeId,
    });
    if (existing && existingCanonical) {
      const merged = mergeSourceRefresh(
        existingCanonical as unknown as Record<string, unknown>,
        {
          ...normalized,
          noticeId: providerNativeId,
          providerKey: providerKeyForOpportunity(record),
          samUrl:
            canonicalizeOpportunityUrl(record.sourceUrl) ?? normalized.samUrl,
          lastSeenAt: now,
          updatedAt: now,
        } as unknown as Record<string, unknown>,
      ) as typeof existingCanonical;
      const {
        id: _id,
        createdAt: _createdAt,
        firstSeenAt: _firstSeenAt,
        ...refreshFields
      } = merged;
      await tx
        .update(opportunitiesTable)
        .set(refreshFields)
        .where(eq(opportunitiesTable.id, opportunityId));
      updated = 1;
    } else {
      await tx.insert(opportunitiesTable).values({
        ...normalized,
        id: opportunityId,
        noticeId: providerNativeId,
        providerKey: providerKeyForOpportunity(record),
        samUrl:
          canonicalizeOpportunityUrl(record.sourceUrl) ?? normalized.samUrl,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      created = 1;
    }

    await registerLineage(
      tx,
      opportunityId,
      provider,
      providerNativeId,
      record.sourceUrl,
      rawRecordId,
      keys,
      now,
    );
    await tx
      .update(opportunityStagingTable)
      .set({
        qualityStatus: "accepted",
        qualityReason: existing
          ? `Canonical opportunity refreshed by ${existing.matchType} identity.`
          : null,
        canonicalOpportunityId: opportunityId,
        updatedAt: now,
      })
      .where(eq(opportunityStagingTable.id, stagingId));
    return {
      staged: 1,
      accepted: 1,
      rejected: 0,
      duplicates: 0,
      created,
      updated,
    };
  });
}

async function incrementProgress(
  runId: string,
  runSourceId: string,
  counts: ProcessingCounts,
) {
  const now = new Date();
  await rfpDb.transaction(async (tx) => {
    await tx
      .update(opportunityIngestionRunSourcesTable)
      .set({
        staged: sql`${opportunityIngestionRunSourcesTable.staged} + ${counts.staged}`,
        accepted: sql`${opportunityIngestionRunSourcesTable.accepted} + ${counts.accepted}`,
        rejected: sql`${opportunityIngestionRunSourcesTable.rejected} + ${counts.rejected}`,
        duplicates: sql`${opportunityIngestionRunSourcesTable.duplicates} + ${counts.duplicates}`,
        created: sql`${opportunityIngestionRunSourcesTable.created} + ${counts.created}`,
        updated: sql`${opportunityIngestionRunSourcesTable.updated} + ${counts.updated}`,
        updatedAt: now,
      })
      .where(eq(opportunityIngestionRunSourcesTable.id, runSourceId));
    await tx
      .update(opportunityIngestionRunsTable)
      .set({
        staged: sql`${opportunityIngestionRunsTable.staged} + ${counts.staged}`,
        accepted: sql`${opportunityIngestionRunsTable.accepted} + ${counts.accepted}`,
        rejected: sql`${opportunityIngestionRunsTable.rejected} + ${counts.rejected}`,
        duplicates: sql`${opportunityIngestionRunsTable.duplicates} + ${counts.duplicates}`,
        created: sql`${opportunityIngestionRunsTable.created} + ${counts.created}`,
        updated: sql`${opportunityIngestionRunsTable.updated} + ${counts.updated}`,
        updatedAt: now,
      })
      .where(eq(opportunityIngestionRunsTable.id, runId));
  });
}

export async function reconcileExpiredOpportunities(
  now = new Date(),
): Promise<number> {
  const archived = await rfpDb
    .update(opportunitiesTable)
    .set({ status: "archived", updatedAt: now })
    .where(
      and(
        eq(opportunitiesTable.status, "active"),
        lt(opportunitiesTable.responseDeadline, now),
      ),
    )
    .returning({ id: opportunitiesTable.id });
  return archived.length;
}

function databaseRetryLog(details: {
  label: string;
  attempt: number;
  delayMs: number;
  error: unknown;
}): void {
  console.warn(
    JSON.stringify({
      event: "rfp_database_retry",
      label: details.label,
      attempt: details.attempt,
      delayMs: details.delayMs,
      error: conciseError(details.error),
    }),
  );
}

async function heartbeat(
  runId: string,
  message: string,
  currentProvider: string | null,
): Promise<void> {
  const now = new Date();
  await withTransientDatabaseRetry(
    `ingestion heartbeat ${runId}`,
    () =>
      rfpDb
        .update(opportunityIngestionRunsTable)
        .set({
          heartbeatAt: now,
          updatedAt: now,
          statusMessage: message,
          currentProvider,
        })
        .where(eq(opportunityIngestionRunsTable.id, runId))
        .then(() => undefined),
    { attempts: 3, onRetry: databaseRetryLog },
  );
  console.info(
    JSON.stringify({
      event: "rfp_ingestion_heartbeat",
      runId,
      currentProvider,
      message,
    }),
  );
}

async function safeHeartbeat(
  runId: string,
  message: string,
  currentProvider: string | null,
): Promise<void> {
  try {
    await heartbeat(runId, message, currentProvider);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "rfp_ingestion_heartbeat_failed",
        runId,
        currentProvider,
        message,
        transient: isTransientDatabaseError(error),
        error: conciseError(error),
      }),
    );
  }
}

async function cancellationRequested(runId: string): Promise<boolean> {
  try {
    const run = await withTransientDatabaseRetry(
      `read cancellation ${runId}`,
      () => getRunRow(runId),
      { attempts: 2, onRetry: databaseRetryLog },
    );
    return !!run?.cancellationRequestedAt;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "rfp_cancellation_read_failed",
        runId,
        transient: isTransientDatabaseError(error),
        error: conciseError(error),
      }),
    );
    return false;
  }
}

class ProviderTimeoutError extends Error {
  constructor(
    public readonly provider: string,
    public readonly elapsedMs: number,
  ) {
    super(`Provider ${provider} timed out after ${elapsedMs}ms`);
  }
}
class RunCancelledError extends Error {
  constructor() {
    super("Ingestion run cancellation requested");
  }
}
class RunTimeoutError extends Error {
  constructor() {
    super(`Ingestion run exceeded ${RUN_DEADLINE_MS}ms maximum duration`);
  }
}

function providerDeadlineMs(provider: string): number {
  if (provider === "reviewQueue") return REVIEW_QUEUE_PROVIDER_DEADLINE_MS;
  return provider === "publicPortalProviders"
    ? PUBLIC_PORTAL_PROVIDER_DEADLINE_MS
    : PROVIDER_DEADLINE_MS;
}

export function formatProviderProgress(event: ProviderProgressEvent): {
  currentProvider: string;
  message: string;
} {
  const source = event.sourceName || event.sourceId || event.provider;
  const position =
    event.index && event.total ? `${event.index}/${event.total}` : undefined;
  const prefix = position ? `Adapter ${position}` : "Adapter";
  const currentProvider = event.sourceId
    ? `${event.provider}:${event.sourceId}`
    : event.provider;

  if (event.phase === "source_start") {
    return { currentProvider, message: `${prefix}: ${source}` };
  }
  if (event.phase === "source_retry") {
    return {
      currentProvider,
      message: `Retrying ${prefix.toLowerCase()}: ${source} (attempt ${event.attempt ?? 2})`,
    };
  }
  if (event.phase === "source_failed") {
    return {
      currentProvider,
      message: `${prefix} failed: ${source}; continuing to the next adapter`,
    };
  }
  if (event.phase === "source_complete") {
    return {
      currentProvider,
      message: `${prefix} completed: ${source} (${event.recordCount ?? 0} records)`,
    };
  }
  if (event.phase === "discovery_start") {
    return {
      currentProvider,
      message:
        "AI/web discovery is running once for this Fetch Intelligence run",
    };
  }
  return {
    currentProvider,
    message: `AI/web discovery completed (${event.recordCount ?? 0} records)`,
  };
}

async function runProviderWithDeadline(
  runId: string,
  provider: string,
  runSignal: AbortSignal,
  fetcher: ProviderFetcher,
  options: { keywords?: string; dateRange?: number },
): Promise<ProviderRunResult> {
  const controller = new AbortController();
  const abortFromRun = () =>
    controller.abort(runSignal.reason ?? new RunCancelledError());
  if (runSignal.aborted) abortFromRun();
  runSignal.addEventListener("abort", abortFromRun, { once: true });
  const deadlineMs = providerDeadlineMs(provider);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let progressMessage = `Still waiting for ${providerDisplayName(provider)}`;
  let progressProvider: string | null = provider;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new ProviderTimeoutError(provider, deadlineMs);
      controller.abort(error);
      reject(error);
    }, deadlineMs);
    timeout.unref?.();
  });
  const beat = setInterval(() => {
    void safeHeartbeat(runId, progressMessage, progressProvider);
  }, HEARTBEAT_INTERVAL_MS);
  beat.unref?.();

  const providerPromise = fetcher(provider, {
    ...options,
    signal: controller.signal,
    onProgress: async (event) => {
      const formatted = formatProviderProgress(event);
      progressMessage = formatted.message;
      progressProvider = formatted.currentProvider;
      await safeHeartbeat(runId, progressMessage, progressProvider);
    },
  });
  providerPromise.catch((error) => {
    if (!controller.signal.aborted) {
      console.warn(
        JSON.stringify({
          event: "rfp_provider_late_rejection",
          runId,
          provider,
          error: conciseError(error),
        }),
      );
    }
  });
  try {
    return await Promise.race([providerPromise, deadline]);
  } catch (error) {
    if (controller.signal.aborted && error instanceof ProviderTimeoutError)
      throw error;
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof ProviderTimeoutError
    )
      throw controller.signal.reason;
    if (runSignal.aborted) {
      const reason = runSignal.reason;
      if (
        reason instanceof RunTimeoutError ||
        reason instanceof RunCancelledError
      ) {
        throw reason;
      }
      throw new RunCancelledError();
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    clearInterval(beat);
    runSignal.removeEventListener("abort", abortFromRun);
  }
}

async function executePersistedRun(
  runId: string,
  providerFetcher: ProviderFetcher,
): Promise<void> {
  const run = await getIngestionRun(runId);
  if (!run) throw new Error(`Ingestion run not found: ${runId}`);
  const runController = new AbortController();
  activeRunControllers.set(runId, runController);
  const runTimeout = setTimeout(
    () => runController.abort(new RunTimeoutError()),
    RUN_DEADLINE_MS,
  );
  runTimeout.unref?.();
  const runErrors: string[] = [];
  let cancelled = false;
  let timedOut = false;
  let failedCount = 0;
  let timeoutCount = 0;
  const now = new Date();
  try {
    await rfpDb
      .update(opportunityIngestionRunsTable)
      .set({
        status: "running",
        startedAt: now,
        updatedAt: now,
        heartbeatAt: now,
        statusMessage: "Manual ingestion started",
      })
      .where(eq(opportunityIngestionRunsTable.id, runId));
    for (const source of run.sources) {
      if (runController.signal.aborted) throw runController.signal.reason;
      if (await cancellationRequested(runId)) throw new RunCancelledError();
      const startedAt = new Date();
      console.info(
        JSON.stringify({
          event: "rfp_provider_start",
          runId,
          provider: source.provider,
        }),
      );
      await rfpDb.transaction(async (tx) => {
        await tx
          .update(opportunityIngestionRunSourcesTable)
          .set({ status: "running", startedAt, updatedAt: startedAt })
          .where(eq(opportunityIngestionRunSourcesTable.id, source.id));
        await tx
          .update(opportunityIngestionRunsTable)
          .set({
            currentProvider: source.provider,
            heartbeatAt: startedAt,
            updatedAt: startedAt,
            statusMessage: `Running ${providerDisplayName(source.provider)}`,
          })
          .where(eq(opportunityIngestionRunsTable.id, runId));
      });
      let sourceError: string | null = null;
      let sourceStatus: "completed" | "failed" | "timed_out" | "cancelled" =
        "completed";
      try {
        const result = await runProviderWithDeadline(
          runId,
          source.provider,
          runController.signal,
          providerFetcher,
          {
            keywords: run.query ?? undefined,
            dateRange: run.dateRange ?? undefined,
          },
        );
        await rfpDb.transaction(async (tx) => {
          await tx
            .update(opportunityIngestionRunSourcesTable)
            .set({ fetched: result.records.length, updatedAt: new Date() })
            .where(eq(opportunityIngestionRunSourcesTable.id, source.id));
          await tx
            .update(opportunityIngestionRunsTable)
            .set({
              fetched: sql`${opportunityIngestionRunsTable.fetched} + ${result.records.length}`,
              heartbeatAt: new Date(),
              updatedAt: new Date(),
              statusMessage: `Processing ${result.records.length} ${source.provider} records`,
            })
            .where(eq(opportunityIngestionRunsTable.id, runId));
        });
        const recordErrors: string[] = [];
        for (const [recordIndex, record] of result.records.entries()) {
          if (runController.signal.aborted) {
            throw runController.signal.reason ?? new RunCancelledError();
          }
          if (await cancellationRequested(runId)) throw new RunCancelledError();
          try {
            const counts = await processOneRecord(
              runId,
              source.id,
              source.provider,
              record,
            );
            await incrementProgress(runId, source.id, counts);
          } catch (error) {
            if (runController.signal.aborted) throw error;
            const identity =
              record.solicitationNumber ||
              record.externalId ||
              `record ${recordIndex + 1}`;
            const message = `${identity}: ${conciseError(error)}`;
            recordErrors.push(message);
            console.error(
              JSON.stringify({
                event: "rfp_record_persistence_failed",
                runId,
                provider: source.provider,
                recordIndex,
                identity,
                error: conciseError(error),
              }),
            );
          }
        }
        const providerWarnings = [
          ...result.errors.map(conciseError),
          ...recordErrors,
        ];
        if (providerWarnings.length > 0) {
          sourceError = providerWarnings.join(" | ").slice(0, 500);
        }
      } catch (error) {
        if (error instanceof RunCancelledError) {
          cancelled = true;
          sourceStatus = "cancelled";
          sourceError = error.message;
        } else if (error instanceof RunTimeoutError) {
          timedOut = true;
          sourceStatus = "timed_out";
          sourceError = error.message;
        } else if (error instanceof ProviderTimeoutError) {
          sourceStatus = "timed_out";
          sourceError = error.message;
          timeoutCount += 1;
        } else {
          sourceStatus = "failed";
          sourceError = conciseError(error);
          failedCount += 1;
        }
      }
      const completedAt = new Date();
      if (sourceError) runErrors.push(`[${source.provider}] ${sourceError}`);
      console.info(
        JSON.stringify({
          event: "rfp_provider_finish",
          runId,
          provider: source.provider,
          status: sourceStatus,
          elapsedMs: completedAt.getTime() - startedAt.getTime(),
          error: sourceError,
        }),
      );
      await rfpDb.transaction(async (tx) => {
        await tx
          .update(opportunityIngestionRunSourcesTable)
          .set({
            status: sourceStatus,
            error: sourceError,
            elapsedMs: completedAt.getTime() - startedAt.getTime(),
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(opportunityIngestionRunSourcesTable.id, source.id));
        await tx
          .update(opportunityIngestionRunsTable)
          .set({
            providersCompleted: sql`${opportunityIngestionRunsTable.providersCompleted} + 1`,
            providersFailed: failedCount,
            providersTimedOut: timeoutCount,
            errors: runErrors,
            heartbeatAt: completedAt,
            updatedAt: completedAt,
            statusMessage: `${providerDisplayName(source.provider)} ${sourceStatus}`,
          })
          .where(eq(opportunityIngestionRunsTable.id, runId));
      });
      if (cancelled || timedOut) break;
    }
  } catch (error) {
    if (error instanceof RunCancelledError) {
      cancelled = true;
      runErrors.push(error.message);
    } else if (error instanceof RunTimeoutError) {
      timedOut = true;
      runErrors.push(error.message);
    } else runErrors.push(conciseError(error));
  } finally {
    clearTimeout(runTimeout);
    activeRunControllers.delete(runId);
    const archived =
      cancelled || timedOut
        ? 0
        : await reconcileExpiredOpportunities().catch(() => 0);
    const latest = await getIngestionRun(runId).catch(() => null);
    const failedSources =
      latest?.sources.filter((source) => source.status === "failed").length ??
      failedCount;
    const timedOutSources =
      latest?.sources.filter((source) => source.status === "timed_out")
        .length ?? timeoutCount;
    const warningSources =
      latest?.sources.filter(
        (source) => source.status === "completed" && Boolean(source.error),
      ).length ?? 0;
    const finalStatus = finalIngestionStatus({
      cancelled,
      timedOut,
      totalSources: run.sources.length,
      failedSources,
      timedOutSources,
      warningSources,
    });
    const completedAt = new Date();
    console.info(
      JSON.stringify({
        event: "rfp_run_finalized",
        runId,
        status: finalStatus,
        errors: runErrors.length,
      }),
    );
    await withTransientDatabaseRetry(
      `finalize ingestion ${runId}`,
      () =>
        rfpDb
          .update(opportunityIngestionRunsTable)
          .set({
            status: finalStatus,
            currentProvider: null,
            archived,
            errors: runErrors,
            completedAt,
            heartbeatAt: completedAt,
            updatedAt: completedAt,
            statusMessage: `Manual ingestion ${finalStatus}`,
          })
          .where(eq(opportunityIngestionRunsTable.id, runId))
          .then(() => undefined),
      { attempts: 4, delaysMs: [500, 1_500, 3_000], onRetry: databaseRetryLog },
    );
  }
}

async function markBackgroundRunFailed(
  runId: string,
  error: unknown,
): Promise<void> {
  const message = conciseError(error);
  const completedAt = new Date();
  try {
    await withTransientDatabaseRetry(
      `mark ingestion failed ${runId}`,
      () =>
        rfpDb
          .update(opportunityIngestionRunsTable)
          .set({
            status: "failed",
            currentProvider: null,
            statusMessage: STALE_RUN_RECOVERY_ERROR,
            errors: [message],
            completedAt,
            heartbeatAt: completedAt,
            updatedAt: completedAt,
          })
          .where(eq(opportunityIngestionRunsTable.id, runId))
          .then(() => undefined),
      { attempts: 4, delaysMs: [500, 1_500, 3_000], onRetry: databaseRetryLog },
    );
  } catch (persistenceError) {
    console.error(
      JSON.stringify({
        event: "rfp_background_failure_persistence_failed",
        runId,
        originalError: message,
        persistenceError: conciseError(persistenceError),
      }),
    );
  }
}

export async function startManualIngestion(
  request: StartIngestionRequest,
  providerFetcher: ProviderFetcher = fetchOneProvider,
): Promise<IngestionRunView> {
  const run = await createPersistedRun(request);
  queueMicrotask(() => {
    void executePersistedRun(run.id, providerFetcher).catch((error) => {
      void markBackgroundRunFailed(run.id, error);
    });
  });
  return run;
}

export async function cancelManualIngestion(
  runId: string,
): Promise<IngestionRunView> {
  const now = new Date();
  await withTransientDatabaseRetry(
    `cancel ingestion ${runId}`,
    () =>
      rfpDb
        .update(opportunityIngestionRunsTable)
        .set({
          cancellationRequestedAt: now,
          heartbeatAt: now,
          updatedAt: now,
          statusMessage: "Cancellation requested",
        })
        .where(eq(opportunityIngestionRunsTable.id, runId))
        .then(() => undefined),
    { attempts: 3, onRetry: databaseRetryLog },
  );
  activeRunControllers.get(runId)?.abort(new RunCancelledError());
  return (await getIngestionRun(runId))!;
}

export async function retryFailedProviders(
  runId: string,
  providerFetcher: ProviderFetcher = fetchOneProvider,
): Promise<IngestionRunView> {
  const original = await getIngestionRun(runId);
  if (!original) throw new Error(`Ingestion run not found: ${runId}`);
  if (!RETRYABLE_RUN_STATUSES.has(original.status)) {
    throw new IngestionRunNotRetryableError(
      "Only completed runs can be retried.",
    );
  }
  const retryProviders = failedProvidersForRetry(original.sources);
  if (retryProviders.length === 0) {
    throw new IngestionRunNotRetryableError(
      "This run has no failed, timed-out, or warning-producing providers to retry.",
    );
  }
  return startManualIngestion(
    {
      keywords: original.query ?? undefined,
      dateRange: original.dateRange ?? undefined,
      providers: retryProviders,
      retryOfRunId: original.id,
    },
    providerFetcher,
  );
}
