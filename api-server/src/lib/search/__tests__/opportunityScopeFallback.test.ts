/**
 * Task 02 (F-04, F-23): the broad medical-title fallback was unreachable (every profile title signal is a single
 * word, but the fallback only kept multi-word >= 10-character terms). A broad title word plus an explicit service
 * phrase in the description now evidences purchased scope; a broad title word alone never does, and records
 * without evidence stay in review instead of disappearing.
 */
import { fixtureProfile } from "./support/useFixtureProfile";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyOpportunityQuality } from "../../opportunityQuality";
import { hasPrimaryOccuMedServiceEvidence, primaryOccuMedServiceEvidence } from "../../opportunityScopeEvidence";
import { HARD_NEGATIVES, HARD_POSITIVES, VAGUE_TITLE_POSITIVE } from "./support/opportunityAuditCorpus";

const profile = fixtureProfile();
const EXPLICIT_DESCRIPTION = "The contractor shall provide pre-employment physical examinations and DOT drug and alcohol testing services under this solicitation.";

function verifiedRow(title: string, description: string) {
  return {
    title,
    description,
    agency: "Department of Example",
    type: "Solicitation",
    status: "active",
    providerName: "samGov",
    sourceConfidence: "high",
    samUrl: "https://sam.gov/opp/abc123/view",
    postedDate: new Date("2026-10-01T00:00:00Z"),
    responseDeadline: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  };
}

describe("medical-title fallback semantics", () => {
  it("the fixture profile's broad title signals are single words (the reason the old filter was dead)", () => {
    assert.ok(profile.titleMedical.length >= 19);
  });

  for (const signal of profile.titleMedical) {
    it(`title signal "${signal}": alone is not evidence; with an explicit description phrase it is`, () => {
      const title = `${signal} support`;
      assert.equal(hasPrimaryOccuMedServiceEvidence(title, "Scope of work to be defined.", profile), false);
      const withPhrase = primaryOccuMedServiceEvidence(title, EXPLICIT_DESCRIPTION, profile);
      // A title that itself names a specific service phrase is evidenced by path 1, which is also correct.
      assert.equal(withPhrase.evidenced, true, `${signal}: ${withPhrase.path}`);
    });
  }

  it("signals match whole tokens only: division / physically / revision do not count", () => {
    for (const title of ["Division of Facilities", "Physically Secure Storage", "Revision of Manuals"]) {
      assert.equal(hasPrimaryOccuMedServiceEvidence(title, EXPLICIT_DESCRIPTION, profile), false, title);
    }
  });

  it("plurals fold symmetrically (Physicals, Evaluations)", () => {
    assert.equal(hasPrimaryOccuMedServiceEvidence("Respirator Medical Evaluations and Fit Testing", "", profile), true);
    assert.equal(hasPrimaryOccuMedServiceEvidence("Annual Firefighter Physicals", "NFPA 1582 firefighter physical examinations for personnel.", profile), true);
  });

  it("diagnostics carry the profile source, version and deciding terms", () => {
    const e = primaryOccuMedServiceEvidence("Medical Clearance Examinations - OCONUS", HARD_POSITIVES[0]!.description, profile);
    assert.equal(e.path, "title-signal-and-description-explicit");
    assert.equal(e.profileVersion, profile.version);
    assert.ok(e.terms.length >= 2);
  });
});

describe("hard positives and negatives", () => {
  for (const c of HARD_POSITIVES) {
    it(`${c.id}: purchased scope is evidenced`, () => {
      assert.equal(hasPrimaryOccuMedServiceEvidence(c.title, c.description, profile), true);
    });
  }

  for (const c of HARD_NEGATIVES) {
    it(`${c.id}: no purchased-scope evidence`, () => {
      assert.equal(hasPrimaryOccuMedServiceEvidence(c.title, c.description, profile), false);
    });
  }

  it("vague title with strong description is retained for review, not verified and not dropped", () => {
    const q = classifyOpportunityQuality(verifiedRow(VAGUE_TITLE_POSITIVE.title, VAGUE_TITLE_POSITIVE.description));
    assert.equal(q.classification, "needs-verification");
    assert.ok(q.relevanceScore <= 49);
  });

  it("evidenced positive with authentic source, buyer and future deadline can be verified-open", () => {
    const c = HARD_POSITIVES.find((x) => x.id === "pos-oconus-clearance")!;
    assert.equal(classifyOpportunityQuality(verifiedRow(c.title, c.description)).classification, "verified-open");
  });

  it("evidenced positive without a deadline is not verified (review stays available)", () => {
    const c = HARD_POSITIVES.find((x) => x.id === "pos-oconus-clearance")!;
    const q = classifyOpportunityQuality({ ...verifiedRow(c.title, c.description), responseDeadline: null });
    assert.equal(q.classification, "needs-verification");
  });

  for (const [title, description] of [
    ["Physical Plant Maintenance", "Request for proposal for physical plant HVAC maintenance and employee occupational health services signage."],
    ["Medical Staffing Services", "Request for proposal for medical staffing: nurse staffing for occupational health services clinic."],
    ["Occupational Therapy Staffing", "Request for proposal for occupational therapy staffing and clinical staffing."],
    ["Healthcare IT Electronic Health Record", "Request for proposal for electronic health record implementation for occupational health services."],
  ] as const) {
    it(`edge case "${title}" is never verified-open`, () => {
      assert.notEqual(classifyOpportunityQuality(verifiedRow(title, description)).classification, "verified-open");
    });
  }
});
