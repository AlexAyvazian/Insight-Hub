/**
 * Search-query builder derived entirely from the Neon relevance profile.
 *
 * Every phrase that ends up in a query (service terms, procurement terms, classification codes, exclusion
 * operators) comes from `RelevanceProfile` at call time, so a refreshed profile changes the queries on the
 * next call. Only retrieval shaping lives here: year variants, query assembly and operator syntax.
 *
 *   - service / procurement terms  <- profile.searchBundles (facts: rfp_search_bundle)
 *   - classification-code variants <- profile.discoveryCodes (facts: rfp_discovery_code)
 *   - broad "buyer lane" variants   <- the lead service term of each bundle
 *   - exclusion operators           <- bundle.exclusions + triggers of the hard post-award reject rule
 */
import { queryRotationCursor, rotatingWindow } from "./profileWebQueries";
import { getRelevanceProfile, type ProfileDiscoveryCode, type RelevanceProfile } from "./relevanceProfile";

/** Search engines degrade on very long OR lists; this only bounds one code variant, never the vocabulary. */
const MAX_CODES_PER_VARIANT = 6;
/** Discovery-code tiers that are Occu-Med service lines (same notion as discoveryCodeSupportsReview). */
const SERVICE_LINE_TIERS = new Set(["registered", "capability"]);
const POST_AWARD_ACTION = "reject_post_award_notice";

function operandFor(term: string): string {
  const t = term.trim();
  return /\s/.test(t) && !t.startsWith('"') ? `"${t}"` : t;
}

function codeVariant(profile: RelevanceProfile, systemPrefix: "PSC" | "NAICS", label: string): string {
  const candidates = profile.discoveryCodes
    .filter(
      (d: ProfileDiscoveryCode) =>
        d.system.toUpperCase().startsWith(systemPrefix) &&
        d.match === "exact" &&
        SERVICE_LINE_TIERS.has(d.tier) &&
        d.effect.startsWith("include"),
    )
    .map((d, index) => ({ d, index }))
    // registered lines first, then codes with curated relevance phrases, then profile order
    .sort(
      (a, b) =>
        Number(b.d.tier === "registered") - Number(a.d.tier === "registered") ||
        Number(b.d.relevancePhrases.length > 0) - Number(a.d.relevancePhrases.length > 0) ||
        a.index - b.index,
    )
    .slice(0, MAX_CODES_PER_VARIANT)
    .map((c) => c.d.code);
  return candidates.length ? `${label} ${candidates.join(" OR ")}` : "";
}

/** Two halves of the bundles' lead service terms: broad "employee health" style lanes without own vocabulary. */
function buyerVariants(profile: RelevanceProfile): string[] {
  const leads = profile.searchBundles.map((b) => b.serviceTerms[0]).filter((t): t is string => Boolean(t));
  if (leads.length === 0) return [""];
  const half = Math.ceil(leads.length / 2);
  return ["", leads.slice(0, half).join(" OR "), leads.slice(half).join(" OR ")].filter(
    (v, i) => i === 0 || v.length > 0,
  );
}

/** Negative operators: bundle exclusions plus every trigger of the profile's post-award hard rule. */
export function profileExclusionOperators(profile: RelevanceProfile, bundleExclusions: string[]): string {
  const postAward = profile.rules.filter((r) => r.hard && r.action === POST_AWARD_ACTION).flatMap((r) => r.triggers);
  const terms = Array.from(new Set([...bundleExclusions.map((e) => e.trim()).filter(Boolean), ...postAward]));
  return terms.map((t) => `-${operandFor(t.replace(/^-/, ""))}`).join(" ");
}

export function buildProfileSearchQueries(
  year = new Date().getFullYear(),
  profile: RelevanceProfile = getRelevanceProfile(),
  now: Date = new Date(),
): string[] {
  const runYear = Number.isFinite(year) ? year : now.getFullYear();
  const month = now.getMonth();
  const yearVariants = [
    `${runYear}`,
    `${runYear - 1} still open`,
    "",
    ...(month >= 9 ? [`${runYear + 1}`] : []),
  ];
  const codeVariants = ["", codeVariant(profile, "PSC", "PSC"), codeVariant(profile, "NAICS", "NAICS")].filter(
    (v, i) => i === 0 || v.length > 0,
  );
  const buyers = buyerVariants(profile);

  return profile.searchBundles
    .filter((b) => b.serviceTerms.length > 0)
    .flatMap((b) => {
      const procurement = b.procurementTerms.length ? `(${b.procurementTerms.join(" OR ")})` : "";
      const exclusions = profileExclusionOperators(profile, b.exclusions);
      return b.serviceTerms.flatMap((term) =>
        yearVariants.flatMap((yearTerm) =>
          codeVariants.flatMap((codeTerm) =>
            buyers.map((buyerTerm) =>
              [term, procurement, yearTerm, codeTerm, buyerTerm, exclusions].filter(Boolean).join(" "),
            ),
          ),
        ),
      );
    });
}

/** Distinct procurement-stage search terms across the profile's bundles, as one `(a OR b)` expression ("" when none). */
export function profileProcurementExpression(profile: RelevanceProfile = getRelevanceProfile()): string {
  const terms = Array.from(new Set(profile.searchBundles.flatMap((b) => b.procurementTerms.map((t) => t.trim()).filter(Boolean))));
  return terms.length ? `(${terms.map(operandFor).join(" OR ")})` : "";
}

/**
 * One OR-group per search bundle (`("a" OR "b" OR "c")`), for providers that issue a handful of broad queries
 * instead of the full cross-product. `termsPerGroup` only bounds query length.
 */
export function profileServiceQueryGroups(
  profile: RelevanceProfile = getRelevanceProfile(),
  termsPerGroup = 3,
  cursor: number = queryRotationCursor(),
): string[] {
  return profile.searchBundles
    .filter((b) => b.serviceTerms.length > 0)
    .map((b) => `(${rotatingWindow(b.serviceTerms, termsPerGroup, cursor).join(" OR ")})`);
}
