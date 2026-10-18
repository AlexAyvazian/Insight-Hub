/** Shared Occu-Med opportunity relevance engine powered by the procurement ontology. */
import { REASON_CODES } from "./relevanceReasonCodes";
import { getRelevanceProfile, type ProfileSource } from "./relevanceProfile";
import { evaluateRules } from "./profileRules";

export const CURRENT_YEAR = new Date().getFullYear();
export const BLOCKED_DOMAINS = [
  "indeed.com",
  "linkedin.com",
  "ziprecruiter.com",
  "glassdoor.com",
  "talent.com",
  "monster.com",
  "careerbuilder.com",
  "simplyhired.com",
  "snagajob.com",
  "dice.com",
  "lensa.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "reddit.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "wikipedia.org",
  "britannica.com",
  "webmd.com",
  "healthline.com",
  "mayoclinic.org",
  "wikihow.com",
];
const PROCUREMENT_DOMAINS = [
  ".gov",
  "sam.gov",
  "demandstar.com",
  "bidsync.com",
  "bidnet.com",
  "publicpurchase.com",
  "bonfirehub.com",
  "planetbids.com",
  "ionwave.net",
  "periscopeholdings.com",
  "grants.gov",
  "merx.com",
  "govwin.com",
];
function norm(s: string | null | undefined): string {
  return ` ${(s ?? "").toLowerCase().replace(/[\s\n\r]+/g, " ")} `;
}
function uniq(a: string[]): string[] {
  return Array.from(new Set(a));
}
/**
 * How profile terms are matched against notice text.
 *  - "token" (default, Opportunities): a term must start on a word boundary, and short terms (<= 5 chars, i.e.
 *    acronyms such as sts / der / ems / dot / lead) must also end on one (a plural "s" is allowed: RFPs, IDIQs). "sts" no longer matches "costs",
 *    "der" no longer matches "provider", "vision" no longer matches "division", "tender" no longer matches
 *    "bartender". Longer terms keep inflections ("examination" still matches "examinations").
 *  - "substring": the legacy containment match. Kept only for consumers outside Opportunities (Forecasts /
 *    Recompete ranking, intel feeds) so their behavior is unchanged until they are measured separately.
 */
export type RelevanceMatchMode = "token" | "substring";
const SHORT_TERM_MAX = 5;
const termRegexCache = new Map<string, RegExp>();
function termRegex(term: string): RegExp {
  let re = termRegexCache.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const start = /^[\p{L}\p{N}]/u.test(term) ? "(?<![\\p{L}\\p{N}])" : "";
    const end = term.length <= SHORT_TERM_MAX && /[\p{L}\p{N}]$/u.test(term) ? "s?(?![\\p{L}\\p{N}])" : "";
    re = new RegExp(start + esc + end, "u");
    termRegexCache.set(term, re);
  }
  return re;
}
function termMatches(h: string, term: string, mode: RelevanceMatchMode): boolean {
  const t = term.toLowerCase();
  if (!t || !h.includes(t)) return false;
  return mode === "substring" || termRegex(t).test(h);
}
function matchTerms(h: string, terms: string[], mode: RelevanceMatchMode = "token"): string[] {
  return uniq(terms.filter((t) => termMatches(h, t, mode)));
}
function firstMatch(h: string, terms: string[], mode: RelevanceMatchMode = "token"): string | null {
  return matchTerms(h, terms, mode)[0] ?? null;
}
function hasAny(h: string, terms: string[], mode: RelevanceMatchMode = "token"): boolean {
  return terms.some((t) => termMatches(h, t, mode));
}
export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return null;
  }
}
export function isBlockedDomain(url: string | null | undefined): boolean {
  const host = hostFromUrl(url);
  return (
    !!host && BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
  );
}
export function parseResultDate(
  raw: string | Date | null | undefined,
): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const s = raw.trim().toLowerCase();
  const rel = s.match(/(\d+)\s+(hour|day|week|month|year)s?\s+ago/);
  if (rel) {
    const d = new Date();
    const n = +rel[1];
    const u = rel[2];
    if (u === "hour") d.setHours(d.getHours() - n);
    else if (u === "day") d.setDate(d.getDate() - n);
    else if (u === "week") d.setDate(d.getDate() - 7 * n);
    else if (u === "month") d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    return d;
  }
  if (/(yesterday|today|hours? ago|minutes? ago)/.test(s)) return new Date();
  const p = new Date(raw);
  return !Number.isNaN(p.getTime()) &&
    p.getFullYear() >= 2000 &&
    p.getFullYear() <= CURRENT_YEAR + 2
    ? p
    : null;
}

export interface RelevanceInput {
  title?: string | null;
  snippet?: string | null;
  description?: string | null;
  url?: string | null;
  date?: string | Date | null;
  deadlineInFuture?: boolean;
  keywords?: string | null;
  allowHistorical?: boolean;
  /** Term matching semantics; defaults to "token". See RelevanceMatchMode. */
  matchMode?: RelevanceMatchMode;
}
export type RelevanceConfidence =
  | "verified_explicit"
  | "strong_combination"
  | "possible_adjacent"
  | "insufficient"
  | "rejected";
export interface RelevanceResult {
  score: number;
  reasons: string[];
  rejected: boolean;
  rejectReason: string | null;
  category: string | null;
  publishedDate: Date | null;
  stale: boolean;
  primaryServiceCategory: string | null;
  matchedServiceCategories: string[];
  matchedExplicitPhrases: string[];
  matchedComponentTerms: string[];
  matchedProcurementSignals: string[];
  matchedWorkforceSignals: string[];
  matchedRegulatorySignals: string[];
  negativeSignals: string[];
  reasonCodes: string[];
  confidence: RelevanceConfidence;
  /** Which relevance profile produced this result: live Neon, the verified cache, or "unavailable" (fail closed). */
  profileSource: ProfileSource;
  /** SHA-256 version of the profile rows that produced this result. */
  profileVersion: string;
}

function rejected(
  reason: string,
  input: RelevanceInput,
  reasonCodes = [REASON_CODES.hardReject],
  extras: Partial<RelevanceResult> = {},
): RelevanceResult {
  return {
    score: 0,
    reasons: [reason],
    rejected: true,
    rejectReason: reason,
    category: null,
    publishedDate: parseResultDate(input.date ?? null),
    stale: false,
    primaryServiceCategory: null,
    matchedServiceCategories: [],
    matchedExplicitPhrases: [],
    matchedComponentTerms: [],
    matchedProcurementSignals: [],
    matchedWorkforceSignals: [],
    matchedRegulatorySignals: [],
    negativeSignals: [],
    reasonCodes,
    confidence: "rejected",
    profileSource: getRelevanceProfile().source,
    profileVersion: getRelevanceProfile().version,
    ...extras,
  };
}

export function classifyResult(input: RelevanceInput): RelevanceResult {
  const profile = getRelevanceProfile();
  const haystack = norm(
    [input.title, input.snippet, input.description].filter(Boolean).join(" "),
  );
  const titleNorm = norm(input.title);
  const mode: RelevanceMatchMode = input.matchMode ?? "token";
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  if (isBlockedDomain(input.url))
    return rejected("Excluded: job board / non-procurement domain", input);
  const matchedProcurementSignals = matchTerms(haystack, profile.procurementSignals, mode);
  const hasProc = matchedProcurementSignals.length > 0;
  // Every hard reject, scope rule, conditional penalty, soft penalty and program
  // combination below comes from the Neon rules; none is defined in this file.
  const rules = evaluateRules(profile, {
    title: titleNorm,
    haystack,
    hasProcurementSignal: hasProc,
  });
  if (rules.hardReject)
    return rejected(
      rules.hardReject.reason,
      input,
      [REASON_CODES.hardReject],
      { negativeSignals: [`${rules.hardReject.ruleKey}: ${rules.hardReject.trigger}`] },
    );
  const matchedWorkforceSignals = matchTerms(haystack, profile.workforceSignals, mode);
  const matchedRegulatorySignals = matchTerms(haystack, profile.regulatory, mode);
  const matchedExplicitPhrases: string[] = [];
  const matchedComponentTerms: string[] = [];
  const matchedServiceCategories: string[] = [];
  const adjacentTerms = new Set(
    profile.categories
      .filter((c) => c.adjacentOnly)
      .flatMap((c) => c.component.concat(c.explicit)),
  );
  let adjacentOnly = false;
  for (const c of profile.categories) {
    const ex = matchTerms(haystack, c.explicit, mode);
    const comp = matchTerms(haystack, c.component, mode);
    const reg = matchTerms(haystack, c.regulatory, mode);
    if (ex.length || comp.length || reg.length) {
      matchedServiceCategories.push(c.label);
      matchedExplicitPhrases.push(...ex);
      matchedComponentTerms.push(...comp);
      matchedRegulatorySignals.push(...reg);
      if (c.adjacentOnly) adjacentOnly = true;
    }
  }
  const profilePhraseHits = matchTerms(haystack, profile.generalExplicit, mode);
  if (profilePhraseHits.length > 0) {
    matchedServiceCategories.push("Occu-Med profile phrase");
    matchedExplicitPhrases.push(...profilePhraseHits);
  }
  const negativeSignals: string[] = [...rules.negativeSignals];
  const conditionalPenalty = rules.conditionalPenalty;
  if (negativeSignals.length) reasonCodes.push(REASON_CODES.negative);
  const explicit =
    matchedExplicitPhrases.filter((p) => !adjacentTerms.has(p)).length > 0;
  const componentCount = uniq(
    matchedComponentTerms.filter((t) => !adjacentTerms.has(t)),
  ).length;
  const hasWorkOrReg =
    matchedWorkforceSignals.length > 0 || matchedRegulatorySignals.length > 0;
  const networkLabel =
    profile.categories.find((c) => c.id === profile.networkCategoryId)?.label ??
    null;
  const hasNetwork =
    networkLabel !== null && matchedServiceCategories.includes(networkLabel);
  const regulatoryProgram = rules.programMatches.length > 0;

  // Require a medical word in the title for the component-based path, so that
  // general procurement wording cannot carry a notice on its own.
  const titleHasMedical = hasAny(titleNorm, profile.titleMedical, mode);

  const pathA = hasProc && explicit;
  const pathC = hasProc && regulatoryProgram;
  const pathD =
    hasProc && hasNetwork && titleHasMedical && rules.networkServiceEvidence;
  const pathBStrict =
    hasProc && componentCount >= 2 && hasWorkOrReg && titleHasMedical;
  const pathE =
    hasProc &&
    hasAny(titleNorm, profile.genericTitle, mode) &&
    (explicit || pathBStrict || pathC || pathD);

  const accepted =
    (pathA || pathBStrict || pathC || pathD || pathE) && conditionalPenalty < 40;
  if (pathA) {
    reasons.push("Explicit Occu-Med service phrase with procurement signal");
    reasonCodes.push(REASON_CODES.explicit);
  }
  if (pathBStrict) {
    reasons.push(
      "Multiple compatible medical/test components with workforce or regulatory context and medical title",
    );
    reasonCodes.push(REASON_CODES.component);
  }
  if (pathC) {
    reasons.push("High-specificity regulatory/program combination");
    reasonCodes.push(REASON_CODES.regulatory);
  }
  if (pathD) {
    reasons.push(
      "Managed delivery/network scope with medical service evidence",
    );
    reasonCodes.push(REASON_CODES.network);
  }
  if (pathE) {
    reasons.push(
      "Generic title accepted because scope contains Occu-Med service evidence",
    );
    reasonCodes.push(REASON_CODES.genericScope);
  }
  if (hasProc && !explicit && componentCount === 0) {
    reasons.push("Procurement wording alone is not Occu-Med relevance");
    reasonCodes.push(REASON_CODES.procurementOnly);
  }
  let score = pathA
    ? 82
    : pathC
      ? 80
      : pathBStrict
        ? 74
        : pathD
          ? 72
          : pathE
            ? 76
            : hasProc && componentCount > 0
              ? 48
              : explicit
                ? 55
                : 20;
  if (matchedWorkforceSignals.length) score += 5;
  if (matchedRegulatorySignals.length) score += 5;
  if (input.deadlineInFuture) score += 8;
  if (hasAny(haystack, profile.prime, mode)) score += 6;
  if (adjacentOnly && !explicit && componentCount < 2) score -= 25;
  const host = hostFromUrl(input.url);
  if (
    host &&
    PROCUREMENT_DOMAINS.some(
      (d) => host === d.replace(/^\./, "") || host.endsWith(d),
    )
  )
    reasons.push(
      "Procurement/government source noted but not sufficient by itself",
    );
  const publishedDate = parseResultDate(input.date ?? null);
  let stale = false;
  if (publishedDate) {
    const y = publishedDate.getFullYear();
    if (y < CURRENT_YEAR - 1 && !input.allowHistorical) {
      stale = true;
      score -= 15;
      reasons.push(`Older result (${y}) ranked down`);
    }
  } else {
    score -= 3;
    reasons.push("Date unknown");
  }
  for (const soft of rules.softPenalties) {
    score -= soft.penalty;
    reasons.push(`${soft.reason} ("${soft.trigger.trim()}")`);
  }
  score = Math.max(0, Math.min(100, score - conditionalPenalty));
  const confidence: RelevanceConfidence = !accepted
    ? score >= profile.thresholds.reviewMin
      ? "insufficient"
      : "rejected"
    : pathA
      ? "verified_explicit"
      : adjacentOnly
        ? "possible_adjacent"
        : "strong_combination";
  return {
    score,
    reasons,
    rejected: !accepted,
    rejectReason: accepted
      ? null
      : negativeSignals.length
        ? "Conditional false-positive rule failed"
        : "Insufficient Occu-Med service evidence with procurement signal",
    category: matchedServiceCategories[0] ?? null,
    publishedDate,
    stale,
    primaryServiceCategory: matchedServiceCategories[0] ?? null,
    matchedServiceCategories: uniq(matchedServiceCategories),
    matchedExplicitPhrases: uniq(matchedExplicitPhrases),
    matchedComponentTerms: uniq(matchedComponentTerms),
    matchedProcurementSignals: uniq(matchedProcurementSignals),
    matchedWorkforceSignals: uniq(matchedWorkforceSignals),
    matchedRegulatorySignals: uniq(matchedRegulatorySignals),
    negativeSignals: uniq(negativeSignals),
    reasonCodes: uniq(reasonCodes),
    confidence,
    profileSource: profile.source,
    profileVersion: profile.version,
  };
}
export function isRfpCandidate(
  title: string,
  snippet: string,
  url?: string,
): boolean {
  if (isBlockedDomain(url)) return false;
  const r = classifyResult({ title, snippet, url, allowHistorical: true });
  return !r.rejected && r.matchedProcurementSignals.length > 0;
}
export function passesQualityFilter(opp: {
  title?: string | null;
  description?: string | null;
  samUrl?: string | null;
  sourceUrl?: string | null;
}): boolean {
  const title = opp.title ?? "";
  if (title.trim().length < 8) return false;
  return !classifyResult({
    title,
    snippet: opp.description ?? "",
    url: opp.samUrl ?? opp.sourceUrl ?? null,
    allowHistorical: true,
  }).rejected;
}
