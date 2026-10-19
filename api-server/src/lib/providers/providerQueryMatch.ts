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
import { applyPrimaryPurchasedScope, assessPrimaryPurchasedScope } from "../search/primaryPurchasedScope";

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
 * check (is the page an actual procurement notice?) and the primary-purchased-scope check, which can only downgrade.
 * See procurementAuthenticity.ts and primaryPurchasedScope.ts.
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
  const authentic = applyProcurementAuthenticity(relevance, authenticity);
  // Then the primary purchased scope (component-only or supply-only evidence); also downgrade-only.
  return applyPrimaryPurchasedScope(authentic, assessPrimaryPurchasedScope(authentic, { title: record.title, description }));
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

/** Light suffix stripping so "examinations" meets "examination" and "testing" meets "test". */
export function stemTerm(word: string): string {
  if (word.length <= 4) return word;
  return word.replace(/(?:ations?|ings?|ions?|ers?|ies|es|ed|al|s)$/, "") || word;
}

/** Phrases the user put in double quotes: an explicit request for exact matching. */
function quotedPhrases(query: string): string[] {
  return Array.from(query.matchAll(/"([^"]+)"/g), (match) => normalizedWords(match[1]!).join(" ")).filter(Boolean);
}

/** True when the query itself names an Occu-Med service, so the canonical profile decision can widen it. */
function queryInProfileScope(query: string): boolean {
  const result = classifyResult({ title: query, snippet: "", deadlineInFuture: true, allowHistorical: true });
  return result.matchedExplicitPhrases.length > 0 || result.matchedServiceCategories.some((c) => c !== "Occu-Med profile phrase");
}

/**
 * Whether a record answers a provider query. Retrieval is a union, not a chain of gates:
 *  - quoted phrases are strict: every phrase and every term must appear;
 *  - otherwise a lexical match on stemmed terms (all terms for one- and two-term queries, 60% for longer ones);
 *  - or, when the query is about an Occu-Med service, the canonical profile decision keeps the record, so a
 *    notice using different wording for the same service is not lost at the query step.
 */
export function recordMatchesProviderQuery(
  record: NormalizedOpportunity,
  query?: string,
): boolean {
  if (!query?.trim()) return true;
  if (isOccuMedProfileQuery(query)) {
    return decideRelevance(classifyProviderRecordRelevance(record)).verdict !== "reject";
  }

  const phrases = quotedPhrases(query);
  const terms = meaningfulProviderQueryTerms(query.replace(/"/g, " "));
  if (terms.length === 0) return true;
  const haystack = recordSearchText(record);
  if (phrases.length > 0) {
    return phrases.every((phrase) => haystack.includes(phrase)) && terms.every((term) => haystack.includes(term));
  }
  const stems = new Set(haystack.split(" ").map(stemTerm));
  const hits = terms.filter((term) => haystack.includes(term) || stems.has(stemTerm(term))).length;
  const needed = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.6);
  if (hits >= needed) return true;
  return queryInProfileScope(query) && decideRelevance(classifyProviderRecordRelevance(record)).verdict !== "reject";
}

/** Below this much own description text a missing query term says more about the snippet than about the notice. */
export const THIN_SNIPPET_CHARS = 160;

/**
 * Why a record that did not match the query is deferred. Neither reason is a rejection: missing keywords and thin
 * snippets are retrieval evidence, not relevance evidence, so the canonical decision still judges the record.
 */
export type QueryDeferralReason = "thin_snippet" | "query_terms_absent";

export function queryDeferralReason(record: NormalizedOpportunity): QueryDeferralReason {
  const ownText = (isWebDiscoverySource(record.source) ? ownNoticeText(record.description) : record.description) ?? "";
  return ownText.replace(/\s+/g, " ").trim().length < THIN_SNIPPET_CHARS ? "thin_snippet" : "query_terms_absent";
}

/**
 * A query non-match, kept and flagged instead of dropped. `manualQueryMismatch` keeps the existing downstream
 * handling (admitted after matches, AI recovery may clear it); `queryMatchDeferred` tells the quality decision the
 * record is deferred for review rather than rejected for the missing keywords alone.
 */
function deferredRecord(
  record: NormalizedOpportunity,
  query: string,
  reason: QueryDeferralReason,
): NormalizedOpportunity {
  return {
    ...record,
    rawData: {
      ...(record.rawData ?? {}),
      manualQueryMismatch: true,
      manualQuery: query,
      queryMatchDeferred: true,
      queryDeferralReason: reason,
      tags: Array.from(
        new Set([...stringTags(record), "manual-query-mismatch", "query-deferred"]),
      ),
    },
  };
}

export interface ProviderQueryPartition {
  matched: NormalizedOpportunity[];
  /** Every query non-match, flagged and in a deterministic order (title, then external id). Nothing is dropped. */
  deferred: NormalizedOpportunity[];
  /** The first `rejectionSampleLimit` deferred records, for callers that only want bounded diagnostics. */
  rejectedSamples: NormalizedOpportunity[];
  rawCount: number;
  matchedCount: number;
  /** Count of query non-matches (all of them are in `deferred`). */
  rejectedCount: number;
  deferredByReason: Record<QueryDeferralReason, number>;
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
      deferred: [],
      rejectedSamples: [],
      rawCount: normalizedRecords.length,
      matchedCount: normalizedRecords.length,
      rejectedCount: 0,
      deferredByReason: { thin_snippet: 0, query_terms_absent: 0 },
    };
  }

  const matched: NormalizedOpportunity[] = [];
  const unmatched: NormalizedOpportunity[] = [];
  for (const record of normalizedRecords) {
    if (recordMatchesProviderQuery(record, query)) matched.push(record);
    else unmatched.push(record);
  }

  const deferredByReason: Record<QueryDeferralReason, number> = { thin_snippet: 0, query_terms_absent: 0 };
  const deferred = unmatched
    .slice()
    .sort(
      (left, right) =>
        left.title.localeCompare(right.title) ||
        left.externalId.localeCompare(right.externalId),
    )
    .map((record) => {
      const reason = queryDeferralReason(record);
      deferredByReason[reason]++;
      return deferredRecord(record, query, reason);
    });
  const sampleLimit = Math.max(0, Math.floor(rejectionSampleLimit));

  return {
    matched,
    deferred,
    rejectedSamples: deferred.slice(0, sampleLimit),
    rawCount: normalizedRecords.length,
    matchedCount: matched.length,
    rejectedCount: deferred.length,
    deferredByReason,
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
