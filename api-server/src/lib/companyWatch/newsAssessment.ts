/**
 * Reads an already-retrieved company news article (no API calls) and says:
 *  - whether it reports a government contract award or a solicitation/recompete,
 *  - whether the watched company is the reported WINNER, a company that lost/protested, or only mentioned,
 *  - Occu-Med demand evidence from the OCCU_MED_AWARE profile.
 *
 * A news report is never treated as an official award record: attribution "reported_awardee" means the headline
 * reports the company as the winner; the official record (if found) is shown separately.
 */
import { companyMentionIndex, matchesCompanyNews } from "./companyIdentity";
import { assessOccuMedDemand, type DemandAssessment } from "./occuMedDemand";

export type NewsSignal = "award" | "solicitation" | null;
export type NewsAttribution = "reported_awardee" | "not_awardee" | "mentioned" | "potentially_related" | "none";

export interface NewsArticleInput {
  title: string;
  snippet?: string | null;
  publishedAt?: string | null;
}

export interface NewsAssessment {
  signal: NewsSignal;
  attribution: NewsAttribution;
  attributionNote: string;
  fresh: boolean;
  demand: DemandAssessment;
}

const FRESH_DAYS = 7;
const GOVERNMENT = /\b(?:federal|government|pentagon|department of (?:defense|war|homeland security|energy|state|veterans affairs)|dod|dow|dhs|usaf|u\.?s\.?\s*(?:army|navy|air force|space force|marine corps|government)|army|navy|air force|military|defen[cs]e|sam\.gov|gsa|logcap|afcap|federal aviation administration|nasa|national aeronautics and space administration)\b/i;
const DENIED = /\b(?:not awarded|fails? to win|lost (?:the |a )?(?:bid|contract)|protests? (?:an? |the )?award|award (?:protest|challenged|overturned|cancell?ed|rescinded))\b/i;
const AWARD_VERB = /\b(?:awarded|wins?|won|secures?|secured|receives?|received|lands?|landed|captures?|captured|books?|selected for|nabs?|snags?|bags?|clinches?|contract win|contractor selected)\b/i;
const AWARD_CONTEXT = /\b(?:contract|award|task order|delivery order|idiq|logcap|afcap|recompete)\b/i;
const AWARDED_TO = /\b(?:awards?|awarded|selects?|selected|taps?|tapped|picks?|picked|chooses?|chose)\b/i;
const LOSER_BEFORE = /\b(?:beats?|beat out|defeats?|outbids?|edges? out|over|against|protest(?:s|ed)? by|instead of|rather than)\s+$/i;
const SOLICITATION = /\b(?:solicitation|request for proposals?|request for bids?|request for quotes?|invitation to bid|invitation for bids?|rfp|rfq|recompete|re-competition|seeking bids|issues? (?:a |an )?(?:tender|solicitation)|sources sought|draft rfp)\b/i;

/** Published within the last FRESH_DAYS (and not in the future). */
export function isFresh(publishedAt: string | null | undefined, now = Date.now()): boolean {
  const date = publishedAt ? Date.parse(publishedAt) : NaN;
  return Number.isFinite(date) && date <= now + 86_400_000 && date >= now - FRESH_DAYS * 86_400_000;
}

/** Award / solicitation signal of a government contract article (headline-driven, as before). */
export function newsSignal(article: NewsArticleInput): NewsSignal {
  const headline = article.title;
  const full = `${article.title} ${article.snippet ?? ""}`;
  if (!GOVERNMENT.test(full)) return null;
  if (!DENIED.test(full) && AWARD_VERB.test(headline) && AWARD_CONTEXT.test(full)) return "award";
  // "Army awards $90M contract to KBR", "Navy selects KBR for ... contract"
  const awardedTo = /\b(?:awards?|awarded)\b.*\bto\b/i.test(headline) || /\b(?:selects?|selected|taps?|tapped|picks?|picked|chooses?|chose)\b/i.test(headline);
  if (awardedTo && AWARD_CONTEXT.test(full) && !DENIED.test(full)) return "award";
  if (SOLICITATION.test(headline)) return "solicitation";
  return null;
}

/**
 * Who won, per the headline. The company is the reported winner when it is the subject of the award verb
 * ("KBR wins ...", "Leidos beats KBR to win ...") or the object of "awards ... to" ("Army awards $X contract to KBR").
 * A company named right after "beats/over/against/protested by" is the loser.
 */
export function awardAttribution(headline: string, company: string): NewsAttribution {
  const index = companyMentionIndex(headline, company);
  if (index < 0) return "mentioned";
  const before = headline.slice(0, index);
  if (LOSER_BEFORE.test(before)) return "not_awardee";
  if (DENIED.test(headline)) return "not_awardee";
  // "Army awards $90M contract to KBR" / "... selected KBR"
  if (AWARDED_TO.test(before) && (/\bto\s+(?:the\s+)?$/i.test(before) || /\b(?:selects?|selected|taps?|tapped|picks?|picked|chooses?|chose)\s+(?:the\s+)?$/i.test(before))) {
    return "reported_awardee";
  }
  // "Contract won by Leidos"
  if (/\b(?:won|secured|captured|landed|awarded)\s+by\s+(?:the\s+)?$/i.test(before)) return "reported_awardee";
  const after = headline.slice(index);
  // "KBR protest of Leidos win", "KBR loses ...": the company itself is the challenger/loser.
  if (/^\S+(?:\s+\S+){0,3}?\s+(?:protests?|protested|challenges?|challenged|loses?|lost|fails)\b/i.test(after)
    && !AWARD_VERB.test(after.split(/\b(?:protests?|protested|challenges?|challenged|loses?|lost|fails)\b/i)[0] ?? "")) {
    return "not_awardee";
  }
  // The company is the subject of the award verb ("KBR wins ...", "Leidos beats KBR to win ...").
  const verb = AWARD_VERB.exec(after);
  if (!verb) return "mentioned";
  // "KBR, Fluor among bidders as Amentum wins ...": a clause boundary before the verb gives the verb another subject.
  const between = after.slice(0, verb.index);
  if (/\b(?:as|while|after|among|bidders?|but|despite|instead|loses?|lost|than|says?|said)\b/i.test(between)) return "mentioned";
  return "reported_awardee";
}

export function assessCompanyArticle(article: NewsArticleInput, company: string, now = Date.now()): NewsAssessment {
  const text = `${article.title} ${article.snippet ?? ""}`;
  const fresh = isFresh(article.publishedAt, now);
  const signal = newsSignal(article);
  const demand = assessOccuMedDemand(text, {}, "article_text");
  let attribution: NewsAttribution = matchesCompanyNews(text, company) ? "mentioned" : "none";
  let attributionNote = attribution === "mentioned" ? `${company} is mentioned.` : `${company} is not named in the headline or summary.`;
  if (signal === "award") {
    attribution = awardAttribution(article.title, company);
    attributionNote = attribution === "reported_awardee"
      ? `The headline reports ${company} as the award winner (news report, not an official award record).`
      : attribution === "not_awardee"
        ? `${company} is named as a competing, losing or protesting bidder, not the winner.`
        : `${company} is mentioned, but the headline does not name it as the winner.`;
  } else if (signal === "solicitation" && attribution === "mentioned") {
    attribution = "potentially_related";
    attributionNote = `Solicitation news that mentions ${company}; this does not establish that ${company} is bidding or is the incumbent.`;
  }
  return { signal, attribution, attributionNote, fresh, demand };
}
