/**
 * Read-time use of the stored authoritative decision (opportunity list and detail routes).
 *
 * The routes still classify the listing text (that is all a stored row carries), but when a current stored decision
 * exists for the row they defer to it: under OPPORTUNITY_DECISION_AUTHORITY=flag (default) a stored approval is
 * authoritative and a stored hold/rejection is only flagged; under "enforce" both are authoritative; "off" keeps the
 * read-time classification. The decision fields are always exposed so the UI can show one outcome.
 */
import type { StoredDecisionOverride } from "../opportunityQuality";
import { decisionAuthority } from "./flags";
import { opportunityKeyForRow } from "./identity";
import { getRelevanceProfile } from "../search/relevanceProfile";
import {
  authoritativeDecisionView,
  isApprovedState,
  storedDecisions,
  type AuthoritativeDecisionView,
  type DecisionState,
  type StoredDecision,
} from "./decisionRecord";

type Row = Record<string, any>;

let warnedUntil = 0;

/** Stored decisions for these rows, by row id. A storage failure means "no stored decision", never an error. */
export async function loadStoredDecisionsForRows(rows: Row[]): Promise<Map<string, StoredDecision>> {
  const byId = new Map<string, StoredDecision>();
  if (rows.length === 0) return byId;
  try {
    const keys = new Map(rows.map((row) => [String(row.id), opportunityKeyForRow(row)] as const));
    const stored = await storedDecisions([...keys.values()]);
    for (const [id, key] of keys) {
      const decision = stored.get(key);
      if (decision) byId.set(id, decision);
    }
  } catch (error) {
    if (Date.now() > warnedUntil) {
      warnedUntil = Date.now() + 60_000;
      console.warn(JSON.stringify({ event: "opportunity_decision_lookup_failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return byId;
}

export interface ReadTimeDecision {
  view: AuthoritativeDecisionView;
  /** Passed to classifyOpportunityQuality when the stored decision is authoritative. */
  override: StoredDecisionOverride | null;
}

export function readTimeDecision(row: Row, stored: StoredDecision | undefined, readTimeEligible: boolean): ReadTimeDecision {
  const view = authoritativeDecisionView(stored, row, {
    profileVersion: getRelevanceProfile().version,
    authority: decisionAuthority(),
    readTimeEligible,
  });
  const override = view.authoritative && view.state !== "closed"
    ? { relevanceEligible: isApprovedState(view.state), score: view.score }
    : null;
  return { view, override };
}

/** The accept / review / reject verdict that matches a decision state. */
export function verdictForState(state: DecisionState): "accept" | "review" | "reject" {
  return isApprovedState(state) ? "accept" : state === "out_of_scope" ? "reject" : "review";
}
