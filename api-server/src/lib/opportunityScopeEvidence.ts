/**
 * Conservative purchased-scope evidence for the Opportunities tab ONLY.
 * Vocabulary comes exclusively from the OCCU_MED_AWARE relevance profile.
 * Missing evidence moves candidates to review; no records are deleted.
 */
import { getRelevanceProfile, type RelevanceProfile } from "./search/relevanceProfile";

function words(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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

/**
 * A high numerical match alone is not proof that the buyer purchases an
 * Occu-Med service. Prefer specific service language in the title; for
 * generic medical titles require additional direct service evidence in
 * the description. Unproven records remain accessible in review/audit.
 */
export function hasPrimaryOccuMedServiceEvidence(
  title: string,
  description: string,
  profile: RelevanceProfile = getRelevanceProfile(),
): boolean {
  if (profile.source === "unavailable") return false;
  const categories = profile.categories.filter((category) => !category.adjacentOnly);
  const explicit = multiWordTerms([
    ...profile.generalExplicit,
    ...categories.flatMap((category) => category.explicit),
  ]);
  const components = multiWordTerms(categories.flatMap((category) => category.component));
  if ([...explicit, ...components].some((term) => containsCompletePhrase(title, term))) {
    return true;
  }
  const titleSignals = multiWordTerms(profile.titleMedical);
  return titleSignals.some((term) => containsCompletePhrase(title, term)) &&
    explicit.some((term) => containsCompletePhrase(description, term));
}
