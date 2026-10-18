/**
 * Conservative purchased-scope evidence for the Opportunities tab ONLY.
 * Vocabulary comes exclusively from the OCCU_MED_AWARE relevance profile.
 * Missing evidence moves candidates to review; no records are deleted.
 */
import { getRelevanceProfile, type RelevanceProfile } from "./search/relevanceProfile";

function words(value: string): string {
  // Normalize common abbreviations/inflections, not service vocabulary.
  // The list of *relevant services* remains owned by OCCU_MED_AWARE.
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    .split(/\s+/)
    .map((word) => word === "lab" ? "laboratory"
      : ["exam", "exams", "examinations"].includes(word) ? "examination"
      : singular(word))
    .join(" ");
}

/** Symmetric plural folding (applied to both text and phrase): "physicals" = "physical", "evaluations" = "evaluation". */
function singular(word: string): string {
  return word.length > 4 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word) ? word.slice(0, -1) : word;
}

/** Whole-token phrase matching: "lead" cannot match "leadership". */
export function containsCompletePhrase(haystack: string, phrase: string): boolean {
  const needle = words(phrase);
  return needle.length > 0 && ` ${words(haystack)} `.includes(` ${needle} `);
}

function multiWordTerms(terms: readonly string[]): string[] {
  return Array.from(new Set(terms.filter((phrase) => {
    const tokenized = words(phrase);
    return tokenized.length >= 10 && tokenized.split(" ").length >= 2;
  })));
}

/** Drop phrases contained in a longer matched phrase, so variants of one phrase count once. */
function distinctPhrases(phrases: string[]): string[] {
  const normalized = Array.from(new Set(phrases.map(words)));
  return normalized.filter((phrase) =>
    !normalized.some((other) => other !== phrase && ` ${other} `.includes(` ${phrase} `)));
}

export type PrimaryScopeEvidencePath = "title-service-term" | "title-signal-and-description-explicit" | "none";

export interface PrimaryScopeEvidence {
  evidenced: boolean;
  path: PrimaryScopeEvidencePath;
  /** Profile terms that carried the decision (title term, or title signal + description phrase). */
  terms: string[];
  profileSource: RelevanceProfile["source"];
  profileVersion: string;
}

/**
 * A high numerical match alone is not proof that the buyer purchases an
 * Occu-Med service. Prefer specific service language in the title; for
 * generic medical titles require additional direct service evidence in
 * the description. Unproven records remain accessible in review/audit.
 *
 * Paths:
 *  1. the title names a specific explicit/component service phrase (multi-word, non-generic);
 *  2. the title carries a broad medical signal from the profile (whole token, e.g. "medical",
 *     "examination", "physical") AND the description names an explicit multi-word service phrase,
 *     corroborated by a second distinct title signal or a second distinct description phrase.
 *     A broad title word alone never qualifies.
 */
export function primaryOccuMedServiceEvidence(
  title: string,
  description: string,
  profile: RelevanceProfile = getRelevanceProfile(),
): PrimaryScopeEvidence {
  const base = { profileSource: profile.source, profileVersion: profile.version };
  if (profile.source === "unavailable") return { evidenced: false, path: "none", terms: [], ...base };
  const categories = profile.categories.filter((category) => !category.adjacentOnly);
  const explicit = multiWordTerms([
    ...profile.generalExplicit,
    ...categories.flatMap((category) => category.explicit),
  ]);
  // Network management and generic title signals (e.g. "quality assurance",
  // "medical services") cannot independently prove a clinical purchase.
  const components = multiWordTerms(categories
    .filter((category) => category.id !== profile.networkCategoryId)
    .flatMap((category) => category.component))
    .filter((term) => !profile.genericTitle.some((generic) => containsCompletePhrase(term, generic)));
  const titleTerm = [...explicit, ...components].find((term) => containsCompletePhrase(title, term));
  if (titleTerm) return { evidenced: true, path: "title-service-term", terms: [titleTerm], ...base };
  // Broad title signals are single words by design; whole-token matching keeps "physical" out of "physically"
  // and "vision" out of "division". Specificity comes from the description phrase, never from the title word.
  // One broad word plus one phrase is too weak ("Physical Plant ..." with boilerplate), so require independent
  // corroboration: two distinct broad title signals, or two distinct (non-nested) explicit description phrases.
  const titleSignals = Array.from(new Set(profile.titleMedical.filter((term) => containsCompletePhrase(title, term))));
  if (titleSignals.length > 0) {
    const phrases = distinctPhrases(explicit.filter((term) => containsCompletePhrase(description, term)));
    if (phrases.length > 0 && (titleSignals.length >= 2 || phrases.length >= 2)) {
      return {
        evidenced: true,
        path: "title-signal-and-description-explicit",
        terms: [...titleSignals, ...phrases],
        ...base,
      };
    }
  }
  return { evidenced: false, path: "none", terms: [], ...base };
}

export function hasPrimaryOccuMedServiceEvidence(
  title: string,
  description: string,
  profile: RelevanceProfile = getRelevanceProfile(),
): boolean {
  return primaryOccuMedServiceEvidence(title, description, profile).evidenced;
}
