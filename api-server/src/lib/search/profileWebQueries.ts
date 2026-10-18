/**
 * Web-search query text for the search-engine providers, derived from the Neon relevance profile at call time.
 *
 * Providers decide HOW to ask (engine operators, result counts, date filters); WHAT to ask for comes from the profile:
 *   - service terms and procurement terms <- profile.searchBundles (facts: rfp_search_bundle)
 *   - exclusion operators                  <- bundle exclusions plus the leading triggers of the profile's post-award
 *                                             and not-a-procurement hard rules
 * Nothing here defines Occu-Med vocabulary. Callers must invoke these per request, never at module load, so a
 * refreshed profile changes the next query.
 */
import { getRelevanceProfile, type ProfileSearchBundle, type RelevanceProfile } from "./relevanceProfile";

/** Hard-rule machine actions whose triggers become negative operators (award notices, job ads). */
const EXCLUSION_RULE_ACTIONS = new Set(["reject_post_award_notice", "reject_not_a_procurement"]);
/** Search engines degrade on long operator lists; this bounds one operator group, never the vocabulary itself. */
const TRIGGERS_PER_EXCLUSION_RULE = 2;
const SERVICE_TERMS_PER_QUERY = 3;
const PROCUREMENT_TERMS_PER_QUERY = 3;

function operand(term: string): string {
  const t = term.trim();
  return /\s/.test(t) && !t.startsWith('"') ? `"${t}"` : t;
}

function plain(term: string): string {
  return term.replace(/"/g, "").replace(/\s+/g, " ").trim();
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function serviceBundles(profile: RelevanceProfile): ProfileSearchBundle[] {
  return profile.searchBundles.filter((b) => b.serviceTerms.length > 0);
}

/** Procurement words (RFP, solicitation, ...) the profile's bundles pair with service terms, most common first. */
export function profileProcurementTerms(profile: RelevanceProfile = getRelevanceProfile(), max = PROCUREMENT_TERMS_PER_QUERY): string[] {
  const counts = new Map<string, number>();
  for (const bundle of serviceBundles(profile)) {
    for (const term of bundle.procurementTerms) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([term, count], index) => ({ term, count, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .slice(0, max)
    .map((entry) => entry.term);
}

/** Negative operators (`-"award notice" -"job posting"`) from bundle exclusions and the profile's exclusion rules. */
export function profileExclusionOperators(profile: RelevanceProfile = getRelevanceProfile(), bundleExclusions: string[] = []): string {
  const fromRules = profile.rules
    .filter((r) => r.hard && EXCLUSION_RULE_ACTIONS.has(r.action))
    .flatMap((r) => r.triggers.slice(0, TRIGGERS_PER_EXCLUSION_RULE));
  return uniq([...bundleExclusions, ...fromRules])
    .map((t) => `-${operand(t.replace(/^-/, ""))}`)
    .join(" ");
}

const DAY_MS = 86_400_000;

/**
 * Deterministic rotation cursor: the UTC day index. Query builders use it to move through every bundle term and
 * every coverage group over a bounded cycle (a few days) instead of always sending the first 2-3 terms. It needs no
 * stored state, so a run can be reproduced from its date.
 */
export function queryRotationCursor(now: number = Date.now()): number {
  return Math.floor(now / DAY_MS);
}

/** `size` items starting at window `cursor`, wrapping; over ceil(len/size) cursors every item appears. */
export function rotatingWindow<T>(items: readonly T[], size: number, cursor: number): T[] {
  if (items.length <= size) return [...items];
  const windows = Math.ceil(items.length / size);
  const start = (((cursor % windows) + windows) % windows) * size;
  return Array.from({ length: size }, (_, i) => items[(start + i) % items.length]!);
}

/** Days needed for every bundle term (and gap group) to be queried at least once. */
export function queryRotationCycleDays(profile: RelevanceProfile = getRelevanceProfile(), termsPerQuery = SERVICE_TERMS_PER_QUERY): number {
  const lengths = [
    ...serviceBundles(profile).map((b) => b.serviceTerms.length),
    ...coverageGapCategories(profile).map((c) => c.explicit.length),
  ];
  return Math.max(1, ...lengths.map((n) => Math.ceil(n / termsPerQuery)));
}

function normalizedTerm(term: string): string {
  return plain(term).toLowerCase();
}

/**
 * Non-adjacent profile categories that no search bundle represents (no bundle service term mentions any of the
 * category's explicit/component phrases). Without this they would never be searched directly, however rich the
 * profile vocabulary. Vocabulary still comes only from the profile; this function only schedules it.
 */
export function coverageGapCategories(profile: RelevanceProfile = getRelevanceProfile()) {
  const bundleTerms = serviceBundles(profile).flatMap((b) => b.serviceTerms.map(normalizedTerm));
  return profile.categories.filter((category) => {
    if (category.adjacentOnly || category.id === profile.networkCategoryId || category.explicit.length === 0) return false;
    const phrases = [...category.explicit, ...category.component].map(normalizedTerm).filter((t) => t.length >= 5);
    return !phrases.some((phrase) => bundleTerms.some((term) => term.includes(phrase) || phrase.includes(term)));
  });
}

/** One boolean-operator query per service bundle (plus one per coverage-gap category), rotating through terms. */
export function profileBooleanQueries(
  year: number,
  profile: RelevanceProfile = getRelevanceProfile(),
  cursor: number = queryRotationCursor(),
): string[] {
  const generalProcurement = profileProcurementTerms(profile, PROCUREMENT_TERMS_PER_QUERY);
  const groups = [
    ...serviceBundles(profile).map((bundle) => ({
      services: rotatingWindow(bundle.serviceTerms, SERVICE_TERMS_PER_QUERY, cursor),
      procurement: bundle.procurementTerms.slice(0, PROCUREMENT_TERMS_PER_QUERY),
      exclusions: bundle.exclusions,
    })),
    ...coverageGapCategories(profile).map((category) => ({
      services: rotatingWindow(category.explicit, SERVICE_TERMS_PER_QUERY, cursor),
      procurement: generalProcurement,
      exclusions: [] as string[],
    })),
  ];
  return groups.map(({ services, procurement, exclusions }) =>
    [`(${services.map(operand).join(" OR ")})`, procurement.length ? `(${procurement.map(operand).join(" OR ")})` : "", String(year), profileExclusionOperators(profile, exclusions)]
      .filter(Boolean)
      .join(" "));
}

/** One natural-language query per service bundle (plus coverage-gap categories), rotating through terms. */
export function profileNaturalQueries(
  year: number,
  profile: RelevanceProfile = getRelevanceProfile(),
  cursor: number = queryRotationCursor(),
): string[] {
  const [lead, second] = profileProcurementTerms(profile, 2);
  const serviceSets = [
    ...serviceBundles(profile).map((bundle) => rotatingWindow(bundle.serviceTerms, 2, cursor)),
    ...coverageGapCategories(profile).map((category) => rotatingWindow(category.explicit, 2, cursor)),
  ];
  return serviceSets.map((terms) =>
    [`open`, lead, second, "for", terms.map(plain).join(" or "), String(year)].filter(Boolean).join(" "));
}

/** The lead service term of every bundle, unquoted: short phrases that describe Occu-Med's scope in a search string. */
export function profileLeadPhrases(profile: RelevanceProfile = getRelevanceProfile(), max = Infinity): string[] {
  return uniq(serviceBundles(profile).map((b) => plain(b.serviceTerms[0] ?? ""))).slice(0, max);
}

/** `("lead term" OR "lead term" ...)` scoping a user keyword to Occu-Med's scope; "" when the profile has no bundles. */
export function profileScopeOperand(profile: RelevanceProfile = getRelevanceProfile(), max = 6): string {
  const leads = uniq(serviceBundles(profile).map((b) => b.serviceTerms[0] ?? "")).slice(0, max);
  return leads.length ? `(${leads.map(operand).join(" OR ")})` : "";
}

/**
 * `n` items spread evenly across the list. With a rotation `cursor` the sample shifts each day, so a provider that
 * runs only a few queries still reaches every bundle over the cycle instead of always the same subset.
 */
export function spreadSample<T>(items: T[], n: number, cursor = 0): T[] {
  if (items.length <= n) return items;
  const picked: T[] = [];
  const seen = new Set<number>();
  const offset = ((cursor % items.length) + items.length) % items.length;
  for (let i = 0; i < n; i++) {
    const index = (Math.floor((i * items.length) / n) + offset) % items.length;
    if (!seen.has(index)) {
      seen.add(index);
      picked.push(items[index]!);
    }
  }
  return picked;
}

/** Queries for a user-supplied keyword, scoped to the profile; engine operator style is chosen by the caller. */
export function keywordQueries(keywords: string, year: number, profile: RelevanceProfile = getRelevanceProfile()): string[] {
  const procurement = profileProcurementTerms(profile, 2).join(" ");
  const scope = profileLeadPhrases(profile, 3).join(" ");
  return [
    `${keywords} ${procurement} ${year}`.replace(/\s+/g, " ").trim(),
    `${keywords} government bid procurement ${year}`,
    `${keywords} ${scope} ${year}`.replace(/\s+/g, " ").trim(),
  ];
}
