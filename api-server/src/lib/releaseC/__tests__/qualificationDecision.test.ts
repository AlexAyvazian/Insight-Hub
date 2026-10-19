/**
 * Opportunities wave 4 (qualification): one authoritative, versioned decision per opportunity. Abstention is
 * needs_review, approvals resting only on invalid citations are downgraded, a second evaluator is asked only on a
 * genuine conflict, read-time classification defers to a current stored decision, and changed inputs reopen it.
 */
import "../../search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { NormalizedOpportunity } from "../../providers/types";
import { decideStructuredOpportunities, escalationConflict, type ReviewProvider } from "../../search/structuredOpportunityDecision";
import { clearProviderBudgetMemory } from "../../providerBudget";
import { classifyOpportunityQuality } from "../../opportunityQuality";
import { decideOpportunityQuality, generatedProviderNativeId, providerKeyForOpportunity } from "../../ingestion/opportunityIdentity";
import { normalizedToDbRecord } from "../../search/normalization";
import { getRelevanceProfile } from "../../search/relevanceProfile";
import {
  authoritativeDecisionView,
  decisionStateFor,
  noticeFingerprint,
  reopenDecisionsForProfile,
  storedDecisions,
  validateCitations,
  type StoredDecision,
} from "../decisionRecord";
import { decisionAuthority } from "../flags";
import { opportunityKey, opportunityKeyForRow } from "../identity";
import { loadStoredDecisionsForRows, readTimeDecision } from "../readTimeDecision";
import { cachedQueueDecisions, reopenOpportunity } from "../reviewQueue";

const DAY_MS = 86_400_000;
let seq = 0;

function ambiguous(id: string, extra: Partial<NormalizedOpportunity> = {}): NormalizedOpportunity {
  // Genuine primary scope but no response deadline: never deterministically actionable, so the evaluator decides.
  return {
    externalId: `w4-${id}`,
    title: `Occupational Health and Employee Medical Examination Services RFP ${id}`,
    agency: "Example County",
    type: "Solicitation",
    status: "active",
    postedDate: new Date(Date.now() - 5 * DAY_MS),
    description:
      "The county requests proposals for pre-employment physical examinations, audiometric testing, spirometry, drug testing, and medical surveillance services for its workforce.",
    sourceUrl: `https://example.gov/rfp/w4-${id}`,
    source: "samGov",
    ...extra,
  } as NormalizedOpportunity;
}

interface MockJudge extends ReviewProvider {
  defaultModel: string;
  calls: number;
}

function judge(model: string, row: (title: string) => Record<string, unknown>, options: { fail?: boolean } = {}): MockJudge {
  const mock: MockJudge = {
    name: `w4-${model.replace(/[^a-z0-9]/gi, "")}-${(seq += 1)}`,
    defaultModel: model,
    calls: 0,
    async isConfigured() {
      return true;
    },
    async complete(prompt: string) {
      mock.calls += 1;
      if (options.fail) throw new Error("429 rate limit: Please try again in 2m0s");
      const titles = [...prompt.matchAll(/^\[(\d+)\]\nTitle: (.*)$/gm)].map((m) => m[2]!);
      return JSON.stringify({ results: titles.map((title, index) => ({ index, reason: "mock", ...row(title) })) });
    },
  };
  return mock;
}

const yes = () => ({ isOpportunity: true, relevanceScore: 92 });

beforeEach(() => clearProviderBudgetMemory());

describe("decision states", () => {
  it("an abstention is needs_review: settled, neither an approval nor a rejection", async () => {
    const abstaining = judge("mistral-small-latest", () => ({ isOpportunity: null, relevanceScore: 0, reason: "SOW not included" }));
    const record = ambiguous("abstain");
    const result = await decideStructuredOpportunities([record], { persist: false, reviewProviders: [abstaining], reviewMode: "single" });
    const decision = result.decisions.get(opportunityKey(record));
    assert.equal(result.approved.length, 0);
    assert.equal(result.rejected, 0);
    assert.equal(decision?.state, "needs_review");
    assert.equal(decision?.holdCode, "structured_review_abstained");
    assert.equal(decision?.settled, true);
    assert.equal((result.held[0]?.record.rawData as Record<string, unknown>).opportunityDecisionState, "needs_review");
  });

  it("maps outcomes to states", () => {
    assert.equal(decisionStateFor({ outcome: "approved", evidenceBacked: true }), "qualified");
    assert.equal(decisionStateFor({ outcome: "approved", evidenceBacked: true, documentsPartial: true }), "provisional");
    assert.equal(decisionStateFor({ outcome: "held", holdCode: "structured_document_pending" }), "provisional");
    assert.equal(decisionStateFor({ outcome: "held", holdCode: "structured_review_disputed" }), "needs_review");
    assert.equal(decisionStateFor({ outcome: "held", holdCode: "structured_review_declined", evaluatorRejected: true }), "out_of_scope");
    assert.equal(decisionStateFor({ outcome: "rejected" }), "out_of_scope");
    assert.equal(decisionStateFor({ outcome: "approved", responseDeadline: new Date(Date.now() - DAY_MS) }), "closed");
  });

  it("the decision cites the primary purchased scope, not incidental mentions", async () => {
    const record = ambiguous("scope");
    const result = await decideStructuredOpportunities([record], { persist: false, reviewProviders: [judge("mistral-small-latest", yes)], reviewMode: "single" });
    const decision = result.decisions.get(opportunityKey(record))!;
    const scope = decision.primaryScope as { evidenced: boolean; source: string; terms: string[] };
    assert.equal(decision.state, "qualified");
    assert.equal(scope.evidenced, true);
    assert.equal(scope.source, "notice");
    assert.ok(scope.terms.length > 0);
    assert.match(decision.reason, /^Primary purchased scope \(notice\): /);
  });
});

describe("evaluator citations", () => {
  const sections = [
    { id: "sec-1", documentId: "doc-1", documentTitle: "Statement of Work", sourceUrl: "https://example.gov/sow.pdf", pageStart: 3, pageEnd: 3, heading: "Scope", kind: "scope" as const, text: "The contractor shall provide annual audiometric testing and respirator medical clearances for 400 employees." },
  ];

  it("keeps citations found in stored sections or the notice and drops the rest", () => {
    const check = validateCitations(
      [
        { section: "[Statement of Work, p.3, Scope]", quote: "annual audiometric testing and respirator medical clearances" },
        { section: "sec-1", quote: "The contractor shall provide annual audiometric testing" },
        { section: "notice", quote: "pre-employment physical examinations, audiometric testing" },
        { section: "[Statement of Work, p.9, Pricing]", quote: "annual audiometric testing and respirator medical clearances" },
        { section: "sec-1", quote: "the contractor shall provide dental implants for all staff" },
        { section: null, quote: "short" },
      ],
      { sections, noticeText: ambiguous("cite").description ?? "" },
    );
    assert.equal(check.valid.length, 3);
    assert.deepEqual(check.dropped.map((d) => d.why), ["unknown_section", "quote_not_found", "quote_too_short"]);
  });

  it("downgrades an approval that relied only on invalid citations to needs_review", async () => {
    const record = ambiguous("badcite");
    const inventing = judge("mistral-small-latest", () => ({
      isOpportunity: true,
      relevanceScore: 94,
      evidence: [{ section: "[Statement of Work, p.12, Section C.4]", quote: "contractor shall perform DOT physicals at 14 sites" }],
    }));
    const result = await decideStructuredOpportunities([record], { persist: false, reviewProviders: [inventing], reviewMode: "single" });
    assert.equal(result.approved.length, 0);
    assert.equal(result.held[0]?.code, "structured_evidence_unverified");
    const decision = result.decisions.get(opportunityKey(record))!;
    assert.equal(decision.state, "needs_review");
    assert.equal(decision.citations?.valid.length, 0);
    assert.equal(decision.citations?.dropped[0]?.why, "unknown_section");
  });

  it("an approval with at least one verified citation stands; the invalid one is dropped", async () => {
    const record = ambiguous("goodcite");
    const citing = judge("mistral-small-latest", () => ({
      isOpportunity: true,
      relevanceScore: 94,
      evidence: [
        { section: "notice", quote: "pre-employment physical examinations, audiometric testing, spirometry" },
        { section: "[SOW, p.2]", quote: "invented text" },
      ],
    }));
    const result = await decideStructuredOpportunities([record], { persist: false, reviewProviders: [citing], reviewMode: "single" });
    assert.equal(result.aiApproved, 1);
    const raw = result.approved[0]!.rawData as Record<string, unknown>;
    assert.equal((raw.opportunityDecisionCitations as unknown[]).length, 1);
    assert.equal(result.decisions.get(opportunityKey(record))?.citations?.dropped.length, 1);
  });
});

describe("escalation only on genuine conflict", () => {
  it("an approval that agrees with the evidence is never escalated", async () => {
    const a = judge("mistral-small-latest", yes);
    const b = judge("deepseek-chat", yes);
    const record = ambiguous("agree");
    const result = await decideStructuredOpportunities([record], { persist: false, reviewProviders: [a, b], reviewMode: "single" });
    assert.equal(a.calls + b.calls, 1);
    assert.equal(result.decisions.get(opportunityKey(record))?.escalation, null);
  });

  it("an approval the documents contradict is escalated to a second family, and the conflict is recorded", async () => {
    const record = ambiguous("contradict", {
      rawData: {
        documentEvidence: {
          text: "[Amendment 1, p.1] Pre-employment physical examinations are not included in this contract and are hereby deleted.",
          citations: ["[Amendment 1, p.1]"],
          documents: 1,
          extracted: 1,
          pending: 0,
          hashes: [],
        },
      },
    });
    const a = judge("mistral-small-latest", yes);
    const b = judge("deepseek-chat", () => ({ isOpportunity: false, relevanceScore: 10 }));
    const result = await decideStructuredOpportunities([record], { persist: false, reviewProviders: [a, b], reviewMode: "single" });
    assert.equal(a.calls + b.calls, 2, "the conflict gets a second opinion");
    const decision = result.decisions.get(opportunityKey(record))!;
    assert.equal(decision.escalation, "evaluator_approves_against_documents");
    assert.equal(decision.state, "needs_review", "a split is unresolved, not an approval");
  });

  it("names each conflict", () => {
    const scope = { evidenced: true, path: "title-service-term" as const, terms: ["x"], kind: "service" as const, hold: null, source: "notice" as const };
    const vote = (isOpportunity: boolean, abstain = false) => ({ index: 0, isOpportunity, relevanceScore: 90, reason: "", ...(abstain ? { abstain } : {}) });
    assert.equal(escalationConflict({ verdict: "review", primaryScope: scope, documentContradiction: false }, vote(true)), null);
    assert.equal(escalationConflict({ verdict: "review", primaryScope: scope, documentContradiction: false }, vote(false)), null);
    assert.equal(escalationConflict({ verdict: "accept", primaryScope: scope, documentContradiction: false }, vote(false)), "evaluator_rejects_rule_accept");
    assert.equal(escalationConflict({ verdict: "accept", primaryScope: scope, documentContradiction: false }, vote(false, true)), null);
    assert.equal(escalationConflict({ verdict: "review", primaryScope: { ...scope, kind: "component_only_scope" }, documentContradiction: false }, vote(true)), "evaluator_approves_component_or_supply_scope");
    assert.equal(escalationConflict({ verdict: "review", primaryScope: { ...scope, evidenced: false }, documentContradiction: false }, vote(true)), "evaluator_approves_without_primary_scope");
  });
});

/** A stored opportunities row as promotion writes it for this record. */
function storedRow(record: NormalizedOpportunity, id: string): Record<string, unknown> {
  return {
    ...normalizedToDbRecord({ ...record, externalId: generatedProviderNativeId(record) }),
    id,
    noticeId: generatedProviderNativeId(record),
    providerKey: providerKeyForOpportunity(record),
    samUrl: record.sourceUrl,
  };
}

function stored(overrides: Partial<StoredDecision> = {}): StoredDecision {
  return {
    opportunityKey: "k", decisionVersion: 2, evaluatorVersion: "v", inputsHash: "h", pendingInputsHash: null,
    profileVersion: getRelevanceProfile().version, noticeFingerprint: noticeFingerprint("T", "D"), state: "qualified",
    outcome: "approved", settled: true, method: "single-ai-review", holdCode: null, score: 91, reason: "r",
    primaryScope: null, citations: null, escalation: null, reviewers: [], families: [], stale: false, staleReason: null,
    decidedAt: null, ...overrides,
  };
}

describe("read-time classification defers to the stored decision", () => {
  it("a current stored approval is authoritative; a changed notice or profile makes it not current", () => {
    const options = { profileVersion: getRelevanceProfile().version, authority: "flag" as const, readTimeEligible: false };
    const view = authoritativeDecisionView(stored(), { title: "T", description: "D" }, options);
    assert.equal(view.authoritative, true);
    assert.match(view.readTimeConflict ?? "", /authoritative/);
    assert.equal(authoritativeDecisionView(stored(), { title: "T", description: "D changed" }, options).current, false);
    assert.equal(authoritativeDecisionView(stored({ profileVersion: "older" }), { title: "T", description: "D" }, options).staleReason, "profile_version_changed");
    assert.equal(authoritativeDecisionView(stored({ stale: true, staleReason: "inputs_changed" }), { title: "T", description: "D" }, options).authoritative, false);
  });

  it("a stored hold of a visible record is only flagged by default and overturns it only under enforce", () => {
    const row = { title: "T", description: "D" };
    const base = { profileVersion: getRelevanceProfile().version, readTimeEligible: true };
    const flagged = authoritativeDecisionView(stored({ state: "needs_review", outcome: "held" }), row, { ...base, authority: "flag" });
    assert.equal(flagged.authoritative, false);
    assert.match(flagged.readTimeConflict ?? "", /flagged only/);
    assert.equal(authoritativeDecisionView(stored({ state: "needs_review", outcome: "held" }), row, { ...base, authority: "enforce" }).authoritative, true);
    assert.equal(authoritativeDecisionView(stored(), row, { ...base, readTimeEligible: false, authority: "off" }).authoritative, false);
    assert.equal(decisionAuthority({}), "flag");
  });

  it("the list boundary finds the stored decision for a promoted row and follows it", async () => {
    const record = ambiguous(`boundary-${Date.now()}`, { responseDeadline: new Date(Date.now() + 20 * DAY_MS) });
    // Persist a stored approval for this record's current inputs.
    await decideStructuredOpportunities([record], { persist: true, reviewProviders: [judge("mistral-small-latest", yes)], reviewMode: "single", timeBudgetMs: 60_000 });
    const row = storedRow(record, `row-${Date.now()}`);
    assert.equal(opportunityKeyForRow(row), opportunityKey(record));
    const byId = await loadStoredDecisionsForRows([row]);
    const decision = byId.get(String(row.id));
    assert.ok(decision, "the promoted row maps back to its decision");
    // Even where the listing-text check would hold the row, the current stored approval is what the view shows.
    const { view, override } = readTimeDecision(row, decision, false);
    assert.equal(view.current, true);
    assert.equal(view.authoritative, true);
    assert.ok(view.decisionVersion! >= 1);
    assert.equal(classifyOpportunityQuality(row, new Date(), override).relevanceEligible, true);
    // A row whose notice text no longer matches what was judged falls back to read-time classification.
    const edited = { ...row, description: `${row.description} Amended.` };
    assert.equal(readTimeDecision(edited, decision, false).override, null);
  });

  it("ingestion's quality gate follows a stored approval in the review band", () => {
    const record = {
      ...ambiguous("ingest"),
      title: "Health Services Contract",
      description: "Vendor will provide health screening for employees.",
    } as NormalizedOpportunity;
    const before = decideOpportunityQuality(record);
    assert.equal(before.status, "quarantined");
    assert.match(before.reason ?? "", /^adjudication_band\|/);
    const approved = { ...record, rawData: { opportunityDecision: "actionable", opportunityDecisionState: "qualified" } } as NormalizedOpportunity;
    assert.equal(decideOpportunityQuality(approved).status, "accepted");
    const held = { ...record, rawData: { opportunityDecisionState: "needs_review" } } as NormalizedOpportunity;
    assert.equal(decideOpportunityQuality(held).status, "quarantined", "only an approval lifts the review band");
  });
});

describe("changed inputs reopen the stored decision", () => {
  it("new inputs mark the decision stale and the item re-enters the review queue; a settled re-decision bumps the version", async () => {
    const record = ambiguous(`reopen-${Date.now()}`);
    const key = opportunityKey(record);
    await decideStructuredOpportunities([record], { persist: true, reviewProviders: [judge("mistral-small-latest", yes)], reviewMode: "single", timeBudgetMs: 60_000 });
    const first = (await storedDecisions([key])).get(key)!;
    assert.equal(first.state, "qualified");
    assert.equal(first.stale, false);

    // An amendment changes the inputs while no evaluator is available: the old decision is stale, not replaced.
    const amended = { ...record, description: `${record.description} Amendment 1 adds respirator fit testing.` } as NormalizedOpportunity;
    await decideStructuredOpportunities([amended], { persist: true, reviewProviders: [judge("deepseek-chat", yes, { fail: true })], reviewMode: "single", timeBudgetMs: 60_000 });
    const staled = (await storedDecisions([key])).get(key)!;
    assert.equal(staled.stale, true);
    assert.equal(staled.staleReason, "inputs_changed");
    assert.equal(staled.decisionVersion, first.decisionVersion);
    assert.notEqual(staled.pendingInputsHash, first.inputsHash);
    assert.equal((await cachedQueueDecisions([key])).get(key)?.status, "queued");

    clearProviderBudgetMemory();
    await decideStructuredOpportunities([amended], { persist: true, reviewProviders: [judge("gpt-oss-120b", yes)], reviewMode: "single", timeBudgetMs: 60_000 });
    const second = (await storedDecisions([key])).get(key)!;
    assert.equal(second.stale, false);
    assert.equal(second.decisionVersion, first.decisionVersion + 1);
    assert.equal(second.inputsHash, staled.pendingInputsHash);
  });

  it("new documents reopen a deterministic approval that never had a queue row", async () => {
    const record = ambiguous(`docs-${Date.now()}`, { responseDeadline: new Date(Date.now() + 20 * DAY_MS) });
    const key = opportunityKey(record);
    const result = await decideStructuredOpportunities([record], { persist: true, reviewProviders: [], timeBudgetMs: 60_000 });
    assert.equal(result.deterministicApproved, 1);
    assert.equal((await cachedQueueDecisions([key])).get(key), undefined);
    await reopenOpportunity(key, "document evidence available");
    const decision = (await storedDecisions([key])).get(key)!;
    assert.equal(decision.stale, true);
    assert.equal(decision.staleReason, "document evidence available");
    assert.equal((await cachedQueueDecisions([key])).get(key)?.status, "queued");
  });

  it("a profile version change reopens decisions made under the old version", async () => {
    const record = ambiguous(`profile-${Date.now()}`);
    const key = opportunityKey(record);
    await decideStructuredOpportunities([record], { persist: true, reviewProviders: [judge("mistral-small-latest", yes)], reviewMode: "single", timeBudgetMs: 60_000 });
    const reopened = await reopenDecisionsForProfile(`next-${getRelevanceProfile().version}`, 10_000);
    assert.ok(reopened >= 1);
    const decision = (await storedDecisions([key])).get(key)!;
    assert.equal(decision.stale, true);
    assert.equal(decision.staleReason, "profile_version_changed");
    assert.equal((await cachedQueueDecisions([key])).get(key)?.status, "queued");
  });
});
