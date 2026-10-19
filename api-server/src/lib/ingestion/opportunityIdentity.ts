import { createHash } from "node:crypto";
import type { NormalizedOpportunity } from "../providers/types";
import { samGovClassificationEvidence } from "../providers/samGovTaxonomyEvidence";
import { classifyResult, type RelevanceResult } from "../search/relevance";
import { decideRelevance } from "../search/relevanceDecision";
import { normalizedToDbRecord } from "../search/normalization";
import { canonicalSamOpportunityUrl } from "../opportunityQuality";

export type OpportunityDedupeKeyType =
  | "provider"
  | "solicitation"
  | "url"
  | "fingerprint";

export interface OpportunityDedupeKey {
  type: OpportunityDedupeKeyType;
  value: string;
}

export interface QualityDecision {
  status: "accepted" | "rejected" | "quarantined";
  reason: string | null;
  completenessScore: number;
  sourceConfidence: number;
}

export const QUALITY_REJECTION_CODES = {
  blockedDomain: "blocked_domain",
  hardReject: "hard_reject",
  conditionalFalsePositive: "conditional_false_positive",
  missingProcurementSignal: "missing_procurement_signal",
  adjudicationBand: "adjudication_band",
  missingServiceEvidence: "missing_occumed_service_evidence",
  insufficientCombination: "insufficient_evidence_combination",
  manualQueryMismatch: "manual_query_mismatch",
  queryDeferred: "query_deferred",
  unknownPostedDate: "unknown_posted_date",
  structuredReviewHeld: "structured_review_held",
} as const;

/** Set by the structured-provider decision on records it did not approve (see providerRunner). */
export interface StructuredDecisionMarker {
  status: "held" | "rejected";
  code: string;
  reason: string;
}

function structuredDecisionMarker(record: NormalizedOpportunity): StructuredDecisionMarker | null {
  const marker = (record.rawData as Record<string, unknown> | undefined)?.structuredDecision as
    | Partial<StructuredDecisionMarker>
    | undefined;
  return marker && (marker.status === "held" || marker.status === "rejected") && typeof marker.reason === "string"
    ? (marker as StructuredDecisionMarker)
    : null;
}

function documentEvidenceFor(record: NormalizedOpportunity): string {
  const evidence = (record.rawData as Record<string, unknown> | undefined)?.documentEvidence as { text?: unknown } | undefined;
  return typeof evidence?.text === "string" ? evidence.text.slice(0, 12_000) : "";
}

function encodedQualityReason(code: string, detail: string): string {
  const legacy = "Record failed the configured Occu-Med opportunity relevance filter.";
  return `${code}|${legacy} ${detail.replace(/\s+/g, " ").trim()}`;
}

export function relevanceRejectionReason(result: RelevanceResult): string {
  const rejectReason = result.rejectReason ?? "Insufficient Occu-Med relevance evidence.";
  if (/job board|non-procurement domain/i.test(rejectReason)) {
    return encodedQualityReason(QUALITY_REJECTION_CODES.blockedDomain, rejectReason);
  }
  if (/excluded due to/i.test(rejectReason)) {
    return encodedQualityReason(QUALITY_REJECTION_CODES.hardReject, rejectReason);
  }
  if (result.negativeSignals.length > 0) {
    return encodedQualityReason(
      QUALITY_REJECTION_CODES.conditionalFalsePositive,
      `Negative context outweighed the service evidence: ${result.negativeSignals.join("; ")}.`,
    );
  }
  if (result.matchedProcurementSignals.length === 0) {
    return encodedQualityReason(
      QUALITY_REJECTION_CODES.missingProcurementSignal,
      "No procurement, solicitation, bid, RFP, or contracting signal was detected.",
    );
  }
  const serviceEvidenceCount =
    result.matchedExplicitPhrases.length +
    result.matchedComponentTerms.length +
    result.matchedRegulatorySignals.length;
  if (serviceEvidenceCount === 0) {
    return encodedQualityReason(
      QUALITY_REJECTION_CODES.missingServiceEvidence,
      "Procurement wording was present, but no Occu-Med service evidence was detected.",
    );
  }
  const categories = result.matchedServiceCategories.length > 0
    ? ` Matched categories: ${result.matchedServiceCategories.join(", ")}.`
    : "";
  return encodedQualityReason(
    QUALITY_REJECTION_CODES.insufficientCombination,
    `Some relevant terms were present, but they did not meet the required procurement plus service/workforce/regulatory evidence combination.${categories}`,
  );
}

function normalizeIdentityText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function canonicalizeOpportunityUrl(
  value?: string | null,
): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    const sam = canonicalSamOpportunityUrl(url.toString());
    if (sam) return sam;
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function providerKeyForOpportunity(
  record: NormalizedOpportunity,
): string {
  return normalizedToDbRecord(record).providerKey ?? record.source ?? "manual";
}

export function calculateOpportunityDedupeKeys(
  record: NormalizedOpportunity,
): OpportunityDedupeKey[] {
  const keys: OpportunityDedupeKey[] = [];
  const providerKey = providerKeyForOpportunity(record);
  const providerNativeId = record.externalId?.trim().toLowerCase();
  if (providerNativeId) {
    keys.push({
      type: "provider",
      value: `provider:${providerKey}:${providerNativeId}`,
    });
  }

  const solicitation = normalizeIdentityText(record.solicitationNumber).replace(
    /\s+/g,
    "",
  );
  const agency = normalizeIdentityText(record.agency);
  if (solicitation.length >= 4 && agency.length >= 2) {
    keys.push({
      type: "solicitation",
      value: `solicitation:${solicitation}|agency:${agency}`,
    });
  }

  const canonicalUrl = canonicalizeOpportunityUrl(record.sourceUrl);
  if (canonicalUrl)
    keys.push({ type: "url", value: `url:${canonicalUrl.toLowerCase()}` });

  const title = normalizeIdentityText(record.title);
  if (title.length >= 12 && agency.length >= 2) {
    keys.push({
      type: "fingerprint",
      value: `fingerprint:${title}|agency:${agency}`,
    });
  }

  return keys;
}

export function knownPostedDate(record: NormalizedOpportunity): Date | null {
  if (!(record.postedDate instanceof Date)) return null;
  if (Number.isNaN(record.postedDate.getTime())) return null;
  if (record.postedDate.getTime() <= 0) return null;
  if (record.rawData?.dateUnknown === true) return null;
  return record.postedDate;
}

export function calculateCompletenessScore(
  record: NormalizedOpportunity,
): number {
  const checks = [
    Boolean(record.title?.trim()),
    Boolean(record.agency?.trim()),
    Boolean(record.externalId?.trim()),
    Boolean(record.sourceUrl?.trim()),
    Boolean(knownPostedDate(record)),
    Boolean(
      record.responseDeadline &&
      !Number.isNaN(record.responseDeadline.getTime()),
    ),
    Boolean(record.solicitationNumber?.trim()),
    Boolean(record.description?.trim()),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

export function calculateSourceConfidence(
  record: NormalizedOpportunity,
): number {
  const raw = record.rawData ?? {};
  const explicit = raw.sourceConfidence;
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return explicit > 1
      ? Math.min(100, Math.max(0, explicit))
      : Math.round(explicit * 100);
  }
  if (explicit === "high") return 90;
  if (explicit === "medium") return 65;
  if (explicit === "low") return 35;
  if (raw.fallback === true) return 30;
  return record.sourceUrl ? 70 : 45;
}

function rawString(
  raw: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = raw?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSamGovOpportunity(record: NormalizedOpportunity): boolean {
  if (record.source === "samGov") return true;
  if (rawString(record.rawData, "providerPlatform")?.toLowerCase() === "sam.gov") return true;
  try {
    const host = record.sourceUrl ? new URL(record.sourceUrl).hostname.toLowerCase() : "";
    return host === "sam.gov" || host.endsWith(".sam.gov");
  } catch {
    return false;
  }
}

function samTaxonomyEvidenceFor(record: NormalizedOpportunity): string[] {
  if (!isSamGovOpportunity(record)) return [];
  const naicsCode = record.naicsCode ?? rawString(record.rawData, "naicsCode");
  const pscCode = rawString(record.rawData, "classificationCode");
  return samGovClassificationEvidence(naicsCode, pscCode);
}

export function decideOpportunityQuality(
  record: NormalizedOpportunity,
): QualityDecision {
  const completenessScore = calculateCompletenessScore(record);
  const sourceConfidence = calculateSourceConfidence(record);
  if (!record.title?.trim() || record.title.trim().length < 3) {
    return {
      status: "quarantined",
      reason: "invalid_title|Missing or implausibly short opportunity title.",
      completenessScore,
      sourceConfidence,
    };
  }
  if (!record.agency?.trim()) {
    return {
      status: "quarantined",
      reason: "missing_agency|Missing buyer or agency identity.",
      completenessScore,
      sourceConfidence,
    };
  }
  // A query non-match flagged as deferred (providerQueryMatch.ts) is not rejected for missing keywords or a thin
  // snippet: the canonical decision below judges it, and if it would keep it the record is held for review.
  const queryDeferred = record.rawData?.manualQueryMismatch === true && record.rawData?.queryMatchDeferred === true;
  if (record.rawData?.manualQueryMismatch === true && !queryDeferred) {
    const query =
      typeof record.rawData.manualQuery === "string"
        ? record.rawData.manualQuery
        : "the requested manual query";
    return {
      status: "rejected",
      reason: `${QUALITY_REJECTION_CODES.manualQueryMismatch}|Record was retained only as a bounded diagnostic sample because it did not match ${JSON.stringify(query)}.`,
      completenessScore,
      sourceConfidence,
    };
  }
  if (record.rawData?.invalidPostedDate === true) {
    return {
      status: "quarantined",
      reason: "invalid_posted_date|Provider supplied a malformed posted date.",
      completenessScore,
      sourceConfidence,
    };
  }

  const samTaxonomyEvidence = samTaxonomyEvidenceFor(record);
  const classifyWith = (extra: string) =>
    classifyResult({
      title: record.title,
      snippet: [
        record.type,
        record.solicitationNumber,
        record.description,
        ...samTaxonomyEvidence,
        extra,
      ]
        .filter(Boolean)
        .join(" "),
      url: record.sourceUrl,
      allowHistorical: true,
      // Live-deadline and posted-date evidence travels with the notice, never with the provider.
      deadlineInFuture:
        record.responseDeadline instanceof Date &&
        record.responseDeadline.getTime() > Date.now(),
      date: record.postedDate ?? null,
    });
  let relevance = classifyWith("");
  // One decision for every provider: the Neon evidence rules plus the canonical thresholds.
  let decision = decideRelevance(relevance);
  // Release C: cited excerpts from the official documents can raise a thin notice, never sink one (boilerplate in
  // long solicitations would otherwise trip hard rules), and never overturn a hard-rule rejection of the notice.
  const documentEvidence = documentEvidenceFor(record);
  if (documentEvidence && decision.verdict !== "accept" && !(relevance.rejected && relevance.confidence === "rejected" && relevance.negativeSignals.length > 0)) {
    const withDocuments = classifyWith(documentEvidence);
    const rank = { reject: 0, review: 1, accept: 2 } as const;
    const documentDecision = decideRelevance(withDocuments);
    if (rank[documentDecision.verdict] > rank[decision.verdict]) {
      relevance = withDocuments;
      decision = documentDecision;
    }
  }
  if (decision.verdict === "reject") {
    return {
      status: "rejected",
      reason: relevanceRejectionReason(relevance),
      completenessScore,
      sourceConfidence,
    };
  }
  // A structured-provider record that was held (AI budget, decline or failure) or rejected upstream is staged for
  // audit/review but never promoted, whatever the classifier says here.
  const structured = structuredDecisionMarker(record);
  if (structured?.status === "rejected") {
    return {
      status: "rejected",
      reason: encodedQualityReason(QUALITY_REJECTION_CODES.hardReject, `${structured.code}: ${structured.reason}`),
      completenessScore,
      sourceConfidence,
    };
  }
  if (structured?.status === "held") {
    return {
      status: "quarantined",
      reason: encodedQualityReason(QUALITY_REJECTION_CODES.structuredReviewHeld, `${structured.code}: ${structured.reason}`),
      completenessScore,
      sourceConfidence,
    };
  }
  if (queryDeferred) {
    const query = typeof record.rawData?.manualQuery === "string" ? record.rawData.manualQuery : "the requested query";
    const why = record.rawData?.queryDeferralReason === "thin_snippet" ? "its source snippet is too thin to show the query terms" : "it does not contain the query terms";
    return {
      status: "quarantined",
      reason: encodedQualityReason(
        QUALITY_REJECTION_CODES.queryDeferred,
        `Deferred for review: ${why} (${JSON.stringify(query.slice(0, 120))}), but the canonical relevance decision (${decision.verdict}) does not reject it.`,
      ),
      completenessScore,
      sourceConfidence,
    };
  }
  if (decision.verdict === "review") {
    return {
      status: "quarantined",
      reason: encodedQualityReason(
        QUALITY_REJECTION_CODES.adjudicationBand,
        `Held for adjudication: ${decision.reason}.`,
      ),
      completenessScore,
      sourceConfidence,
    };
  }
  return {
    status: "accepted",
    reason: null,
    completenessScore,
    sourceConfidence,
  };
}

export function generatedProviderNativeId(
  record: NormalizedOpportunity,
): string {
  if (record.externalId?.trim()) return record.externalId.trim();
  const canonicalUrl = canonicalizeOpportunityUrl(record.sourceUrl);
  const material =
    canonicalUrl ??
    [record.title, record.agency, record.solicitationNumber ?? ""].join("|");
  return `generated-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export function serializeOpportunity(
  record: NormalizedOpportunity,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}
