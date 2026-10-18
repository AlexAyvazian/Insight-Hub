import type { NormalizedOpportunity } from "./types";
import { classifyResult, type RelevanceResult } from "../search/relevance";
import { decideRelevance } from "../search/relevanceDecision";
import { getRelevanceProfile } from "../search/relevanceProfile";
import {
  applyProcurementAuthenticity,
  assessProcurementAuthenticity,
  isWebDiscoverySource,
  ownNoticeText,
} from "../search/procurementAuthenticity";

const GENERIC_QUERY_TERMS = new Set([
  "a",
  "an",
  "and",
  "bid",
  "bids",
  "contract",
  "contracts",
  "for",
  "government",
  "of",
  "opportunities",
  "opportunity",
  "procurement",
  "professional",
  "request",
  "requests",
  "rfi",
  "rfp",
  "rfq",
  "service",
  "services",
  "solicitation",
  "solicitations",
  "the",
  "vendor",
  "vendors",
]);

function normalizedWords(value: string): string[] {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function stringTags(record: NormalizedOpportunity): string[] {
  return Array.isArray(record.rawData?.tags)
    ? record.rawData.tags.filter(
        (tag): tag is string => typeof tag === "string",
      )
    : [];
}

/**
 * Provider contracts historically used the Unix epoch as an unknown-date
 * sentinel. Convert that sentinel to a runtime null before raw/staging writes,
 * while retaining an explicit evidence flag for the quality decision.
 */
export function normalizeProviderPostedDate(
  record: NormalizedOpportunity,
): NormalizedOpportunity {
  const value = record.postedDate as Date | null | undefined;
  const invalid = value instanceof Date && Number.isNaN(value.getTime());
  const unknown =
    record.rawData?.dateUnknown === true ||
    value == null ||
    (value instanceof Date && value.getTime() <= 0);
  if (!invalid && !unknown) return record;

  const marker = invalid ? "invalid-posted-date" : "date-unknown";
  return {
    ...record,
    postedDate: null as unknown as Date,
    rawData: {
      ...(record.rawData ?? {}),
      ...(invalid ? { invalidPostedDate: true } : { dateUnknown: true }),
      tags: Array.from(new Set([...stringTags(record), marker])),
    },
  };
}

export function meaningfulProviderQueryTerms(query?: string): string[] {
  const words = Array.from(new Set(normalizedWords(query ?? "")));
  const meaningful = words.filter(
    (word) => word.length >= 2 && !GENERIC_QUERY_TERMS.has(word),
  );
  return meaningful.length > 0 ? meaningful : words;
}

/**
 * A query is the Occu-Med profile query when it is exactly one of the profile's own service phrases (a category
 * label, any category/bundle service term). Such a query asks "is this an Occu-Med opportunity", which the
 * canonical decision answers; any other query is a plain keyword match.
 */
export function isOccuMedProfileQuery(query?: string): boolean {
  const wanted = normalizedWords(query ?? "").join(" ");
  if (!wanted) return false;
  const profile = getRelevanceProfile();
  const phrases = [
    ...profile.categories.map((c) => c.label),
    ...profile.allServiceTerms,
    ...profile.searchBundles.flatMap((b) => b.serviceTerms),
  ];
  return phrases.some((phrase) => normalizedWords(phrase).join(" ") === wanted);
}

/**
 * Relevance of a provider record: the profile classifier on the notice's own text, then the procurement-authenticity
 * check (is the page an actual procurement notice?), which can only downgrade. See procurementAuthenticity.ts.
 */
export function classifyProviderRecordRelevance(
  record: NormalizedOpportunity,
): RelevanceResult {
  const webDiscovery = isWebDiscoverySource(record.source);
  // A third-party listing page's "similar RFPs" section describes other notices, not this one.
  const description = webDiscovery ? ownNoticeText(record.description) : record.description;
  const relevance = classifyResult({
    title: record.title,
    snippet: [
      record.type,
      record.solicitationNumber,
      description,
      record.naicsDescription,
    ]
      .filter(Boolean)
      .join(" "),
    url: record.sourceUrl,
    date: record.postedDate,
    deadlineInFuture: Boolean(
      record.responseDeadline && record.responseDeadline.getTime() > Date.now(),
    ),
    allowHistorical: true,
  });
  const authenticity = assessProcurementAuthenticity({
    title: record.title,
    description,
    url: record.sourceUrl,
    source: record.source,
    type: record.type,
    solicitationNumber: record.solicitationNumber,
    naicsCode: record.naicsCode,
    pscCode: record.pscCode ?? (typeof record.rawData?.classificationCode === "string" ? record.rawData.classificationCode : undefined),
    responseDeadline: record.responseDeadline ?? null,
  });
  return applyProcurementAuthenticity(relevance, authenticity);
}

function recordSearchText(record: NormalizedOpportunity): string {
  return normalizedWords(
    [
      record.title,
      record.type,
      record.agency,
      record.subAgency,
      record.description,
      record.solicitationNumber,
      record.naicsDescription,
    ]
      .filter(Boolean)
      .join(" "),
  ).join(" ");
}

export function recordMatchesProviderQuery(
  record: NormalizedOpportunity,
  query?: string,
): boolean {
  if (!query?.trim()) return true;
  if (isOccuMedProfileQuery(query)) {
    return decideRelevance(classifyProviderRecordRelevance(record)).verdict !== "reject";
  }

  const terms = meaningfulProviderQueryTerms(query);
  if (terms.length === 0) return true;
  const haystack = recordSearchText(record);
  return terms.every((term) => haystack.includes(term));
}

function mismatchSample(
  record: NormalizedOpportunity,
  query: string,
): NormalizedOpportunity {
  return {
    ...record,
    rawData: {
      ...(record.rawData ?? {}),
      manualQueryMismatch: true,
      manualQuery: query,
      tags: Array.from(
        new Set([...stringTags(record), "manual-query-mismatch"]),
      ),
    },
  };
}

export interface ProviderQueryPartition {
  matched: NormalizedOpportunity[];
  rejectedSamples: NormalizedOpportunity[];
  rawCount: number;
  matchedCount: number;
  rejectedCount: number;
}

export function partitionProviderRecordsForQuery(
  records: readonly NormalizedOpportunity[],
  query?: string,
  rejectionSampleLimit = 2,
): ProviderQueryPartition {
  const normalizedRecords = records.map(normalizeProviderPostedDate);
  if (!query?.trim()) {
    return {
      matched: normalizedRecords,
      rejectedSamples: [],
      rawCount: normalizedRecords.length,
      matchedCount: normalizedRecords.length,
      rejectedCount: 0,
    };
  }

  const matched: NormalizedOpportunity[] = [];
  const rejected: NormalizedOpportunity[] = [];
  for (const record of normalizedRecords) {
    if (recordMatchesProviderQuery(record, query)) matched.push(record);
    else rejected.push(record);
  }

  const sampleLimit = Math.max(0, Math.floor(rejectionSampleLimit));
  const rejectedSamples = rejected
    .slice()
    .sort(
      (left, right) =>
        left.title.localeCompare(right.title) ||
        left.externalId.localeCompare(right.externalId),
    )
    .slice(0, sampleLimit)
    .map((record) => mismatchSample(record, query));

  return {
    matched,
    rejectedSamples,
    rawCount: normalizedRecords.length,
    matchedCount: matched.length,
    rejectedCount: rejected.length,
  };
}

// Compatibility aliases for the existing ingestion regression suite.
export const meaningfulManualQueryTerms = meaningfulProviderQueryTerms;
export const recordMatchesManualQuery = recordMatchesProviderQuery;
export function filterRecordsForManualQuery(
  records: readonly NormalizedOpportunity[],
  query?: string,
): { records: NormalizedOpportunity[]; skipped: number } {
  const partition = partitionProviderRecordsForQuery(records, query, 0);
  return {
    records: partition.matched,
    skipped: partition.rejectedCount,
  };
}
