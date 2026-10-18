/**
 * Task 03 (F-03, F-23, F-25): the AI review budget bounds paid review calls, never record retention. Ambiguous
 * structured-provider records that are not approved (budget reached, reviewer declined, reviewer unavailable) are
 * returned flagged so ingestion stages them as quarantined; they are never promoted to verified opportunities.
 */
import "./support/useFixtureProfile";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedOpportunity } from "../../providers/types";
import { decideStructuredOpportunities } from "../structuredOpportunityDecision";
import { applyStructuredFederalDecision, approvedRecordCount } from "../../ingestion/providerRunner";
import { QUALITY_REJECTION_CODES, decideOpportunityQuality } from "../../ingestion/opportunityIdentity";

const DAY_MS = 86_400_000;

function ambiguous(i: number): NormalizedOpportunity {
  // Genuine scope but no response deadline: never deterministically actionable, so it needs review.
  return {
    externalId: `held-${i}`,
    title: `Occupational Health and Employee Medical Examination Services RFP ${i}`,
    agency: "Example County",
    type: "Solicitation",
    status: "active",
    postedDate: new Date(Date.now() - 5 * DAY_MS),
    description:
      "The county requests proposals for pre-employment physical examinations, audiometric testing, spirometry, drug testing, and medical surveillance services for its workforce.",
    sourceUrl: `https://sam.gov/opp/held${i}/view`,
    source: "samGov",
  } as NormalizedOpportunity;
}

function clear(): NormalizedOpportunity {
  return { ...ambiguous(99), externalId: "clear-1", responseDeadline: new Date(Date.now() + 30 * DAY_MS) };
}

function unrelated(): NormalizedOpportunity {
  return {
    ...ambiguous(98),
    externalId: "reject-1",
    title: "Janitorial Services Solicitation",
    description: "Request for proposal for janitorial and landscaping services at county buildings.",
  };
}

describe("structured review preservation", () => {
  it("six ambiguous records with a budget of three: all six accounted for, at most three sent to review", async () => {
    const previous = process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT;
    process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT = "3";
    try {
      const records = [0, 1, 2, 3, 4, 5].map(ambiguous);
      const result = await decideStructuredOpportunities([...records, clear(), unrelated()]);
      assert.equal(result.approved.length + result.held.length, 7);
      assert.equal(result.rejectedRecords.length, 1);
      assert.equal(result.reviewHeld, result.held.length);
      const budget = result.held.filter((h) => h.code === "structured_review_budget");
      assert.equal(budget.length, 3, "records beyond the budget are held, not dropped");
      assert.ok(result.held.length >= 6, "no reviewer is configured in tests, so nothing ambiguous is approved");
      for (const h of result.held) assert.ok(h.reason.length > 0);
      const ids = new Set([...result.approved, ...result.held.map((h) => h.record)].map((r) => r.externalId));
      for (const r of records) assert.ok(ids.has(r.externalId), `${r.externalId} disappeared`);
    } finally {
      if (previous === undefined) delete process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT;
      else process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT = previous;
    }
  });

  it("provider runner returns held and rejected records flagged for staging, and counts only approved", async () => {
    // (The pre-existing query-partition guard runs before this decision; its drops are tracked separately.)
    const result = await applyStructuredFederalDecision("samGov", [ambiguous(1), clear()], [], {});
    assert.equal(result.records.length, 2);
    assert.equal(approvedRecordCount(result), 1);
    const statuses = result.records.map((r) => (r.rawData as any)?.structuredDecision?.status ?? "approved").sort();
    assert.deepEqual(statuses, ["approved", "held"]);
  });

  it("held records are staged as quarantined and never promoted, even if the classifier would accept", async () => {
    const result = await applyStructuredFederalDecision("samGov", [{ ...ambiguous(2), responseDeadline: new Date(Date.now() + 30 * DAY_MS), title: "Respirator Fit Testing and Employee Physicals" }], [], {});
    for (const record of result.records) {
      const marker = (record.rawData as any)?.structuredDecision;
      const q = decideOpportunityQuality(record);
      if (marker?.status === "held") {
        assert.equal(q.status, "quarantined");
        assert.ok(q.reason?.startsWith(QUALITY_REJECTION_CODES.structuredReviewHeld));
      }
    }
    const held = { ...ambiguous(3), rawData: { structuredDecision: { status: "held", code: "structured_review_budget", reason: "budget" } } };
    const q = decideOpportunityQuality({ ...held, responseDeadline: new Date(Date.now() + 30 * DAY_MS) } as NormalizedOpportunity);
    assert.equal(q.status, "quarantined");
  });

  it("approved records are still accepted; rejected records keep rejection provenance", () => {
    assert.equal(decideOpportunityQuality(clear()).status, "accepted");
    const rejected = { ...unrelated(), rawData: { structuredDecision: { status: "rejected", code: "structured_relevance_reject", reason: "x" } } };
    assert.equal(decideOpportunityQuality(rejected as NormalizedOpportunity).status, "rejected");
  });

  it("a reviewer failure preserves every candidate with a reason", async () => {
    const result = await decideStructuredOpportunities([ambiguous(7), ambiguous(8)]);
    assert.equal(result.held.length + result.approved.length, 2);
    for (const h of result.held) assert.match(h.code, /^structured_review_/);
  });
});
