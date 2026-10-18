/**
 * Testing-type grouping for the Opportunities view.
 *
 * A "testing type" is one of the service categories of the Neon relevance profile (pre-employment exams, drug and
 * alcohol testing, respiratory fit testing, audiometry, immunizations, and so on). No label or term is defined here:
 * both come from `getRelevanceProfile()` at call time, so a profile refresh changes the grouping without a code change.
 *
 * Why this exists: the classifier's `category` is simply the first profile category that matched, in profile order.
 * The broad umbrella category ("Occupational / employee medical services") is first and matches almost every record,
 * so nearly every opportunity landed in one group. This ranks the categories a record evidences and picks the most
 * specific one as its primary type.
 *
 * Ranking, all derived from the profile data itself:
 *  - evidence: explicit phrase 3, regulatory reference 2, component term 1 (a category needs an explicit or
 *    regulatory term, or two component terms, the same bar `matchedServiceLines` uses);
 *  - specificity: a term shared by many categories is worth less (inverse category frequency), so a term that
 *    belongs to one category outweighs boilerplate shared by several;
 *  - title: a term found in the title counts double, because the title states what is being bought;
 *  - delivery model: the profile's provider-network category describes how services are delivered, not what is
 *    tested, so it only wins when nothing more specific matched.
 */
import {
  getRelevanceProfile,
  type ProfileCategory,
  type RelevanceProfile,
} from "./relevanceProfile";

export interface TestingTypeResult {
  /** Most specific testing type the record evidences, or null when none is evidenced. */
  primary: string | null;
  /** Every evidenced testing type, best first (includes the primary). */
  all: string[];
}

interface PreparedCategory {
  id: string;
  label: string;
  order: number;
  termCount: number;
  explicit: string[];
  regulatory: string[];
  component: string[];
}

interface PreparedProfile {
  categories: PreparedCategory[];
  /** How many (non-adjacent) categories list each normalized term. */
  termFrequency: Map<string, number>;
}

const prepared = new WeakMap<RelevanceProfile, PreparedProfile>();

/** Lowercase, punctuation to single spaces, padded so word-start matching is a plain substring test. */
function normalize(value: string | null | undefined): string {
  return ` ${(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function prepareTerms(terms: string[]): string[] {
  return Array.from(
    new Set(
      terms.map((t) => normalize(t).trim()).filter((t) => t.length > 0),
    ),
  );
}

function prepare(profile: RelevanceProfile): PreparedProfile {
  const cached = prepared.get(profile);
  if (cached) return cached;
  const categories: PreparedCategory[] = profile.categories
    .filter((c: ProfileCategory) => !c.adjacentOnly)
    .map((c, order) => {
      const explicit = prepareTerms(c.explicit);
      const regulatory = prepareTerms(c.regulatory);
      const component = prepareTerms(c.component);
      return {
        id: c.id,
        label: c.label,
        order,
        termCount: explicit.length + regulatory.length + component.length,
        explicit,
        regulatory,
        component,
      };
    });
  const termFrequency = new Map<string, number>();
  for (const category of categories) {
    const seen = new Set([
      ...category.explicit,
      ...category.regulatory,
      ...category.component,
    ]);
    for (const term of seen) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
    }
  }
  const result = { categories, termFrequency };
  prepared.set(profile, result);
  return result;
}

const EXPLICIT_WEIGHT = 3;
const REGULATORY_WEIGHT = 2;
const COMPONENT_WEIGHT = 1;
const TITLE_MULTIPLIER = 2;
/** The delivery-model category is outweighed by any specific testing type with comparable evidence. */
const DELIVERY_MODEL_FACTOR = 0.4;

interface TermHits {
  count: number;
  weighted: number;
}

function scoreTerms(
  terms: string[],
  body: string,
  title: string,
  weight: number,
  frequency: Map<string, number>,
): TermHits {
  let count = 0;
  let weighted = 0;
  for (const term of terms) {
    // Require complete token boundaries, not prefixes inside unrelated words.
    const bounded = ` ${term} `;
    const inTitle = title.includes(bounded);
    if (!inTitle && !body.includes(bounded)) continue;
    count += 1;
    const specificity = 1 / (frequency.get(term) ?? 1);
    weighted += weight * specificity * (inTitle ? TITLE_MULTIPLIER : 1);
  }
  return { count, weighted };
}

/**
 * Testing types evidenced by an opportunity's text, most specific first.
 * `title` is scored separately from `body` so a title hit counts more.
 */
export function classifyTestingTypes(
  input: { title?: string | null; body?: string | null },
  options: { profile?: RelevanceProfile } = {},
): TestingTypeResult {
  const profile = options.profile ?? getRelevanceProfile();
  const { categories, termFrequency } = prepare(profile);
  const title = normalize(input.title);
  const body = normalize(`${input.title ?? ""} ${input.body ?? ""}`);

  const scored: Array<{ label: string; score: number; category: PreparedCategory }> = [];
  for (const category of categories) {
    const explicit = scoreTerms(category.explicit, body, title, EXPLICIT_WEIGHT, termFrequency);
    const regulatory = scoreTerms(category.regulatory, body, title, REGULATORY_WEIGHT, termFrequency);
    const component = scoreTerms(category.component, body, title, COMPONENT_WEIGHT, termFrequency);
    const evidenced = explicit.count > 0 || regulatory.count > 0 || component.count >= 2;
    if (!evidenced) continue;
    let score = explicit.weighted + regulatory.weighted + component.weighted;
    if (profile.networkCategoryId && category.id === profile.networkCategoryId) {
      score *= DELIVERY_MODEL_FACTOR;
    }
    scored.push({ label: category.label, score, category });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      // Equal evidence: the category with the smaller vocabulary is the more specific one.
      a.category.termCount - b.category.termCount ||
      a.category.order - b.category.order,
  );
  const all = scored.map((s) => s.label);
  return { primary: all[0] ?? null, all };
}
