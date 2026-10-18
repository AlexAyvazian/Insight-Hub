/**
 * Primary purchased scope (Release C false positives). The last five AI-agreed wrong high-confidence matches in the
 * Release C benchmark were real procurement notices whose primary purchased scope is not an Occu-Med service: a
 * medications / vaccines supply contract (two records), clinical laboratory testing for a hospital and a VA health
 * care system, and a disease-surveillance research study. These tests pin that they are held for review (never
 * auto-accepted, never rejected) and that legitimate occupational-health notices with similar words stay accepted.
 */
import "./support/useFixtureProfile";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { NormalizedOpportunity } from "../../providers/types";
import { classifyProviderRecordRelevance } from "../../providers/providerQueryMatch";
import { decideRelevance } from "../relevanceDecision";
import { REASON_CODES } from "../relevanceReasonCodes";
import { getRelevanceProfile } from "../relevanceProfile";
import { runBenchmark, toRecord, type BenchmarkCase } from "../../releaseC/benchmark/harness";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(
  fs.readFileSync(path.resolve(here, "../../releaseC/benchmark/dataset.json"), "utf8"),
) as { version: string; cases: BenchmarkCase[] };
const byId = new Map(dataset.cases.map((c) => [c.caseId, c]));

function judge(record: NormalizedOpportunity) {
  const relevance = classifyProviderRecordRelevance(record);
  return { relevance, verdict: decideRelevance(relevance).verdict };
}

function samRecord(title: string, description: string, extra: Partial<NormalizedOpportunity> = {}): NormalizedOpportunity {
  return {
    externalId: `test-${title}`,
    title,
    description,
    agency: "DEPT OF DEFENSE",
    type: "Combined Synopsis/Solicitation",
    status: "active",
    source: "samGov",
    sourceUrl: "https://sam.gov/opp/test/view",
    postedDate: new Date(),
    responseDeadline: new Date(Date.now() + 21 * 24 * 3600 * 1000),
    ...extra,
  } as NormalizedOpportunity;
}

const HELD = {
  "prod-b8b5b4b4": "supply_only_scope", // FOH medications, vaccines and medical supplies via ordering portal (Exa copy)
  "prod-5c5b2162": "supply_only_scope", // same MVMS contract, SAM.gov pre-solicitation
  "prod-69bb0a4e": "component_only_scope", // Medical Laboratory Testing Services BPA, 18th Medical Group
  "prod-20d9c3e5": "component_only_scope", // Specialized Medical Laboratory Testing, VA Palo Alto Health Care System
  "prod-d62a22bf": "component_only_scope", // Chagas disease and leishmaniasis surveillance research study
} as const;

describe("remaining benchmark wrong high-confidence matches", () => {
  for (const [caseId, kind] of Object.entries(HELD)) {
    it(`${caseId} is held for review (${kind}), not auto-accepted or rejected`, () => {
      const c = byId.get(caseId);
      assert.ok(c, `${caseId} missing from dataset.json`);
      assert.equal(c.label, "not_relevant");
      const r = judge(toRecord(c));
      assert.equal(r.verdict, "review", `${caseId} -> ${r.verdict}/${r.relevance.confidence}`);
      assert.ok(r.relevance.reasonCodes.includes(REASON_CODES.primaryScopeHold), caseId);
      assert.ok(r.relevance.negativeSignals.includes(`primary scope: ${kind}`), caseId);
      assert.ok(r.relevance.score < getRelevanceProfile().thresholds.acceptMin);
    });
  }

  it("leaves no AI-agreed wrong high-confidence match and loses no relevant case", () => {
    const { report, results } = runBenchmark(dataset.cases, dataset.version, getRelevanceProfile().version);
    assert.deepEqual(report.byProvenance.ai_reference_agreed.wrongHighConfidenceMatches, []);
    for (const r of results.filter((x) => x.label === "relevant")) {
      const relevance = classifyProviderRecordRelevance(toRecord(byId.get(r.caseId)!));
      assert.ok(!relevance.reasonCodes.includes(REASON_CODES.primaryScopeHold), `${r.caseId} downgraded: ${relevance.rejectReason}`);
    }
  });
});

describe("legitimate Occu-Med services are not downgraded", () => {
  const accepted: Array<[string, string]> = [
    ["Employee Immunization Services", "Solicitation for the contractor to administer influenza and hepatitis B vaccines to employees at agency worksites."],
    [
      "Federal Employee Vaccination Clinics",
      "The contractor shall procure vaccines and administer them to federal employees at onsite vaccination clinics, including recordkeeping.",
    ],
    [
      "Occupational Medical Surveillance Exams",
      "Request for proposals for occupational medical surveillance examinations, including laboratory testing and spirometry, for employees exposed to hazardous materials.",
    ],
    [
      "DOT Drug Testing Laboratory Services",
      "Solicitation for DOT drug testing laboratory services for safety-sensitive employees under 49 CFR Part 40, including specimen collection and MRO review.",
    ],
    [
      "Kadena Lab Testing Services BPA",
      "Solicitation for clinical laboratory testing for employees in the occupational health program, including pre-placement and periodic testing.",
    ],
  ];
  for (const [title, description] of accepted) {
    it(`still auto-accepts "${title}"`, () => {
      const r = judge(samRecord(title, description));
      assert.equal(r.verdict, "accept", `${title} -> ${r.verdict}/${r.relevance.confidence}: ${r.relevance.rejectReason}`);
      assert.ok(!r.relevance.reasonCodes.includes(REASON_CODES.primaryScopeHold), title);
    });
  }

  it("holds a lab-testing notice with no employer context, but only for review", () => {
    const r = judge(samRecord("Medical Laboratory Testing Services", "Solicitation for laboratory testing services at the medical center."));
    assert.ok(r.relevance.reasonCodes.includes(REASON_CODES.primaryScopeHold));
    assert.equal(r.verdict, "review");
  });

  it("holds a medications / vaccines supply purchase for review", () => {
    const r = judge(
      samRecord(
        "Occupational Health Medications and Vaccines",
        "Solicitation to procure medications and vaccines for occupational health clinics serving federal employees, ordered through a contractor web portal.",
      ),
    );
    assert.ok(r.relevance.reasonCodes.includes(REASON_CODES.primaryScopeHold));
    assert.equal(r.verdict, "review");
  });
});
