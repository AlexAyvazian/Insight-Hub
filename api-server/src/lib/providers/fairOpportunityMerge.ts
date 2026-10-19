import type { NormalizedOpportunity } from "./types";

function canonicalRecordKey(record: NormalizedOpportunity): string {
  const sourceId =
    typeof record.rawData?.sourceId === "string"
      ? record.rawData.sourceId.trim().toLowerCase()
      : "";
  const solicitation = record.solicitationNumber
    ?.replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  if (sourceId && solicitation) return `sol:${sourceId}:${solicitation}`;
  if (record.sourceUrl) {
    try {
      const url = new URL(record.sourceUrl);
      url.hash = "";
      for (const key of Array.from(url.searchParams.keys())) {
        if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
      }
      url.searchParams.sort();
      return `url:${url.toString().toLowerCase()}`;
    } catch {
      return `url:${record.sourceUrl.toLowerCase()}`;
    }
  }
  return `id:${record.externalId.toLowerCase()}`;
}

export function opportunitySourceKey(record: NormalizedOpportunity): string {
  const sourceId = record.rawData?.sourceId ?? record.rawData?.parsedPortalSourceId;
  if (typeof sourceId === "string" && sourceId.trim()) return sourceId.trim();
  return record.providerName?.trim() || record.source || "unknown";
}

export interface OpportunitySourceGroup {
  sourceId: string;
  records: readonly NormalizedOpportunity[];
}

function roundRobin(
  groups: readonly OpportunitySourceGroup[],
  limit: number,
  seen: Set<string>,
  output: NormalizedOpportunity[],
  mismatch: boolean,
): void {
  const queues = groups.map((group) => ({
    sourceId: group.sourceId,
    records: group.records.filter(
      (record) => Boolean(record.rawData?.manualQueryMismatch) === mismatch,
    ),
    cursor: 0,
  }));

  while (output.length < limit) {
    let advanced = false;
    for (const queue of queues) {
      while (queue.cursor < queue.records.length) {
        const record = queue.records[queue.cursor++];
        if (!record) continue;
        const key = canonicalRecordKey(record);
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(record);
        advanced = true;
        break;
      }
      if (output.length >= limit) break;
    }
    if (!advanced) break;
  }
}

/**
 * Deterministically interleaves one record per source before returning to a
 * prolific source. Query matches are always admitted before deferred query
 * non-matches, so deferred records never displace actionable ones.
 */
export function fairMergeOpportunityGroups(
  groups: readonly OpportunitySourceGroup[],
  limit: number,
): NormalizedOpportunity[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];

  const normalizedGroups = groups
    .filter((group) => group.records.length > 0)
    .map((group) => ({
      sourceId: group.sourceId,
      records: [...group.records],
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));

  const seen = new Set<string>();
  const output: NormalizedOpportunity[] = [];
  roundRobin(normalizedGroups, boundedLimit, seen, output, false);
  if (output.length < boundedLimit) {
    roundRobin(normalizedGroups, boundedLimit, seen, output, true);
  }
  return output;
}

export function groupOpportunitiesBySource(
  records: readonly NormalizedOpportunity[],
): OpportunitySourceGroup[] {
  const groups = new Map<string, NormalizedOpportunity[]>();
  for (const record of records) {
    const key = opportunitySourceKey(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return Array.from(groups, ([sourceId, groupedRecords]) => ({
    sourceId,
    records: groupedRecords,
  }));
}
