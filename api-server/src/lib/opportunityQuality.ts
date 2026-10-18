import { createHash } from "node:crypto";
import { classifyResult } from "./search/relevance";
import { hasPrimaryOccuMedServiceEvidence } from "./opportunityScopeEvidence";
import { decideRelevance } from "./search/relevanceDecision";
import { isServiceNameNotBuyer } from "./search/profileServiceName";

export type OpportunityQualityClassification =
  | "verified-open"
  | "needs-verification"
  | "closed"
  | "archived"
  | "award"
  | "forecast"
  | "discovery-only";

export type OpportunityViewMode =
  | "actionable"
  | "needs-verification"
  | "closed"
  | "all";

export interface OpportunityQualityView {
  classification: OpportunityQualityClassification;
  label: string;
  actionable: boolean;
  summaryEligible: boolean;
  sourceType:
    | "official-direct"
    | "verified-solicitation-page"
    | "search-discovery"
    | "aggregator"
    | "unknown";
  reasons: string[];
  hasFutureDeadline: boolean;
  deadlineKnown: boolean;
  buyerKnown: boolean;
  solicitationLike: boolean;
  bidReadyNotice: boolean;
  relevanceEligible: boolean;
  /** Whether the title/description evidence a purchased Occu-Med service (see opportunityScopeEvidence). */
  purchasedScopeEvidenced: boolean;
  relevanceScore: number;
  sourceVerified: boolean;
  sourceAuthority: "trusted" | "medium" | "low";
  evidenceFingerprint: string;
}

type OpportunityLike = Record<string, any>;

const DISCOVERY_PROVIDERS = new Set([
  "serper",
  "exa",
  "tavily",
  "you",
  "langsearch",
  "parallel",
  "linkup",
  "socrata",
  "websearch",
  "aiDiscovery",
  "rssAggregator",
]);
const TRUSTED_DIRECT_PROVIDERS = new Set([
  "samGov",
  "sam_gov",
  "internationalPublicPortals",
  "eunaBonfire",
  "texasEsbd",
  "nyScr",
]);
const AGGREGATOR_HOSTS = [
  "highergov.com",
  "govtribe.com",
  "starbridge.ai",
  "rfpmart.com",
  "sweetspotgov.com",
  "fedscout.com",
  "bidbanana.thebidlab.com",
  "tenderimpulse.com",
  "demandstar.com",
];
const OFFICIAL_HOST_HINTS = [
  ".gov",
  ".mil",
  "sam.gov",
  "combuys.com",
  "oregonbuys.gov",
  "bidbuy.illinois.gov",
  "evp.nc.gov",
];
const BAD_TYPE_RE =
  /award notice|notice of award|forecast|tabulation|bid tab|purchase order|contract document|contract pdf|archive|archived|cancel|intent to award|sole source/i;
const FORECAST_RE = /forecast|acquisition planning forecast|apfs/i;
const AWARD_RE =
  /\b(award notice|notice of award|notice of intent to award|intent to award|contract award(?:ed)?|bid result|bid tabulation|tabulation of bids|purchase order|contract document|contract\.pdf|contract pdf|awarded to)\b/i;
const GENERAL_PAGE_RE =
  /procurement opportunities|bids & rfps|bid opportunities|solicitation 2026|all-tender-list|page \d+ of \d+|procurements:/i;
const SOLICITATION_RE =
  /solicitation|request for proposal|\brfp\b|invitation to bid|\bitb\b|request for quote|\brfq\b|bid solicitation|sources sought|presolicitation|tender/i;
const EARLY_SIGNAL_RE =
  /\b(?:sources sought|presolicitation|pre-solicitation|special notice|request for information|\brfi\b|intent to bundle)\b/i;
const BID_READY_RE =
  /\b(?:solicitation|combined synopsis\/solicitation|request for proposal|\brfp\b|request for quote|\brfq\b|invitation for bids?|\bifb\b|invitation to bid|\bitb\b|tender)\b/i;

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return raw
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

function urlHost(value: unknown): string {
  try {
    return new URL(String(value ?? "")).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function canonicalSamOpportunityUrl(
  value?: string | null,
): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    const match = url.pathname.match(
      /(?:\/workspace\/contract\/opp|\/opp)\/([^/]+)\/view/i,
    );
    const hostname = url.hostname.toLowerCase();
    if (
      (hostname === "sam.gov" || hostname.endsWith(".sam.gov")) &&
      match?.[1]
    )
      return `https://sam.gov/opp/${match[1]}/view`;
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys()))
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function deadlineEndForComparison(value: unknown): Date | null {
  if (!value) return null;
  const date =
    value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const raw = String(value instanceof Date ? value.toISOString() : value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}(?:T00:00:00\.000Z)?$/.test(raw);
  if (
    dateOnly ||
    (date.getUTCHours() === 0 &&
      date.getUTCMinutes() === 0 &&
      date.getUTCSeconds() === 0 &&
      date.getUTCMilliseconds() === 0)
  ) {
    const [year, month, day] = date
      .toISOString()
      .slice(0, 10)
      .split("-")
      .map(Number);
    const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
    const tzName =
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        timeZoneName: "shortOffset",
      })
        .formatToParts(noonUtc)
        .find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
    const offsetHours = Number(tzName.match(/GMT([+-]\d+)/)?.[1] ?? -8);
    return new Date(Date.UTC(year, month - 1, day + 1, -offsetHours, 0, 0, -1));
  }
  return date;
}

export function classifyOpportunityQuality(
  opp: OpportunityLike,
  now = new Date(),
): OpportunityQualityView {
  const tags = parseTags(opp.tags).map((t) => t.toLowerCase());
  const provider = String(
    opp.providerName ?? opp.providerKey ?? opp.source ?? "",
  );
  const url = String(opp.samUrl ?? opp.sourceUrl ?? opp.url ?? "");
  const host = urlHost(url);
  const identityText = [opp.title, opp.type, url].filter(Boolean).join(" ");
  const fullText = [
    identityText,
    opp.agency,
    opp.description,
    opp.notes,
    tags.join(" "),
  ]
    .filter(Boolean)
    .join(" ");
  const deadline = deadlineEndForComparison(opp.responseDeadline);
  const deadlineKnown = Boolean(deadline);
  const hasFutureDeadline = Boolean(
    deadline && deadline.getTime() > now.getTime(),
  );
  const buyer = String(opp.agency ?? "").trim();
  const buyerKnown =
    buyer.length > 0 &&
    !/^(unknown|unknown organization|government|government agency|state agency|official public rfp portal|procurement portal)$/i.test(
      buyer,
    ) &&
    // a service line posing as the buyer is recognised from the profile, not a local list
    !isServiceNameNotBuyer(buyer);
  const sourceConfidence = String(opp.sourceConfidence ?? "").toLowerCase();
  const confidenceOk =
    sourceConfidence === "high" || sourceConfidence === "medium";
  const directStructuredEvidence = tags.includes("evidence:direct-structured");
  const authoritativePageEvidence = tags.includes(
    "evidence:authoritative-page",
  );
  const completeDirectEvidenceTag = tags.includes("complete-direct-evidence");
  const aggregator =
    tags.includes("evidence:aggregator") ||
    AGGREGATOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  const discoveryProvider =
    DISCOVERY_PROVIDERS.has(provider) ||
    tags.includes("ai-pending") ||
    tags.includes("evidence:discovery");
  const landingPage = tags.includes("evidence:landing-page");
  const officialHost = OFFICIAL_HOST_HINTS.some(
    (h) => host === h.replace(/^\./, "") || host.endsWith(h),
  );
  // Tango is a structured secondary source: reliable metadata, but not independent official confirmation. It is
  // trusted only when the record points at an official notice page (e.g. its sam.gov URL); the list route's
  // dedupe authority uses the same "structured, below official" tier.
  const trustedDirectProvider = TRUSTED_DIRECT_PROVIDERS.has(provider) ||
    (provider.toLowerCase() === "tango" && officialHost);
  const completeStoredDirectEvidence =
    trustedDirectProvider &&
    confidenceOk &&
    Boolean(
      buyerKnown &&
      opp.title &&
      opp.type &&
      String(opp.status).toLowerCase() === "active" &&
      deadlineKnown &&
      url,
    );
  const normalizedEvidenceVerified =
    completeDirectEvidenceTag &&
    (directStructuredEvidence || authoritativePageEvidence) &&
    confidenceOk;
  const sourceVerified =
    (normalizedEvidenceVerified || completeStoredDirectEvidence) &&
    !discoveryProvider &&
    !aggregator;
  const sourceType = discoveryProvider
    ? "search-discovery"
    : aggregator
      ? "aggregator"
      : directStructuredEvidence || completeStoredDirectEvidence
        ? "official-direct"
        : authoritativePageEvidence || officialHost
          ? "verified-solicitation-page"
          : "unknown";
  // Notice stage comes from the notice itself (title/type), not from URL slugs ("/forecast-medical/") or from
  // history in the description ("the current contract was awarded to ..." in a live re-solicitation).
  const stageText = [opp.title, opp.type].filter(Boolean).join(" ");
  const awardLike =
    AWARD_RE.test(stageText) ||
    /\bcontract\.pdf\b/i.test(url) ||
    (/\bawarded to\b/i.test(String(opp.description ?? "")) &&
      !BID_READY_RE.test(stageText) &&
      !hasFutureDeadline);
  const forecastLike = FORECAST_RE.test(stageText);
  const solicitationLike =
    SOLICITATION_RE.test(fullText) &&
    !BAD_TYPE_RE.test(stageText) &&
    !GENERAL_PAGE_RE.test(identityText);
  const bidReadyNotice =
    BID_READY_RE.test(identityText) && !EARLY_SIGNAL_RE.test(identityText);
  const relevance = classifyResult({
    title: String(opp.title ?? ""),
    snippet: [
      opp.type,
      opp.solicitationNumber,
      opp.description,
      opp.naicsCode,
      opp.naicsDescription,
    ]
      .filter(Boolean)
      .join(" "),
    url,
    date: opp.postedDate,
    deadlineInFuture: hasFutureDeadline,
    allowHistorical: true,
  });
  const purchasedScopeEvidenced = hasPrimaryOccuMedServiceEvidence(
    String(opp.title ?? ""), String(opp.description ?? ""),
  );
  const relevanceEligible =
    decideRelevance(relevance).verdict === "accept" &&
    relevance.confidence !== "possible_adjacent" &&
    purchasedScopeEvidenced;
  const structuredDirectEvidence =
    normalizedEvidenceVerified || completeStoredDirectEvidence;
  const reasons: string[] = [];

  let classification: OpportunityQualityClassification;
  if (String(opp.status).toLowerCase() === "archived")
    classification = "archived";
  else if (awardLike) classification = "award";
  else if (forecastLike) classification = "forecast";
  else if (deadlineKnown && !hasFutureDeadline) classification = "closed";
  else if (
    discoveryProvider ||
    aggregator ||
    landingPage ||
    GENERAL_PAGE_RE.test(identityText)
  )
    classification = "discovery-only";
  else if (
    !deadlineKnown ||
    !sourceVerified ||
    !buyerKnown ||
    !solicitationLike ||
    !bidReadyNotice ||
    !relevanceEligible ||
    !confidenceOk
  )
    classification = "needs-verification";
  else classification = "verified-open";

  if (!deadlineKnown)
    reasons.push("A future submission deadline could not be confirmed.");
  else if (!hasFutureDeadline)
    reasons.push("The stored submission deadline has passed.");
  if (!sourceVerified)
    reasons.push("Authoritative solicitation content has not been verified.");
  if (!buyerKnown) reasons.push("Buyer identity is missing or generic.");
  if (!solicitationLike)
    reasons.push("The record is not clearly an actionable solicitation.");
  if (!bidReadyNotice)
    reasons.push(
      "The notice is early-stage market research or not yet a bid-ready solicitation.",
    );
  if (!purchasedScopeEvidenced)
    reasons.push("Specific purchased-scope evidence is unconfirmed; retained for review.");
  else if (!relevanceEligible)
    reasons.push("The record does not have a strong current match to Occu-Med service lines.");
  if (classification === "award")
    reasons.push(
      "The record appears to be an award, purchase order, tabulation, or contract document.",
    );
  if (classification === "forecast")
    reasons.push("The record appears to be a forecast or planning notice.");
  if (classification === "discovery-only")
    reasons.push(
      "The record is supported primarily by search, aggregator, or discovery metadata.",
    );
  if (!confidenceOk) reasons.push("Source confidence is not medium or high.");

  return {
    classification,
    label: classification
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    actionable: classification === "verified-open",
    summaryEligible:
      classification === "verified-open" && structuredDirectEvidence,
    sourceType,
    reasons: Array.from(new Set(reasons)),
    hasFutureDeadline,
    deadlineKnown,
    buyerKnown,
    solicitationLike,
    bidReadyNotice,
    relevanceEligible,
    purchasedScopeEvidenced,
    relevanceScore: purchasedScopeEvidenced ? relevance.score : Math.min(relevance.score, UNEVIDENCED_SCOPE_SCORE_CAP),
    sourceVerified,
    sourceAuthority: sourceVerified ? "trusted" : aggregator ? "medium" : "low",
    evidenceFingerprint: createHash("sha256")
      .update(
        [
          classification,
          opp.title,
          opp.agency,
          opp.type,
          opp.status,
          opp.postedDate,
          opp.responseDeadline,
          canonicalSamOpportunityUrl(url),
          opp.description,
          opp.estimatedValue,
          opp.awardAmount,
          opp.ceilingValue,
          opp.floorValue,
        ]
          .map((value) => String(value ?? ""))
          .join("|"),
      )
      .digest("hex"),
  };
}

/** Highest score shown or ranked for a record whose purchased scope is not evidenced (below the review band's top). */
export const UNEVIDENCED_SCOPE_SCORE_CAP = 49;

export function qualityMatchesView(
  quality: OpportunityQualityView,
  view: OpportunityViewMode,
): boolean {
  if (view === "all") return true;
  if (view === "actionable") return quality.classification === "verified-open";
  if (view === "needs-verification")
    return (
      quality.classification === "needs-verification" ||
      quality.classification === "discovery-only"
    );
  return ["closed", "archived", "award", "forecast"].includes(
    quality.classification,
  );
}

/** Transparent, bounded best-match score used by the list API before pagination. */
export interface OpportunityRankBreakdown {
  finalRankScore: number;
  baseRelevanceScore: number;
  serviceCoverageBoost: number;
  qualityBoost: number;
  sourceAuthorityBoost: number;
  deadlineBoost: number;
  completenessBoost: number;
  feedbackAdjustment: number;
  statusPenalty: number;
  matchedServiceLines: string[];
}

function numericScore(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}

export function calculateOpportunityRank(
  opp: OpportunityLike,
  quality = classifyOpportunityQuality(opp),
  now = new Date(),
): OpportunityRankBreakdown {
  const judged = classifyResult({
    title: String(opp.title ?? ""),
    snippet: [opp.type, opp.description, opp.solicitationNumber]
      .filter(Boolean).join(" "),
    url: String(opp.samUrl ?? opp.sourceUrl ?? opp.url ?? ""),
    date: opp.postedDate,
    deadlineInFuture: quality.hasFutureDeadline,
    allowHistorical: true,
  });
  // The persisted judge score (or an LLM's self-rating for web records) is historical. It can never lift a record
  // above what current evidence supports: capped when purchased scope is not evidenced, and limited to the current
  // classifier score when the current canonical decision rejects the record.
  const persistedOrJudged = numericScore(opp.relevanceScore) ?? judged.score;
  const currentlyRejected = decideRelevance(judged).verdict === "reject";
  const baseRelevanceScore = Math.min(
    persistedOrJudged,
    quality.purchasedScopeEvidenced ? 100 : UNEVIDENCED_SCOPE_SCORE_CAP,
    currentlyRejected ? judged.score : 100,
  );
  const matchedServiceLines = judged.matchedServiceCategories;
  const serviceCoverageBoost = Math.min(8, matchedServiceLines.length * 1.6);
  const qualityBoost = quality.classification === "verified-open" ? 5
    : quality.classification === "needs-verification" ? 3
    : quality.classification === "discovery-only" ? 1 : 0;
  const sourceAuthorityBoost = quality.sourceType === "official-direct" ? 4
    : quality.sourceType === "verified-solicitation-page" ? 3
    : quality.sourceType === "search-discovery" ? 1
    : quality.sourceType === "aggregator" ? 0 : 1;
  const deadlineBoost = quality.hasFutureDeadline ? 3 : 0;
  const completenessFields = [opp.agency, opp.responseDeadline, opp.description,
    opp.solicitationNumber, opp.location, opp.estimatedValue ?? opp.awardAmount,
    opp.samUrl ?? opp.sourceUrl ?? opp.url];
  const completenessBoost = Math.round(
    (completenessFields.filter((value) => value != null && String(value).trim()).length /
      completenessFields.length) * 3 * 10,
  ) / 10;
  const confidence = numericScore(opp.userConfidence);
  const feedbackAdjustment = confidence == null
    ? 0 : Math.round(Math.max(-7, Math.min(7, ((confidence - 50) / 50) * 7)) * 10) / 10;
  const statusPenalty = quality.hasFutureDeadline || !quality.deadlineKnown
    ? 0 : -15;
  const raw = baseRelevanceScore * 0.7 + serviceCoverageBoost + qualityBoost +
    sourceAuthorityBoost + deadlineBoost + completenessBoost +
    feedbackAdjustment + statusPenalty;
  return {
    finalRankScore: Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10,
    baseRelevanceScore,
    serviceCoverageBoost,
    qualityBoost,
    sourceAuthorityBoost,
    deadlineBoost,
    completenessBoost,
    feedbackAdjustment,
    statusPenalty,
    matchedServiceLines,
  };
}

export interface QualityPageResult<T extends OpportunityLike> {
  data: Array<T & { quality: OpportunityQualityView }>;
  total: number;
}

export function opportunityCollapseKey(opp: OpportunityLike): string {
  const url = canonicalSamOpportunityUrl(
    opp.samUrl ?? opp.sourceUrl ?? opp.url,
  );
  if (url) return `url:${url.toLowerCase()}`;
  const sol = String(opp.solicitationNumber ?? opp.noticeId ?? "")
    .trim()
    .toLowerCase();
  if (sol) {
    const agency = String(opp.agency ?? "")
      .trim()
      .toLowerCase();
    return `sol:${agency}:${sol}`;
  }
  return `id:${opp.id ?? Math.random()}`;
}

export function buildOpportunityQualityPage<T extends OpportunityLike>(
  rows: T[],
  view: OpportunityViewMode,
  page: number,
  limit: number,
  now = new Date(),
): QualityPageResult<T> {
  const accumulator = new OpportunityQualityPageAccumulator<T>(
    view,
    page,
    limit,
    now,
  );
  rows.forEach((row) => accumulator.add(row));
  return accumulator.finish();
}

export class OpportunityQualityPageAccumulator<T extends OpportunityLike> {
  private readonly bestScores = new Map<string, number>();
  private readonly top = new Map<
    string,
    T & { quality: OpportunityQualityView; __qualityRank: number }
  >();
  private readonly offset: number;
  private readonly capacity: number;

  constructor(
    private readonly view: OpportunityViewMode,
    page: number,
    private readonly limit: number,
    private readonly now = new Date(),
  ) {
    this.offset = (Math.max(1, page) - 1) * limit;
    this.capacity = this.offset + limit;
  }

  add(row: T): void {
    // Poor/not-relevant feedback leaves working queues but remains auditable.
    if (this.view !== "all" && ["poor", "spam"].includes(String(row.userGrade))) return;
    const quality = classifyOpportunityQuality(row, this.now);
    if (!qualityMatchesView(quality, this.view)) return;
    const key = opportunityCollapseKey(row);
    const score = calculateOpportunityRank(row, quality, this.now).finalRankScore;
    const previous = this.bestScores.get(key);
    if (previous != null && previous >= score) return;
    this.bestScores.set(key, score);

    this.top.delete(key);
    const candidate = { ...row, quality, __qualityRank: score };
    if (this.top.size < this.capacity) {
      this.top.set(key, candidate);
      return;
    }

    let weakestKey: string | null = null;
    let weakestScore = Number.POSITIVE_INFINITY;
    for (const [candidateKey, current] of this.top) {
      if (current.__qualityRank < weakestScore) {
        weakestKey = candidateKey;
        weakestScore = current.__qualityRank;
      }
    }
    if (weakestKey && score > weakestScore) {
      this.top.delete(weakestKey);
      this.top.set(key, candidate);
    }
  }

  finish(): QualityPageResult<T> {
    const sorted = Array.from(this.top.values()).sort(
      (a, b) => b.__qualityRank - a.__qualityRank,
    );
    return {
      data: sorted
        .slice(this.offset, this.offset + this.limit)
        .map(
          ({ __qualityRank: _rank, ...row }) =>
            row as T & { quality: OpportunityQualityView },
        ),
      total: this.bestScores.size,
    };
  }
}

export type SummaryIneligibilityReason =
  | "authoritative_content_unavailable"
  | "future_deadline_unverified"
  | "discovery_only"
  | "record_not_actionable";

export function summaryIneligibilityReason(
  quality: OpportunityQualityView,
  hasAuthoritativeContent: boolean,
): SummaryIneligibilityReason | null {
  if (quality.classification === "discovery-only") return "discovery_only";
  if (!quality.hasFutureDeadline) return "future_deadline_unverified";
  if (!quality.actionable) return "record_not_actionable";
  if (!hasAuthoritativeContent && !quality.summaryEligible)
    return "authoritative_content_unavailable";
  return null;
}

export function plainSummaryIneligibilityReason(
  reason: SummaryIneligibilityReason,
): string {
  switch (reason) {
    case "authoritative_content_unavailable":
      return "Authoritative solicitation content has not been verified.";
    case "future_deadline_unverified":
      return "A future submission deadline could not be confirmed.";
    case "discovery_only":
      return "This is a discovery lead and must be verified before an AI brief is available.";
    case "record_not_actionable":
      return "This record is not classified as an open, actionable solicitation.";
  }
}

export function summaryEvidenceFingerprint(
  quality: OpportunityQualityView,
  authoritativeContent: unknown,
): string {
  return createHash("sha256")
    .update(
      `${quality.evidenceFingerprint}|${String(authoritativeContent ?? "")
        .replace(/\s+/g, " ")
        .trim()}`,
    )
    .digest("hex");
}

export function isLikelySnippet(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return true;
  return (
    text.length < 800 ||
    /^\.\.\./.test(text) ||
    /\b(search result|snippet|ai analysis pending|web discovery)\b/i.test(text)
  );
}
