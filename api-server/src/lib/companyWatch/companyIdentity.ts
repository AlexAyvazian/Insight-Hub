/**
 * Company identity for Company Watch: one place that decides whether a piece of text names a watched company.
 *
 * Two strengths:
 *  - `matchesCompanyNews`: the company is MENTIONED (news association). Exact name, the name without its legal
 *    suffix, or an established abbreviation, on word boundaries. No loose substring matches.
 *  - `matchesAwardee`: the company IS the named recipient of an official award. The recipient text must START with
 *    the company's name or one of its documented legal-name aliases ("KBR Wyle Services LLC" is KBR; "International
 *    SOS Government Services" is not "SOS International"). All-capital short aliases (KBR, SNC, GDIT) must match in
 *    their exact case so ordinary words never count.
 */

/** Established abbreviations that news uses for a watched company (mention strength). */
const NEWS_ALIASES: Record<string, string[]> = {
  "general dynamics information technology": ["GDIT"],
  "sierra nevada corporation": ["Sierra Nevada", "SNC"],
  "fluor corporation": ["Fluor"],
  "caci international": ["CACI"],
  "v2x": ["Vectrus"],
  "vectrus": ["V2X"],
  "mantech international": ["ManTech"],
  "jacobs technology": ["Jacobs"],
  "american bureau of shipping": ["ABS"],
};

/**
 * Legal-name forms under which a watched company (or its wholly owned operating units) appears as an award
 * recipient in official records. Only names that unambiguously belong to the company are listed.
 */
const AWARDEE_ALIASES: Record<string, string[]> = {
  "kbr": ["KBR", "Kellogg Brown & Root", "Kellogg Brown and Root"],
  "v2x": ["V2X", "Vectrus Systems", "Vectrus Mission Solutions", "Vertex Aerospace"],
  "vectrus": ["V2X", "Vectrus Systems", "Vectrus Mission Solutions"],
  "general dynamics information technology": ["General Dynamics Information Technology", "GDIT"],
  "jacobs technology": ["Jacobs Technology", "Jacobs Engineering Group", "Jacobs Government Services"],
  "sierra nevada corporation": ["Sierra Nevada Corporation", "Sierra Nevada Corp", "Sierra Nevada Company"],
  "fluor corporation": ["Fluor Corporation", "Fluor Corp", "Fluor Intercontinental", "Fluor Federal", "Fluor Enterprises"],
  "caci international": ["CACI"],
  "mantech international": ["ManTech"],
  "iap worldwide services": ["IAP Worldwide Services", "IAP Worldwide", "IAP Global Services"],
  "iap": ["IAP Worldwide Services", "IAP Worldwide", "IAP Global Services"],
  "bae systems": ["BAE Systems"],
  "amentum": ["Amentum"],
  "leidos": ["Leidos"],
};

const LEGAL_SUFFIX = /[\s,]+(?:corporation|corp\.?|inc\.?|incorporated|llc|l\.l\.c\.|ltd\.?|limited|company|co\.?|holdings?|group|lp|l\.p\.)$/i;

const escapeRegex = (value: string): string => value.replace(/[.*+?^$()|{}[\]\\]/g, "\\$&");
const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

export function companyKey(company: string): string {
  return collapse(company).toLowerCase();
}

/** Company name without a trailing legal suffix ("Fluor Corporation" -> "Fluor"). */
export function coreCompanyName(company: string): string {
  let core = collapse(company);
  for (let i = 0; i < 2; i++) core = core.replace(LEGAL_SUFFIX, "").trim();
  return core || collapse(company);
}

/** An all-capital short token (KBR, SNC, GDIT, V2X) is an acronym: it must match in its exact case. */
function isAcronym(value: string): boolean {
  return value.length <= 5 && /^[A-Z0-9&]+$/.test(value) && /[A-Z]/.test(value);
}

function boundaryRegex(value: string, anchored: boolean): RegExp {
  const body = escapeRegex(value).replace(/ /g, "\\s+");
  const flags = isAcronym(value) ? "u" : "iu";
  return new RegExp((anchored ? "^\\s*(?:the\\s+)?" : "(^|[^\\p{L}\\p{N}])") + body + "(?=$|[^\\p{L}\\p{N}])", flags);
}

export function newsVariants(company: string): string[] {
  const key = companyKey(company);
  return [...new Set([collapse(company), coreCompanyName(company), ...(NEWS_ALIASES[key] ?? [])])].filter(value => value.length >= 3);
}

export function awardeeVariants(company: string): string[] {
  const key = companyKey(company);
  return [...new Set([collapse(company), coreCompanyName(company), ...(AWARDEE_ALIASES[key] ?? [])])].filter(value => value.length >= 3);
}

/** The company is mentioned in the text (exact name / core name / established abbreviation). */
export function matchesCompanyNews(text: string, company: string): boolean {
  return newsVariants(company).some(value => boundaryRegex(value, false).test(text));
}

/** Position of the first mention of the company in the text, or -1. */
export function companyMentionIndex(text: string, company: string): number {
  let best = -1;
  for (const value of newsVariants(company)) {
    const match = boundaryRegex(value, false).exec(text);
    if (!match) continue;
    const index = match.index + (match[1]?.length ?? 0);
    if (best === -1 || index < best) best = index;
  }
  return best;
}

/**
 * name: the recipient starts with the watched name. alias: a documented legal-name alias.
 * short_name: only a short acronym-like watched name (e.g. "GDC") with no documented alias matched; official records
 * are upper-case, so such a match is shown as a POSSIBLE match, never as a confirmed award.
 */
export type AwardeeMatch = { variant: string; basis: "name" | "alias" | "short_name" };

/**
 * The recipient text names this company as the award recipient. `recipient` is the recipient field of an official
 * record, or one entry of a multi-awardee list. The recipient must START with the company name or alias.
 */
export function matchesAwardee(recipient: string, company: string): AwardeeMatch | null {
  const text = collapse(recipient);
  if (!text) return null;
  const own = new Set([collapse(company), coreCompanyName(company)].map(value => value.toLowerCase()));
  const documented = companyKey(company) in AWARDEE_ALIASES;
  for (const variant of awardeeVariants(company)) {
    if (!boundaryRegex(variant, true).test(text)) continue;
    if (!own.has(variant.toLowerCase())) return { variant, basis: "alias" };
    return { variant, basis: isAcronym(variant) && !documented ? "short_name" : "name" };
  }
  return null;
}

/** Splits a multi-awardee span ("A, City, State (W9..); B, City ...; and C, ...") into one entry per recipient. */
export function splitAwardees(span: string): string[] {
  return span
    .split(/;\s*(?:and\s+)?|\n+/)
    .map(entry => collapse(entry.replace(/^\s*(?:and|&)\s+/i, "")))
    .filter(entry => entry.length > 2);
}

/** The first matching entry of a multi-awardee span, with its match. */
export function findAwardee(span: string, company: string): { recipient: string; match: AwardeeMatch } | null {
  for (const recipient of splitAwardees(span)) {
    const match = matchesAwardee(recipient, company);
    if (match) return { recipient, match };
  }
  return null;
}
