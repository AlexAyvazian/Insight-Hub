/**
 * Rule engine for the Neon relevance profile.
 *
 * Interprets the rules stored in Neon (`machine_action`, `scope`, `search_triggers`). It contains no
 * vocabulary: every trigger, rescue term, penalty and program combination comes from the rule rows.
 *
 * Matching conventions (documented in the rule scopes):
 *   - triggers (things that reject or penalise) match whole words/phrases, so "fuel" does not fire on "refuel";
 *   - evidence and rescue lists (requires_one_of, all_of groups, service terms) match from a word start, so
 *     "physical" is satisfied by "physicals" and "examination" by "examinations".
 */
import type { ProfileRule, RelevanceProfile } from "./relevanceProfile";

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cache = new Map<string, RegExp>();

function triggerRegex(term: string): RegExp {
  const key = `t:${term}`;
  let re = cache.get(key);
  if (!re) {
    const s = term.trim();
    re = new RegExp((/^\w/.test(s) ? "\\b" : "") + esc(s) + (/\w$/.test(s) ? "\\b" : ""), "i");
    cache.set(key, re);
  }
  return re;
}
function evidenceRegex(term: string): RegExp {
  const key = `e:${term}`;
  let re = cache.get(key);
  if (!re) {
    const s = term.trim();
    re = new RegExp((/^\w/.test(s) ? "\\b" : "") + esc(s), "i");
    cache.set(key, re);
  }
  return re;
}

/** Terms from `terms` found in `text`, as whole words/phrases. */
export function matchTriggers(text: string, terms: readonly string[]): string[] {
  return terms.filter((t) => t && triggerRegex(t).test(text));
}
/** Terms from `terms` found in `text`, matching from a word start. */
export function matchEvidence(text: string, terms: readonly string[]): string[] {
  return terms.filter((t) => t && evidenceRegex(t).test(text));
}

/** Lowercase alphanumeric word tokens of a text, in order. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Token positions at which a (possibly multi-word) term occurs in `tokens`. */
function termPositions(tokens: string[], term: string): number[] {
  const t = words(term);
  if (t.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i + t.length <= tokens.length; i++) {
    if (t.every((w, k) => tokens[i + k] === w)) out.push(i);
  }
  return out;
}

export interface CommodityScope {
  /** Commodity/raw-material terms found in the title. */
  commodities: string[];
  /** The purchase frame or unit that ties a commodity to being what is bought, if any. */
  frame: string | null;
  /** The title names a workforce or a medical subject (handler, employees, medical wording...) rather than just a material. */
  workforceContext: boolean;
  purchased: boolean;
}

/**
 * Decides whether a commodity/raw material is the PURCHASED SCOPE of the title, rather than merely a material
 * name appearing in it. All vocabulary is read from the rule (`search_triggers` = commodity terms; `scope`
 * = purchase frames, unit terms, window) and from the profile (workforce signals); this function is mechanics only.
 *
 *  - purchased: a commodity term sits within `window_words` of a purchase frame or unit term
 *    ("Supply of Diesel Fuel", "Gravel Delivery per ton"), or the title is commodity wording with no workforce
 *    or medical context at all ("Replacement Parts for Fleet Vehicles").
 *  - not purchased: a commodity term with a workforce or medical context and no purchase frame/unit
 *    ("Fuel Handler ...", "Steel Mill Employee ...", "Grain Dust Respiratory Program"): the material only
 *    describes who or what the service is for.
 */
export function commodityPurchasedScope(
  rule: ProfileRule,
  title: string,
  workforceSignals: readonly string[],
  medicalTitleSignals: readonly string[] = [],
): CommodityScope {
  const tokens = words(title);
  const commodities = rule.triggers.filter((c) => termPositions(tokens, c).length > 0);
  if (commodities.length === 0) return { commodities, frame: null, workforceContext: false, purchased: false };
  const window = Number(rule.scope.window_words ?? 3);
  const frames = [...stringList(rule.scope.purchase_frames), ...stringList(rule.scope.unit_terms)];
  const commodityPositions = commodities.flatMap((c) => termPositions(tokens, c));
  let frame: string | null = null;
  for (const f of frames) {
    const fp = termPositions(tokens, f);
    if (fp.some((a) => commodityPositions.some((b) => Math.abs(a - b) <= window))) {
      frame = f;
      break;
    }
  }
  const workforceContext =
    matchEvidence(title, [...workforceSignals, ...stringList(rule.scope.context_terms)]).length > 0 ||
    matchEvidence(title, [...medicalTitleSignals]).length > 0;
  return {
    commodities,
    frame,
    workforceContext,
    purchased: frame !== null || !workforceContext,
  };
}

export interface RuleContext {
  title: string;
  /** title + snippet + description */
  haystack: string;
  hasProcurementSignal: boolean;
  /**
   * Opportunities only: a post-award trigger found only outside the title ("the current contract was awarded to
   * ...") does not hard-reject a notice whose title names a bid-ready procurement stage; it becomes a negative
   * signal instead. Other consumers leave this unset and keep the rule's literal any-trigger behavior.
   */
  postAwardTitleScoped?: boolean;
}
export interface RuleHardReject {
  ruleKey: string;
  action: string;
  trigger: string;
  reason: string;
}
export interface RuleEvaluation {
  hardReject: RuleHardReject | null;
  /** Conditional false-positive penalty and the signals that caused it. */
  conditionalPenalty: number;
  negativeSignals: string[];
  /** Soft penalties (informational / job-title wording). */
  softPenalties: Array<{ ruleKey: string; trigger: string; penalty: number; reason: string }>;
  /** Program-combination rules satisfied by the notice. */
  programMatches: Array<{ ruleKey: string; title: string }>;
  /** Managed-delivery/network scope is accompanied by evidence of an actual service (rule network_requires_service_evidence). */
  networkServiceEvidence: boolean;
}

const NOTICE_REJECT_ACTIONS = new Set(["reject_not_a_procurement", "reject_post_award_notice", "reject_as_out_of_scope"]);

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : [];
}
function penaltyFor(rule: ProfileRule, hits: string[]): number {
  const map = rule.scope.penalties as Record<string, number> | undefined;
  if (map && typeof map === "object") return Math.max(0, ...hits.map((h) => Number(map[h] ?? 0)));
  return Number(rule.scope.penalty ?? 0);
}

/**
 * A rule is machine-evaluated against notice text only when its scope declares how to match
 * (`match: any_trigger | title_any_trigger`). Rules without a declared match are policy text for judges and
 * prompts, not text matchers: e.g. "workers' compensation is excluded from Occu-Med's service scope" excludes
 * workers' comp as a SERVICE; it must not hard-reject a notice that merely mentions it next to real exams.
 */
function declaresMatch(rule: ProfileRule): boolean {
  return rule.scope.match === "any_trigger" || rule.scope.match === "title_any_trigger";
}

export function evaluateRules(profile: RelevanceProfile, ctx: RuleContext): RuleEvaluation {
  const out: RuleEvaluation = { hardReject: null, conditionalPenalty: 0, negativeSignals: [], softPenalties: [], programMatches: [], networkServiceEvidence: false };
  const titleService = () => matchEvidence(ctx.title, profile.allServiceTerms);
  for (const rule of profile.rules) {
    switch (rule.action) {
      case "reject_not_a_procurement":
      case "reject_post_award_notice":
      case "reject_as_out_of_scope": {
        if (out.hardReject || !declaresMatch(rule)) break;
        const hit = matchTriggers(ctx.haystack, rule.triggers)[0];
        if (
          hit &&
          rule.action === "reject_post_award_notice" &&
          ctx.postAwardTitleScoped &&
          matchTriggers(ctx.title, rule.triggers).length === 0 &&
          matchTriggers(ctx.title, profile.procurementSignals).length > 0
        ) {
          out.negativeSignals.push(`${rule.key}: ${hit} (description history in a bid-ready notice)`);
          break;
        }
        if (hit)
          out.hardReject = {
            ruleKey: rule.key,
            action: rule.action,
            trigger: hit,
            reason: `Excluded due to Occu-Med rule "${rule.title}" ("${hit}")`,
          };
        break;
      }
      case "reject_when_title_scope_non_medical": {
        if (out.hardReject) break;
        const hit = matchTriggers(ctx.title, rule.triggers)[0];
        if (hit && titleService().length === 0)
          out.hardReject = {
            ruleKey: rule.key,
            action: rule.action,
            trigger: hit,
            reason: "Primary purchased scope is non-medical work; medical wording is incidental boilerplate",
          };
        break;
      }
      case "reject_commodity_purchased_scope": {
        if (out.hardReject) break;
        const scope = commodityPurchasedScope(rule, ctx.title, profile.workforceSignals, profile.titleMedical);
        if (!scope.purchased) break;
        if (titleService().length === 0) {
          out.hardReject = {
            ruleKey: rule.key,
            action: rule.action,
            trigger: scope.commodities[0] ?? "",
            reason: `Purchased scope is a commodity/raw material ("${scope.commodities[0]}"${scope.frame ? `, "${scope.frame}"` : ""}), not an Occu-Med service`,
          };
        } else if (scope.frame) {
          // The title names an Occu-Med service AND buys a commodity: mixed scope. Never auto-accept; adjudicate.
          out.negativeSignals.push(`${rule.key}: mixed commodity and service scope (${scope.commodities[0]}, ${scope.frame})`);
          out.conditionalPenalty += Number(rule.scope.mixed_scope_penalty ?? 0);
        }
        break;
      }
      case "conditional_reject_unless_service_evidence": {
        const hits = matchTriggers(ctx.haystack, rule.triggers);
        if (hits.length && matchEvidence(ctx.haystack, stringList(rule.scope.requires_one_of)).length === 0) {
          out.negativeSignals.push(`${rule.key}: ${hits.join(", ")}`);
          out.conditionalPenalty += penaltyFor(rule, hits);
        }
        break;
      }
      case "penalize_informational_notice":
      case "penalize_job_title_wording": {
        if (rule.scope.unless === "procurement_signal_present" && ctx.hasProcurementSignal) break;
        const text = rule.scope.match === "title_any_trigger" ? ctx.title : ctx.haystack;
        const hit = matchTriggers(text, rule.triggers)[0];
        if (hit) out.softPenalties.push({ ruleKey: rule.key, trigger: hit, penalty: Number(rule.scope.penalty ?? 0), reason: rule.title });
        break;
      }
      case "accept_program_combination": {
        const groups = Array.isArray(rule.scope.all_of) ? (rule.scope.all_of as unknown[]) : [];
        if (groups.length && groups.every((g) => matchEvidence(ctx.haystack, stringList(g)).length > 0))
          out.programMatches.push({ ruleKey: rule.key, title: rule.title });
        break;
      }
      case "network_requires_service_evidence":
        if (matchEvidence(ctx.haystack, stringList(rule.scope.requires_one_of)).length > 0) out.networkServiceEvidence = true;
        break;
      default:
        break;
    }
  }
  return out;
}
