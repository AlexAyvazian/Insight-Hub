import type { OpportunityDedupeKey } from "./opportunityIdentity";
import { evaluateOpportunityExpiration } from "./opportunityExpiration";
import type { NormalizedOpportunity } from "../providers/types";

export const ACTIVE_INGESTION_STATUSES = new Set(["queued", "running"]);
export const STALE_INGESTION_RUN_AFTER_MS = 30 * 60 * 1000;

const SOURCE_CONFIDENCE_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const CANONICAL_PROVIDER_AUTHORITY: Record<string, number> = {
  samgov: 100,
  sam_gov: 100,
  tango: 15,
  texasesbd: 80,
  nyscr: 80,
  eunabonfire: 80,
  publicportalproviders: 70,
  stateportals: 70,
  internationalpublicportals: 65,
  langsearch: 30,
  serper: 30,
  exa: 30,
  parallel: 30,
  linkup: 30,
  you: 30,
  socrata: 30,
  websearch: 30,
  aidiscovery: 25,
  rssaggregator: 20,
  manual: 10,
};

const CANONICAL_OWNER_FIELDS = new Set([
  "noticeId",
  "providerKey",
  "providerName",
  "source",
  "samUrl",
]);

const PRESERVED_FIELDS = new Set([
  "id",
  "createdAt",
  "firstSeenAt",
  "notes",
  "userGrade",
  "userConfidence",
]);

export function isActiveIngestionStatus(status: string): boolean {
  return ACTIVE_INGESTION_STATUSES.has(status);
}

export function isStaleIngestionRun(
  updatedAt: Date,
  now: Date,
  staleAfterMs = STALE_INGESTION_RUN_AFTER_MS,
): boolean {
  return now.getTime() - updatedAt.getTime() >= staleAfterMs;
}

export function failedProvidersForRetry(
  sources: Array<{ provider: string; status: string; error?: unknown }>,
): string[] {
  return sources
    .filter(
      (source) =>
        source.status === "failed" ||
        source.status === "timed_out" ||
        (source.status === "completed" && Boolean(source.error)),
    )
    .map((source) => source.provider);
}

export function classifyIdentityMatch(
  orderedKeys: OpportunityDedupeKey[],
  knownKeys: ReadonlyMap<string, string>,
): { opportunityId: string; matchType: OpportunityDedupeKey["type"] } | null {
  for (const key of orderedKeys) {
    const opportunityId = knownKeys.get(key.value);
    if (opportunityId) return { opportunityId, matchType: key.type };
  }
  return null;
}

/**
 * A weak identity match (same canonical URL, or same title and buyer) is a separate procurement, not a duplicate,
 * when both records state different solicitation numbers: a re-issued annual contract, or sibling lots listed on
 * one portal page. Strong matches (provider id, solicitation number) are never split.
 */
export function isSeparateProcurement(
  matchType: OpportunityDedupeKey["type"],
  incomingSolicitation: string | null | undefined,
  matchedSolicitation: string | null | undefined,
): boolean {
  if (matchType !== "url" && matchType !== "fingerprint") return false;
  const normalize = (value: string | null | undefined) => (value ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const incoming = normalize(incomingSolicitation);
  const matched = normalize(matchedSolicitation);
  return incoming.length > 0 && matched.length > 0 && incoming !== matched;
}

export function shouldProtectCanonicalFromRefresh(
  matchType: OpportunityDedupeKey["type"],
  fallback: boolean,
): boolean {
  return fallback || matchType === "url" || matchType === "fingerprint";
}

export function protectedLineageKeys(
  keys: OpportunityDedupeKey[],
  matchType: OpportunityDedupeKey["type"],
): OpportunityDedupeKey[] {
  return keys.filter((key) => key.type === matchType);
}

export function opportunityIdentityLockKeys(
  keys: OpportunityDedupeKey[],
  fallbackKey: string,
): string[] {
  const values = Array.from(new Set(keys.map((key) => key.value).filter(Boolean))).sort();
  return values.length > 0 ? values : [fallbackKey];
}

export function canonicalProviderAuthority(value: unknown): number {
  const normalized = String(value ?? "")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase();
  return CANONICAL_PROVIDER_AUTHORITY[normalized] ?? 0;
}

function ownerIdentity(value: Record<string, unknown>): string {
  return String(value.providerName ?? value.providerKey ?? value.source ?? "")
    .trim()
    .toLowerCase();
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function parseTagValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return value
      .split(/[,;|]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function mergeTags(existing: unknown, incoming: unknown): string | unknown {
  const tags = Array.from(new Set([...parseTagValues(existing), ...parseTagValues(incoming)]));
  if (tags.length === 0) return hasMeaningfulValue(incoming) ? incoming : existing;
  return JSON.stringify(tags);
}

function strongerConfidence(existing: unknown, incoming: unknown): unknown {
  const current = String(existing ?? "").toLowerCase();
  const next = String(incoming ?? "").toLowerCase();
  if (!SOURCE_CONFIDENCE_RANK[next]) return existing;
  if (!SOURCE_CONFIDENCE_RANK[current]) return incoming;
  return SOURCE_CONFIDENCE_RANK[next] >= SOURCE_CONFIDENCE_RANK[current]
    ? incoming
    : existing;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function expirationView(record: Record<string, unknown>): NormalizedOpportunity {
  return {
    status: record.status,
    responseDeadline: asDate(record.responseDeadline),
    rawData: (record.rawData ?? undefined) as Record<string, unknown> | undefined,
  } as unknown as NormalizedOpportunity;
}

/**
 * Lifecycle status after a source refresh.
 *
 * Rediscovery is not evidence that an opportunity is open again. A record that
 * is archived/expired stays archived unless the incoming record carries an
 * affirmative, later, still-open response deadline (a genuine extension or
 * re-issue). A record whose merged state is expired (past deadline, closed or
 * awarded source status) is archived rather than left active. Authority of the
 * rediscovering provider is irrelevant to lifecycle status.
 */
function refreshedStatus(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  merged: Record<string, unknown>,
  now: Date,
): unknown {
  const wasClosed =
    existing.status === "archived" ||
    evaluateOpportunityExpiration(expirationView(existing), now).expired;
  if (wasClosed) {
    const incomingDeadline = asDate(incoming.responseDeadline);
    const existingDeadline = asDate(existing.responseDeadline);
    const extended =
      incomingDeadline !== null &&
      (existingDeadline === null || incomingDeadline.getTime() > existingDeadline.getTime()) &&
      !evaluateOpportunityExpiration(
        expirationView({ ...incoming, status: incoming.status ?? "active" }),
        now,
      ).expired;
    if (!extended) return "archived";
  }
  if (evaluateOpportunityExpiration(expirationView(merged), now).expired) return "archived";
  return merged.status;
}

export function mergeSourceRefresh<T extends Record<string, unknown>>(
  existing: T,
  sourceFields: T,
  now: Date = new Date(),
): T {
  const existingOwner = ownerIdentity(existing);
  const incomingOwner = ownerIdentity(sourceFields);
  const incomingOwnsCanonical =
    !existingOwner ||
    existingOwner === incomingOwner ||
    canonicalProviderAuthority(incomingOwner) > canonicalProviderAuthority(existingOwner);

  const merged: Record<string, unknown> = { ...existing };
  for (const [key, incoming] of Object.entries(sourceFields)) {
    if (PRESERVED_FIELDS.has(key)) continue;
    if (key === "tags") {
      merged.tags = mergeTags(existing.tags, incoming);
      continue;
    }
    if (key === "sourceConfidence") {
      merged.sourceConfidence = strongerConfidence(existing.sourceConfidence, incoming);
      continue;
    }
    if (!hasMeaningfulValue(incoming)) continue;

    const current = existing[key];
    const mayReplace = incomingOwnsCanonical || !hasMeaningfulValue(current);
    if (CANONICAL_OWNER_FIELDS.has(key)) {
      if (incomingOwnsCanonical || !hasMeaningfulValue(current)) merged[key] = incoming;
      continue;
    }
    if (mayReplace) merged[key] = incoming;
  }

  for (const field of PRESERVED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(existing, field)) merged[field] = existing[field];
  }
  if (Object.prototype.hasOwnProperty.call(existing, "status") || "status" in sourceFields) {
    merged.status = refreshedStatus(existing, sourceFields, merged, now);
  }
  return merged as T;
}

export function finalIngestionStatus(input: {
  cancelled: boolean;
  timedOut: boolean;
  totalSources: number;
  failedSources: number;
  timedOutSources: number;
  warningSources: number;
}): "completed" | "completed_with_errors" | "cancelled" | "failed" {
  if (input.cancelled) return "cancelled";
  if (input.timedOut) return "completed_with_errors";
  if (
    input.totalSources > 0 &&
    input.failedSources + input.timedOutSources >= input.totalSources
  ) {
    return "failed";
  }
  return input.failedSources + input.timedOutSources + input.warningSources > 0
    ? "completed_with_errors"
    : "completed";
}

export function shouldArchiveForDeadline(
  responseDeadline: Date | null | undefined,
  now: Date,
): boolean {
  return (
    responseDeadline instanceof Date &&
    !Number.isNaN(responseDeadline.getTime()) &&
    responseDeadline < now
  );
}
