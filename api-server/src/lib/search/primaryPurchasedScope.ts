/**
 * Primary purchased scope: "is the thing being bought an Occu-Med service, or only something that shares its words?"
 *
 * The canonical profile policy rfp_primary_purchased_scope approves a notice only when its PRIMARY purchased scope is
 * an occupational-health service. The deterministic classifier accepts on evidence paths that can be satisfied by
 * text that is not the primary scope. Two such shapes produced AI-agreed wrong high-confidence matches in the
 * Release C benchmark:
 *
 * 1. Component-only scope. The only Occu-Med evidence is the laboratory / diagnostic COMPONENT category (optionally
 *    with the provider-network / program-management category), with no workforce, employer or regulatory signal at
 *    all: clinical laboratory testing for a hospital or VA health care system, a disease-surveillance research study.
 *    Laboratory testing is in scope as a component of occupational testing, so these are held for review, never
 *    rejected. Any workforce or regulatory signal, any other service category (drug/alcohol testing, medical
 *    surveillance, exams, ...) or any general Occu-Med profile phrase leaves the result untouched.
 * 2. Supply-only scope. No explicit Occu-Med service phrase matched (the accept came from a component combination),
 *    the notice frames medications / vaccines / pharmaceuticals as the goods being procured, the title names no
 *    service, and nothing says the contractor administers them. Policy rfp_commodity_and_equipment_supply puts
 *    supplies without a service component out of scope; the result is held for review.
 *
 * Like procurementAuthenticity.ts this runs after the relevance classifier and only ever downgrades accept to review.
 * It does not change the profile, its vocabulary or its thresholds; the category ids it reads come from the profile.
 */
import { REASON_CODES } from "./relevanceReasonCodes";
import type { RelevanceResult } from "./relevance";
import { getRelevanceProfile, type RelevanceProfile } from "./relevanceProfile";

/** Profile category ids that describe components or delivery mechanics, not a primary occupational service. */
const COMPONENT_ONLY_CATEGORY_IDS = new Set(["lab_diagnostic_components", "network_program_management"]);

const SUPPLY_GOODS = String.raw`(?:medications?|medicines?|vaccines?|pharmaceuticals?|biologics)`;
/** A purchase frame directly governing the goods: "procure medications, vaccines...", "acquisition of vaccines". */
const SUPPLY_FRAME_RE = new RegExp(
  String.raw`\b(?:procure|procuring|procurement of|acquire|acquiring|acquisition of|purchase|purchasing|purchase of|supply of|furnish|delivery of)\s+(?:the\s+|all\s+|of\s+)?(?:[a-z-]+,?\s+){0,2}?${SUPPLY_GOODS}\b`,
  "i",
);
const TITLE_GOODS_RE = new RegExp(String.raw`\b${SUPPLY_GOODS}\b|\bmedical supplies\b`, "i");
/** A title that names a service being bought rather than goods. */
const TITLE_SERVICE_RE =
  /\b(services?|administration|administer(ing)?|clinics?|exams?|examinations?|physicals?|testing|tests?|screenings?|vaccinations?|immunizations?|programs?|surveillance|evaluations?|assessments?)\b/i;
/** Contractor delivers the goods to people (a service), e.g. "administer vaccines", "vaccination clinics". */
const ADMINISTERS_RE =
  /\b(administer(s|ing)?|administration of (the )?(vaccines?|medications?|immunizations?)|vaccinat(e|es|ing|ion|ions)|immuniz(e|es|ing|ation) (services|clinics?|events?)|inoculat\w*|flu (shot|clinic)s?)\b/i;

export interface PrimaryScopeInput {
  title?: string | null;
  description?: string | null;
}

export interface PrimaryScopeAssessment {
  action: "none" | "review";
  kind: "service" | "component_only_scope" | "supply_only_scope";
  reason: string | null;
}

function categoryIdsByLabel(profile: RelevanceProfile): Map<string, string> {
  return new Map(profile.categories.map((c) => [c.label, c.id]));
}

export function assessPrimaryPurchasedScope(
  relevance: RelevanceResult,
  input: PrimaryScopeInput,
  profile: RelevanceProfile = getRelevanceProfile(),
): PrimaryScopeAssessment {
  const none: PrimaryScopeAssessment = { action: "none", kind: "service", reason: null };
  if (relevance.rejected) return none;
  const occupationalContext = relevance.matchedWorkforceSignals.length > 0 || relevance.matchedRegulatorySignals.length > 0;

  const ids = categoryIdsByLabel(profile);
  const categories = relevance.matchedServiceCategories;
  const componentOnly =
    categories.length > 0 &&
    categories.every((label) => COMPONENT_ONLY_CATEGORY_IDS.has(ids.get(label) ?? "")) &&
    categories.some((label) => ids.get(label) === "lab_diagnostic_components");
  if (componentOnly && !occupationalContext && !relevance.reasonCodes.includes(REASON_CODES.regulatory)) {
    return {
      action: "review",
      kind: "component_only_scope",
      reason:
        "Only laboratory / diagnostic component evidence with no workforce, employer or regulatory context (clinical or research testing?); held for review",
    };
  }

  const title = input.title ?? "";
  const text = `${title} ${input.description ?? ""}`;
  if (
    relevance.matchedExplicitPhrases.length === 0 &&
    SUPPLY_FRAME_RE.test(text) &&
    TITLE_GOODS_RE.test(title) &&
    !TITLE_SERVICE_RE.test(title) &&
    !ADMINISTERS_RE.test(text)
  ) {
    return {
      action: "review",
      kind: "supply_only_scope",
      reason: "Purchased scope reads as a supply of medications / vaccines, not service delivery; held for review",
    };
  }
  return none;
}

/** Apply an assessment: a review hold caps the score below the canonical accept threshold. Never lifts. */
export function applyPrimaryPurchasedScope(
  relevance: RelevanceResult,
  assessment: PrimaryScopeAssessment,
  profile: RelevanceProfile = getRelevanceProfile(),
): RelevanceResult {
  if (assessment.action === "none" || !assessment.reason || relevance.rejected) return relevance;
  const { acceptMin } = profile.thresholds;
  return {
    ...relevance,
    score: Number.isFinite(acceptMin) ? Math.min(relevance.score, acceptMin - 1) : relevance.score,
    rejected: true,
    rejectReason: assessment.reason,
    reasons: [...relevance.reasons, assessment.reason],
    negativeSignals: [...relevance.negativeSignals, `primary scope: ${assessment.kind}`],
    reasonCodes: [...relevance.reasonCodes, REASON_CODES.primaryScopeHold],
    confidence: "insufficient",
  };
}
