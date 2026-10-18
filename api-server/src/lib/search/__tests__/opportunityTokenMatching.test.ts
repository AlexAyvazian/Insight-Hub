/**
 * Task 01 (F-01, F-02): profile terms must match whole tokens for Opportunities, so inside-word coincidences
 * (sts <- costs, der <- provider, ems <- systems, vision <- division, tender <- bartender, lead <- leadership)
 * can no longer establish service relevance or deterministic approval. Consumers outside Opportunities keep the
 * legacy containment match until they are measured separately.
 */
import "./support/useFixtureProfile";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyResult } from "../relevance";
import { decideRelevance } from "../relevanceDecision";
import { isDeterministicallyActionable } from "../structuredOpportunityDecision";
import { rankGovConRecords } from "../../intelligence/govconIntelligence";
import { assessIntelText } from "../../intelligence/profileIntelRelevance";
import type { NormalizedOpportunity } from "../../providers/types";
import { HARD_NEGATIVES, HARD_POSITIVES, VAGUE_TITLE_POSITIVE, type AuditCase } from "./support/opportunityAuditCorpus";

const INSIDE_WORD_TERMS = ["sts", "der", "ems", "bat", "dot", "lead", "vision", "tender"];

function classify(c: AuditCase, matchMode?: "token" | "substring") {
  return classifyResult({ title: c.title, snippet: c.description, allowHistorical: true, deadlineInFuture: true, matchMode });
}

function record(c: AuditCase): NormalizedOpportunity {
  return {
    externalId: c.id,
    title: c.title,
    agency: "Example County",
    type: "Solicitation",
    status: "active",
    description: c.description,
    sourceUrl: "https://example.gov/bids/1",
    source: "samGov",
    providerName: "samGov",
    postedDate: new Date("2026-09-20T00:00:00Z"),
    responseDeadline: new Date(Date.now() + 30 * 86_400_000),
  } as NormalizedOpportunity;
}

describe("Opportunities token matching", () => {
  for (const c of HARD_NEGATIVES) {
    it(`${c.id}: no inside-word evidence and never accepted`, () => {
      const r = classify(c);
      assert.notEqual(decideRelevance(r).verdict, "accept", `${c.id} accepted with score ${r.score}`);
      const evidence = [...r.matchedComponentTerms, ...r.matchedExplicitPhrases, ...r.matchedRegulatorySignals];
      const haystack = ` ${c.title} ${c.description} `.toLowerCase();
      for (const term of evidence.filter((t) => INSIDE_WORD_TERMS.includes(t))) {
        assert.match(haystack, new RegExp(`(?<![a-z0-9])${term}s?(?![a-z0-9])`), `${term} matched inside a word`);
      }
    });
    it(`${c.id}: never deterministically approved`, () => {
      assert.equal(isDeterministicallyActionable(record(c)), false);
    });
  }

  for (const c of [...HARD_POSITIVES, VAGUE_TITLE_POSITIVE]) {
    it(`${c.id}: genuine service scope is still accepted by the classifier`, () => {
      const r = classify(c);
      assert.equal(decideRelevance(r).verdict, "accept", `${c.id}: ${r.score} ${r.reasons.join("; ")}`);
    });
  }

  it("before/after evidence: construction QA was accepted only through inside-word matches", () => {
    const qa = HARD_NEGATIVES.find((c) => c.id === "neg-construction-qa")!;
    const legacy = classify(qa, "substring");
    const fixed = classify(qa, "token");
    assert.equal(decideRelevance(legacy).verdict, "accept");
    assert.ok(legacy.matchedComponentTerms.includes("sts"));
    assert.ok(!fixed.matchedComponentTerms.includes("sts"));
    assert.ok(fixed.score < legacy.score);
  });

  it("short acronyms still match as whole tokens, including plurals and punctuation", () => {
    const r = classifyResult({
      title: "DOT Drug Testing RFPs",
      snippet: "IDIQs for DOT-regulated testing; lead surveillance (OSHA) for employees.",
      allowHistorical: true,
    });
    assert.ok(r.matchedRegulatorySignals.includes("dot"));
    assert.ok(r.matchedRegulatorySignals.includes("lead"));
    assert.ok(r.matchedProcurementSignals.includes("rfp"));
    assert.ok(r.matchedProcurementSignals.includes("idiq"));
  });

  it("strong deterministic approval still works for evidenced purchased scope", () => {
    const pos = HARD_POSITIVES.find((c) => c.id === "pos-medical-exam-services")!;
    assert.equal(isDeterministicallyActionable(record(pos)), true);
  });
});

describe("consumers outside Opportunities keep legacy matching", () => {
  const qa = HARD_NEGATIVES.find((c) => c.id === "neg-construction-qa")!;
  const legacyVerdict = decideRelevance(
    classifyResult({ title: qa.title, snippet: ["Example Agency", qa.description].join(" "), allowHistorical: true, matchMode: "substring" }),
  ).verdict;

  it("GovCon (Forecasts / Recompete) ranking is unchanged", async () => {
    const [ranked] = await rankGovConRecords([{ id: qa.id, title: qa.title, agency: "Example Agency", description: qa.description }], "forecast");
    assert.equal(ranked!.relevance.verdict, legacyVerdict);
  });

  it("intel feed assessment is unchanged", () => {
    const legacy = classifyResult({ title: qa.title, snippet: qa.description, allowHistorical: true, matchMode: "substring" });
    assert.equal(assessIntelText({ title: qa.title, text: qa.description }).score, Math.round(legacy.score));
  });
});
