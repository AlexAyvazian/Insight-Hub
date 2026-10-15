import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isUsableAiBrief,
  mergeSummaryWithVerifiedFacts,
  sourceStatesDate,
  sourceStatesValue,
} from "../../lib/summaryEvidence";
import { classifyOpportunityQuality, summaryEvidenceFingerprint } from "../../lib/opportunityQuality";

describe("opportunity summary evidence merge", () => {
  it("does not allow AI output to replace verified buyer, deadline, or value", () => {
    const base = {
      summary: "Verified summary",
      occumedFit: "Verified fit",
      serviceLines: ["Occupational health"],
      keyDates: { posted: "2026-07-01", due: "2026-08-15" },
      buyer: "City of Example",
      estimatedValue: "$25.0K",
      solicitationType: "Solicitation",
      classification: "verified-open",
      sourceUrl: "https://sam.gov/opp/example/view",
      bidNotes: [],
      missingInfo: [],
      fitVerdict: "Strong fit after source verification",
      confidence: "high",
      evidenceFingerprint: "fp-1",
    };
    const merged = mergeSummaryWithVerifiedFacts({ buyer: "Wrong Buyer", keyDates: { posted: "2020-01-01", due: "2020-01-02" }, estimatedValue: "$999M", summary: "Narrative" }, base, "test");
    assert.equal(merged.buyer, "City of Example");
    assert.deepEqual(merged.keyDates, { posted: "2026-07-01", due: "2026-08-15" });
    assert.equal(merged.estimatedValue, "$25.0K");
    assert.equal(merged.evidenceSource, undefined);
  });

  it("keeps the deterministic fit and full response shape for vague model output", () => {
    const base = {
      summary: "Verified summary",
      occumedFit: "Strong fit for occupational medicine services",
      serviceLines: ["Occupational health"],
      keyDates: { posted: "2026-07-01", due: "2026-08-15" },
      buyer: "City of Example",
      evidenceSource: "official-direct",
      sourceAuthority: "trusted",
      eligible: true,
      evidenceFingerprint: "fp-1",
    };
    const merged = mergeSummaryWithVerifiedFacts(
      { occumedFit: "This may fit general occupational health" },
      base,
      "test",
    );
    assert.equal(merged.occumedFit, base.occumedFit);
    assert.equal(merged.evidenceSource, "official-direct");
    assert.equal(merged.sourceAuthority, "trusted");
    assert.equal(merged.eligible, true);
  });

  it("changes evidence fingerprints when material evidence changes", () => {
    const base = {
      title: "RFP Occupational Health Services",
      agency: "City of Example",
      type: "Solicitation",
      status: "active",
      postedDate: new Date("2026-07-01"),
      responseDeadline: new Date("2026-08-15"),
      description: "Request for proposal for occupational health services.",
      samUrl: "https://sam.gov/opp/example/view",
      providerName: "samGov",
      sourceConfidence: "high",
    };
    const one = summaryEvidenceFingerprint(classifyOpportunityQuality(base), "content-a");
    const two = summaryEvidenceFingerprint(
      classifyOpportunityQuality({ ...base, responseDeadline: new Date("2026-09-01") }),
      "content-a",
    );
    assert.notEqual(one, two);
  });

  const SOURCE =
    "Request for Proposal 26-014. The County of Example is seeking proposals for pre-employment physicals and DOT drug screening. " +
    "Proposals are due no later than August 15, 2026 at 2:00 PM. The estimated contract value is $250,000 over three years. " +
    "Contact the Purchasing Division, County of Example, with questions. ".repeat(2);

  const cardWithGaps = () => ({
    summary: "Verified summary",
    occumedFit: "Verified fit",
    serviceLines: ["Occupational health"],
    keyDates: { posted: null, due: null },
    buyer: null,
    estimatedValue: null,
    fitVerdict: "Partial fit after source verification",
    confidence: "medium",
    missingInfo: ["confirmed deadline", "estimated value / budget", "buyer / contracting office", "working source link"],
  });

  it("fills facts the saved card lacks only when the fetched source text states them", () => {
    const merged = mergeSummaryWithVerifiedFacts(
      {
        keyDates: { posted: null, due: "2026-08-15" },
        buyer: "County of Example",
        estimatedValue: "$250,000",
      },
      cardWithGaps(),
      "test",
      SOURCE,
    );
    assert.equal(merged.keyDates.due, "2026-08-15");
    assert.equal(merged.buyer, "County of Example");
    assert.equal(merged.estimatedValue, "$250,000");
    assert.deepEqual(merged.verifiedFromSource.sort(), ["buyer", "due", "estimatedValue"]);
    assert.deepEqual(merged.missingInfo, ["working source link"]);
  });

  it("rejects invented dates, buyers and values that the source never states", () => {
    const merged = mergeSummaryWithVerifiedFacts(
      {
        keyDates: { posted: "2026-01-02", due: "2026-09-30" },
        buyer: "City of Somewhere Else",
        estimatedValue: "$9,999,999",
      },
      cardWithGaps(),
      "test",
      SOURCE,
    );
    assert.equal(merged.keyDates.due, null);
    assert.equal(merged.keyDates.posted, null);
    assert.equal(merged.buyer, null);
    assert.equal(merged.estimatedValue, null);
    assert.deepEqual(merged.verifiedFromSource, []);
    assert.ok(merged.missingInfo.includes("confirmed deadline"));
  });

  it("does not recover facts without source text", () => {
    const merged = mergeSummaryWithVerifiedFacts(
      { keyDates: { due: "2026-08-15" }, buyer: "County of Example" },
      cardWithGaps(),
      "test",
    );
    assert.equal(merged.keyDates.due, null);
    assert.equal(merged.buyer, null);
  });

  it("recognizes the date spellings real solicitations use", () => {
    assert.equal(sourceStatesDate("Due 08/15/2026 by noon", "2026-08-15"), true);
    assert.equal(sourceStatesDate("Due Aug. 15, 2026", "2026-08-15"), true);
    assert.equal(sourceStatesDate("Due 15 August 2026", "2026-08-15"), true);
    assert.equal(sourceStatesDate("Due August 16, 2026", "2026-08-15"), false);
    assert.equal(sourceStatesDate("Due soon", "not-a-date"), false);
    assert.equal(sourceStatesValue("value of $250,000.", "$250,000"), true);
    assert.equal(sourceStatesValue("value of $250,000.", "250000"), true);
    assert.equal(sourceStatesValue("value of $250,000.", "$300,000"), false);
  });

  it("carries the tests requested and scope the model extracted", () => {
    const merged = mergeSummaryWithVerifiedFacts(
      {
        testsRequested: ["DOT drug screen", "  ", 42, "pre-employment physical"],
        scope: "About 400 exams per year across three clinics, three-year term.",
      },
      cardWithGaps(),
      "test",
    );
    assert.deepEqual(merged.testsRequested, ["DOT drug screen", "pre-employment physical"]);
    assert.match(merged.scope, /400 exams/);
    assert.deepEqual(mergeSummaryWithVerifiedFacts({}, cardWithGaps(), "test").testsRequested, []);
    assert.equal(mergeSummaryWithVerifiedFacts({}, cardWithGaps(), "test").scope, null);
  });

  it("only accepts a model reply that actually says something", () => {
    assert.equal(isUsableAiBrief({}), false);
    assert.equal(isUsableAiBrief(null), false);
    assert.equal(isUsableAiBrief({ summary: "ok", occumedFit: "yes" }), false);
    assert.equal(
      isUsableAiBrief({
        summary: "The County of Example is buying pre-employment physicals and DOT drug screening.",
        occumedFit: "Direct fit: both services are core Occu-Med exams.",
      }),
      true,
    );
  });
});
