/**
 * Relevance for intelligence items (forecast notices, awards, oversight reports, policy documents, news,
 * job postings). One definition of "relevant": the Neon-backed relevance profile, read at call time.
 *
 * - `assessIntelText` runs the shared classifier and the canonical accept/review/reject decision. Use it for
 *   anything notice-like. Its score is the classifier's score; its verdict applies the profile thresholds.
 * - `profileEvidence` reports which profile service terms a text names, without the procurement-notice
 *   hard-reject rules (job postings, award notices). Use it for non-procurement documents such as job
 *   postings where "does this talk about Occu-Med services" is the question.
 *
 * Agency-neutral by construction: the input has no agency field, so who issued an item cannot change its score or
 * verdict. (Agency targeting is search-priority metadata in agencyPriority.ts and never reaches relevance.)
 * No vocabulary, agency list or threshold is defined in this file.
 */
import { classifyResult } from "../search/relevance";
import { decideRelevance, type RelevanceVerdict } from "../search/relevanceDecision";
import { getRelevanceProfile, type RelevanceProfile } from "../search/relevanceProfile";

export interface IntelAssessment {
  /** Classifier score, 0-100. */
  score: number;
  verdict: RelevanceVerdict;
  /** The text names at least one profile service term (explicit phrase, component term or regulatory reference). */
  topical: boolean;
  reasons: string[];
}

export function assessIntelText(input: {
  title?: string | null;
  text?: string | null;
  url?: string | null;
  date?: string | Date | null;
  deadlineInFuture?: boolean;
}): IntelAssessment {
  const result = classifyResult({
    title: input.title ?? "",
    snippet: input.text ?? "",
    url: input.url ?? null,
    date: input.date ?? null,
    deadlineInFuture: input.deadlineInFuture,
    allowHistorical: true,
    // Intel feeds keep legacy containment matching until measured separately (Opportunities uses "token").
    matchMode: "substring",
  });
  const decision = decideRelevance(result);
  return {
    score: Math.round(result.score),
    verdict: decision.verdict,
    topical:
      result.matchedExplicitPhrases.length > 0 ||
      result.matchedComponentTerms.length > 0 ||
      result.matchedRegulatorySignals.length > 0,
    reasons: result.reasons,
  };
}

export interface ProfileEvidence {
  explicit: string[];
  component: string[];
  regulatory: string[];
  /** Distinct profile categories whose terms appear in the text. */
  categories: string[];
  total: number;
}

function normalise(value: string): string {
  return ` ${value.toLowerCase().replace(/\s+/g, " ")} `;
}

/** Profile service terms present in `text` (substring match on normalised text, like the classifier). */
export function profileEvidence(text: string, profile: RelevanceProfile = getRelevanceProfile()): ProfileEvidence {
  const haystack = normalise(text);
  const hit = (terms: string[]) => terms.filter((term) => haystack.includes(term.toLowerCase()));
  const explicit: string[] = [];
  const component: string[] = [];
  const regulatory: string[] = [];
  const categories: string[] = [];
  for (const category of profile.categories) {
    if (category.adjacentOnly) continue;
    const e = hit(category.explicit);
    const c = hit(category.component);
    const r = hit(category.regulatory);
    if (e.length || c.length || r.length) categories.push(category.label);
    explicit.push(...e);
    component.push(...c);
    regulatory.push(...r);
  }
  const general = hit(profile.generalExplicit);
  if (general.length) categories.push("Occu-Med profile phrase");
  explicit.push(...general);
  const uniq = (values: string[]) => Array.from(new Set(values));
  const result = { explicit: uniq(explicit), component: uniq(component), regulatory: uniq(regulatory), categories: uniq(categories) };
  return { ...result, total: result.explicit.length + result.component.length + result.regulatory.length };
}

/**
 * Score for a non-procurement document, anchored to the profile's own thresholds: no evidence scores below the
 * review floor, evidence in one category lands midway between review and accept, and evidence across two or more
 * categories reaches the accept threshold.
 */
export function evidenceScore(evidence: ProfileEvidence, profile: RelevanceProfile = getRelevanceProfile()): number {
  const { acceptMin, reviewMin } = profile.thresholds;
  if (evidence.total === 0) return Math.max(0, Math.round(reviewMin / 2));
  const step = (acceptMin - reviewMin) / 2;
  return Math.min(100, Math.round(reviewMin + Math.min(evidence.categories.length, 2) * step));
}
