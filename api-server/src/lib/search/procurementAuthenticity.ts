/**
 * Procurement authenticity: "is this page an actual procurement notice?"
 *
 * The relevance classifier answers "does this text describe an Occu-Med service being bought?". Web discovery feeds it
 * arbitrary pages, and a page can carry Occu-Med service vocabulary without being a notice at all: an employer RFP
 * checklist article, a regulation, a terms-of-service page, an aggregator search-results page, an addendum to an
 * unrelated bid. This module classifies the page itself from original-source evidence (provider role, URL host and
 * path, title patterns, procurement metadata) and is applied after the relevance classifier. It only ever
 * downgrades: clear non-procurement pages are rejected, ambiguous ones are held for review, nothing is lifted.
 *
 * It holds no service vocabulary and no relevance policy; those stay in the canonical Occu-Med profile.
 *
 * Scope: web-discovery records (search, crawl and browser-discovery providers). Structured official sources (SAM.gov,
 * Tango, official portal APIs) are trusted as notices; for them only the official notice-type metadata is read
 * (a Justification or Award Notice is post-award, not an open solicitation).
 */
import { REASON_CODES } from "./relevanceReasonCodes";
import { hostFromUrl, type RelevanceResult } from "./relevance";
import { getRelevanceProfile, type RelevanceProfile } from "./relevanceProfile";

/** Sources whose records are pages found by web search, crawling or browser discovery (not structured notices). */
const WEB_DISCOVERY_SOURCES = new Set([
  "aiDiscovery",
  "browserbase",
  "exa",
  "firecrawl",
  "jina",
  "keenable",
  "langsearch",
  "linkup",
  "olostep",
  "parallel",
  "publicPortalProviders",
  "selfHostedCrawler",
  "selfHostedSearch",
  "serper",
  "tavily",
  "tinyfish",
  "websearch",
  "you",
]);

export function isWebDiscoverySource(source: string | null | undefined): boolean {
  return WEB_DISCOVERY_SOURCES.has(String(source ?? ""));
}

export type ProcurementPageKind =
  | "procurement_notice"
  | "post_award_notice"
  | "legal_or_policy_page"
  | "regulation"
  | "guidance_article"
  | "commercial_page"
  | "award_or_closed"
  | "supplemental_document"
  | "listing_page";

export interface AuthenticityAssessment {
  kind: ProcurementPageKind;
  /** none: treat as a notice. review: hold, never auto-accept. reject: not a procurement notice. */
  action: "none" | "review" | "reject";
  reason: string | null;
  /** Procurement metadata found on the record (solicitation number, deadline, NAICS/PSC). */
  procurementMetadata: string[];
}

export interface AuthenticityInput {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  source?: string | null;
  type?: string | null;
  solicitationNumber?: string | null;
  naicsCode?: string | null;
  pscCode?: string | null;
  responseDeadline?: Date | null;
}

const OFFICIAL_HOST_SUFFIXES = [".gov", ".mil", ".gov.uk", ".gc.ca", ".gov.au", ".us"];
const PROCUREMENT_HOSTS = [
  "sam.gov",
  "bidnetdirect.com",
  "bonfirehub.com",
  "commbuys.com",
  "demandstar.com",
  "ionwave.net",
  "nevadaepro.com",
  "periscopeholdings.com",
  "planetbids.com",
  "publicpurchase.com",
  "bidsandtenders.ca",
];

/** Official notice types that mark a post-award record rather than an open solicitation. */
const POST_AWARD_TYPE_RE = /^\s*(justification|j&a|award notice|award|notice of award|intent to award)\b/i;

/** Words that make a title read as a notice (as opposed to an article or a policy page). */
const NOTICE_TITLE_RE =
  /\b(rfps?|rfqs?|rfis?|itbs?|ifbs?|soq|request for (proposals?|quotes?|quotations?|qualifications|information|bids?)|invitation (for|to) (bids?|tender)|solicitation|sources sought|presolicitation|bid (no\.?|number|#)|tender (no\.?|number|#))\b/i;

/** A solicitation / bid identifier, e.g. "RFP 26-114", "Solicitation: HT941026Q2050", "Bid #2026-01". */
const SOLICITATION_ID_RE =
  /\b(?:rfp|rfq|rfi|itb|ifb|soq|bid|tender|solicitation|contract|project)\s*(?:no\.?|number|#|:)?\s*[A-Z0-9]*\d[A-Z0-9]*(?:[-_/.][A-Z0-9]+)+\b|\bsolicitation\s*(?:no\.?|number|#|:)\s*[A-Z0-9-]{5,}\b/i;

const LEGAL_TITLE_RE =
  /\b(terms (of|and) (service|use)|terms & conditions of use|privacy (policy|notice|statement)|cookie (policy|notice)|website disclaimer|accessibility statement|end user license)\b/i;
const LEGAL_PATH_RE = /\/(terms-of-service|terms-of-use|terms-and-conditions|tos|privacy-policy|privacy|cookie-policy|cookies|legal|disclaimer)(\/|\.|$)/i;

const REGULATION_TITLE_RE =
  /\b(regulation set|federal regulations?|state regulations?|administrative code|admin\.? code|administrative rules?|code of (federal )?regulations|\d+\s*c\.?f\.?r\.?(\s|$)|statutes?|revised code|general laws|ordinance no\.?)\b|§/i;

const GUIDANCE_TITLE_RE =
  /\b(checklist|guide|guidance|how to|tips|best practices|what (to|you need to|employers need to|you should) (know|expect)|explained|faqs?|frequently asked questions|template|primer|webinar|white ?paper|case study|blog|newsletter|press release)\b|\?\s*$/i;

const COMMERCIAL_TITLE_RE =
  /\b(about us|contact us|our services|our team|our locations|request a demo|get a (free )?quote|book (an )?appointment|schedule (an )?appointment|pricing|testimonials|near me|why choose)\b/i;
const ARTICLE_OR_MARKETING_PATH_RE = /\/(blog|news|articles?|insights|resources|guides?|services|solutions|about(-us)?|contact(-us)?|learn)(\/|$)/i;

const AWARD_TITLE_RE =
  /\b(award notice|notice of (intent to )?award|intent to award|awarded to|contract award(ed)?|bid (results?|tabulations?)|tabulation of bids|award recommendation)\b/i;
const CLOSED_TITLE_RE =
  /^\s*(closed|cancell?ed|expired|archived)\b|[[(](closed|cancell?ed|expired|archived|awarded)[\])]|\b(bid )?status\s*:\s*(closed|cancell?ed|awarded|expired)\b/i;

const SUPPLEMENTAL_TITLE_RE =
  /\b(addendum|addenda|amendment (no\.?|#)\s*\d+|questions? (and|&) answers|q\s*&\s*a|pre-?(bid|proposal) (conference|meeting)( minutes)?|sign-?in sheet|plan ?holders? list)\b/i;

const LISTING_TITLE_RE =
  /^\s*(corporate |public |current |open )?(procurement|purchasing|bids?|tenders?|solicitations|bid opportunities|procurement opportunities|contract opportunities)(\s*(and|&|\/|,)\s*(rfps?|rfqs?|tenders|bids|solicitations|contracts|opportunities))*\s*([-–|:]|$)|\bbids\b[^|]*\brfps?\b[^|]*government contracts\s*$/i;
const LISTING_PATH_RE = /\/(q|search|search-results|results)(\/|$)/i;
const LISTING_QUERY_RE = /[?&](q|query|keywords?|search|s)=/i;

/**
 * Sections of third-party listing pages that describe OTHER notices ("Similar active RFPs"). Their text is not
 * evidence about this notice and is dropped before classification.
 */
const CROSS_LISTING_RE =
  /\b(similar (active |open )?(rfps|bids|opportunities|contracts|tenders|solicitations)|adjacent opportunities|related (rfps|bids|opportunities|contracts|tenders|solicitations)|other (rfps|bids|opportunities) you may|you may also (like|be interested))\b/i;

export function ownNoticeText(description: string | null | undefined): string {
  const text = description ?? "";
  const m = CROSS_LISTING_RE.exec(text);
  return m ? text.slice(0, m.index) : text;
}

function isOfficialHost(host: string | null): boolean {
  if (!host) return false;
  return (
    OFFICIAL_HOST_SUFFIXES.some((s) => host.endsWith(s)) ||
    PROCUREMENT_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))
  );
}

function procurementMetadata(input: AuthenticityInput): string[] {
  const found: string[] = [];
  const text = `${input.title ?? ""} ${input.description ?? ""}`;
  if (input.solicitationNumber?.trim()) found.push("solicitation_number");
  else if (SOLICITATION_ID_RE.test(text)) found.push("solicitation_id_in_text");
  if (input.responseDeadline && !Number.isNaN(input.responseDeadline.getTime())) found.push("response_deadline");
  if (input.naicsCode?.trim()) found.push("naics");
  if (input.pscCode?.trim()) found.push("psc");
  return found;
}

function urlParts(url: string | null | undefined): { host: string | null; path: string; query: string } {
  const host = hostFromUrl(url);
  if (!url) return { host, path: "", query: "" };
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return { host, path: u.pathname, query: u.search };
  } catch {
    return { host, path: "", query: "" };
  }
}

export function assessProcurementAuthenticity(input: AuthenticityInput): AuthenticityAssessment {
  const metadata = procurementMetadata(input);
  const result = (kind: ProcurementPageKind, action: AuthenticityAssessment["action"], reason: string | null): AuthenticityAssessment => ({
    kind,
    action,
    reason,
    procurementMetadata: metadata,
  });

  // Official notice-type metadata applies to every source.
  if (input.type && POST_AWARD_TYPE_RE.test(input.type)) {
    return result("post_award_notice", "review", `Notice type "${input.type.trim()}" is post-award, not an open solicitation; held for review`);
  }
  if (!isWebDiscoverySource(input.source)) return result("procurement_notice", "none", null);

  const title = (input.title ?? "").trim();
  const { host, path, query } = urlParts(input.url);
  const official = isOfficialHost(host);
  const noticeTitle = NOTICE_TITLE_RE.test(title);
  const hasMetadata = metadata.length > 0;

  if (LEGAL_TITLE_RE.test(title) || (!noticeTitle && LEGAL_PATH_RE.test(path))) {
    return result("legal_or_policy_page", "reject", "Not a procurement notice: terms of service / privacy / legal policy page");
  }
  if (REGULATION_TITLE_RE.test(title)) {
    return noticeTitle || hasMetadata
      ? result("regulation", "review", "Title reads as a regulation or statute; held for review")
      : result("regulation", "reject", "Not a procurement notice: regulation, statute or administrative code text");
  }
  if (GUIDANCE_TITLE_RE.test(title)) {
    return hasMetadata || official
      ? result("guidance_article", "review", "Title reads as a guidance article; held for review")
      : result("guidance_article", "reject", "Not a procurement notice: guidance article, checklist or commentary");
  }
  if (COMMERCIAL_TITLE_RE.test(title)) {
    return noticeTitle || hasMetadata || official
      ? result("commercial_page", "review", "Title reads as a commercial service page; held for review")
      : result("commercial_page", "reject", "Not a procurement notice: commercial marketing or service page");
  }
  if (AWARD_TITLE_RE.test(title)) {
    return result("award_or_closed", "reject", "Not an open procurement: award notice or bid results");
  }
  if (CLOSED_TITLE_RE.test(title)) {
    return result("award_or_closed", "review", "Notice is marked closed, cancelled or archived; held for review");
  }
  if (SUPPLEMENTAL_TITLE_RE.test(title)) {
    return result("supplemental_document", "review", "Addendum or supplemental bid document, not the notice itself; held for review");
  }
  if (LISTING_TITLE_RE.test(title) || LISTING_PATH_RE.test(path) || LISTING_QUERY_RE.test(query)) {
    return result("listing_page", "review", "Procurement listing or search-results page, not a single notice; held for review");
  }
  if (!official && !noticeTitle && !hasMetadata && ARTICLE_OR_MARKETING_PATH_RE.test(path)) {
    return result("commercial_page", "review", "Article or marketing page path with no procurement metadata; held for review");
  }
  return result("procurement_notice", "none", null);
}

/**
 * Apply an assessment to a relevance result. Only downgrades: a rejected result is never lifted, a review hold caps
 * the score below the canonical accept threshold, a reject marks the result rejected.
 */
export function applyProcurementAuthenticity(
  relevance: RelevanceResult,
  assessment: AuthenticityAssessment,
  profile: RelevanceProfile = getRelevanceProfile(),
): RelevanceResult {
  if (assessment.action === "none" || !assessment.reason) return relevance;
  const { acceptMin, reviewMin } = profile.thresholds;
  const signal = `authenticity: ${assessment.kind}`;
  if (assessment.action === "reject") {
    if (relevance.rejected && relevance.confidence === "rejected") return relevance;
    return {
      ...relevance,
      score: Number.isFinite(reviewMin) ? Math.min(relevance.score, reviewMin - 1) : relevance.score,
      rejected: true,
      rejectReason: assessment.reason,
      reasons: [...relevance.reasons, assessment.reason],
      negativeSignals: [...relevance.negativeSignals, signal],
      reasonCodes: [...relevance.reasonCodes, REASON_CODES.notProcurementNotice],
      confidence: "rejected",
    };
  }
  if (relevance.rejected) return relevance;
  return {
    ...relevance,
    score: Number.isFinite(acceptMin) ? Math.min(relevance.score, acceptMin - 1) : relevance.score,
    rejected: true,
    rejectReason: assessment.reason,
    reasons: [...relevance.reasons, assessment.reason],
    reasonCodes: [...relevance.reasonCodes, REASON_CODES.authenticityHold],
    confidence: "insufficient",
  };
}
