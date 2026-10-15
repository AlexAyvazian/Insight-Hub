/**
 * Occu-Med demand assessment for a contract award or a company news article.
 *
 * Reads ONLY the canonical OCCU_MED_AWARE relevance profile (lib/search/relevanceProfile, loaded from Neon by
 * lib/occumedAware/relevanceProfileLoader). There is no vocabulary in this file: service categories, workforce
 * signals, buyer/prime signals and the out-of-scope rules (workers' compensation, TPA, staffing, benefits, health IT)
 * all come from the profile rows. Sourced structured facts (place of performance, new award vs modification) are
 * passed in by the caller from the official record.
 *
 * The result is evidence, not a verdict about hiring: every level says what was found and what remains unconfirmed.
 */
import { matchEvidence, matchTriggers } from "../search/profileRules";
import { getRelevanceProfile, type RelevanceProfile } from "../search/relevanceProfile";

export type DemandLevel = "high" | "medium" | "low" | "excluded" | "unknown";

export interface DemandEvidence {
  kind: "service" | "workforce" | "buyer" | "overseas" | "new_award" | "exclusion";
  label: string;
  terms: string[];
  source: "official_record" | "article_text" | "award_text";
}

export interface DemandAssessment {
  level: DemandLevel;
  summary: string;
  evidence: DemandEvidence[];
  /** What the evidence does NOT establish. Always present. */
  uncertainty: string;
  profileSource: RelevanceProfile["source"];
  profileVersion: string;
}

export interface DemandFacts {
  /** Country of the place of performance from the official record (ISO3 or name), when sourced. */
  placeOfPerformanceCountry?: string | null;
  placeOfPerformanceText?: string | null;
  /** true: a new base award; false: a modification/option on an existing contract; null: not stated. */
  newAward?: boolean | null;
}

/** Rules whose subject is a service Occu-Med does not offer: matches are listed as exclusions, never as evidence. */
const OUT_OF_SCOPE_ACTIONS = new Set(["reject_as_out_of_scope", "reject_tpa_classification"]);

function isDomestic(country: string | null | undefined): boolean | null {
  const value = String(country ?? "").trim().toUpperCase();
  if (!value) return null;
  return value === "USA" || value === "US" || value === "UNITED STATES" || value === "UNITED STATES OF AMERICA";
}

export function assessOccuMedDemand(
  text: string,
  facts: DemandFacts = {},
  textSource: DemandEvidence["source"] = "article_text",
  profile: RelevanceProfile = getRelevanceProfile(),
): DemandAssessment {
  const base = { profileSource: profile.source, profileVersion: profile.version };
  if (profile.source === "unavailable") {
    return {
      ...base,
      level: "unknown",
      summary: "Occu-Med relevance not assessed: the OCCU_MED_AWARE profile is not loaded.",
      evidence: [],
      uncertainty: "No relevance judgement was made.",
    };
  }
  const evidence: DemandEvidence[] = [];

  const exclusions: DemandEvidence[] = [];
  for (const rule of profile.rules) {
    if (!OUT_OF_SCOPE_ACTIONS.has(rule.action)) continue;
    const hits = matchTriggers(text, rule.triggers);
    if (hits.length) exclusions.push({ kind: "exclusion", label: rule.title, terms: hits, source: textSource });
  }
  const excludedTerms = new Set(exclusions.flatMap(item => item.terms.map(term => term.toLowerCase())));
  const keep = (terms: string[]) => terms.filter(term => !excludedTerms.has(term.toLowerCase()));

  let directService = false;
  for (const category of profile.categories) {
    const direct = keep(matchEvidence(text, category.explicit));
    const component = keep(matchEvidence(text, [...category.component, ...category.regulatory]));
    if (!direct.length && !component.length) continue;
    if (direct.length && !category.adjacentOnly) directService = true;
    evidence.push({ kind: "service", label: category.label, terms: [...direct, ...component].slice(0, 6), source: textSource });
  }
  const general = keep(matchEvidence(text, profile.generalExplicit));
  if (general.length) {
    directService = true;
    evidence.push({ kind: "service", label: "Occu-Med service named", terms: general.slice(0, 6), source: textSource });
  }

  const workforce = keep(matchEvidence(text, profile.workforceSignals));
  if (workforce.length) evidence.push({ kind: "workforce", label: "Workforce named", terms: workforce.slice(0, 6), source: textSource });
  const buyers = keep(matchTriggers(text, profile.prime));
  if (buyers.length) evidence.push({ kind: "buyer", label: "Buyer / prime-contractor sector", terms: buyers.slice(0, 6), source: textSource });

  const domestic = isDomestic(facts.placeOfPerformanceCountry);
  if (domestic === false) {
    evidence.push({ kind: "overseas", label: "Work performed outside the U.S.", terms: [facts.placeOfPerformanceText || String(facts.placeOfPerformanceCountry)], source: "official_record" });
  }
  if (facts.newAward === true) {
    evidence.push({ kind: "new_award", label: "New base award (not a modification)", terms: [], source: "official_record" });
  }
  evidence.push(...exclusions);

  const service = evidence.some(item => item.kind === "service");
  const workforceOrSite = evidence.some(item => item.kind === "workforce" || item.kind === "overseas");
  let level: DemandLevel;
  let summary: string;
  if (exclusions.length && !directService) {
    level = "excluded";
    summary = `Out of Occu-Med scope: ${exclusions.map(item => item.label).join("; ")}.`;
  } else if (directService) {
    level = "high";
    summary = "Names Occu-Med services directly.";
  } else if (service || workforceOrSite) {
    level = "medium";
    summary = service ? "Mentions exam, testing, deployment or exposure topics Occu-Med covers." : "New work with a named workforce or overseas site that may need exams.";
  } else {
    level = "low";
    summary = "No Occu-Med service, workforce or overseas evidence in the source.";
  }
  const uncertainty = directService
    ? "The source names the service; it does not confirm Occu-Med could bid or who performs it."
    : "Demand for exams is inferred, not stated: the source does not confirm hiring, mobilization or medical requirements.";
  return { ...base, level, summary, evidence, uncertainty };
}
