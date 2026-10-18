import "../../search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedOpportunity } from "../../providers/types";
import { classifyOpportunityQuality } from "../../opportunityQuality";
import { normalizedToDbRecord } from "../../search/normalization";
import {
  filterRecordsForManualQuery,
  meaningfulManualQueryTerms,
  recordMatchesManualQuery,
} from "../manualQueryFilter";
import {
  calculateCompletenessScore,
  decideOpportunityQuality,
} from "../opportunityIdentity";

function record(
  title: string,
  overrides: Partial<NormalizedOpportunity> = {},
): NormalizedOpportunity {
  return {
    externalId: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title,
    agency: "State Procurement Office",
    type: "RFP",
    status: "active",
    postedDate: new Date("2026-07-24T00:00:00Z"),
    responseDeadline: new Date("2026-08-24T00:00:00Z"),
    description: "",
    solicitationNumber: "RFP-2026-100",
    sourceUrl: "https://example.gov/opportunities/100",
    source: "publicPortalProviders",
    rawData: { sourceConfidence: "high" },
    ...overrides,
  };
}

describe("manual ingestion query boundary", () => {
  it("removes generic services from the exact production query", () => {
    assert.deepEqual(meaningfulManualQueryTerms("occupational health services"), [
      "occupational",
      "health",
    ]);
  });

  it("does not let Utah-style generic services flood the Occu-Med profile run", () => {
    const relevant = record("Occupational Health Services", {
      description:
        "Pre-employment physical examinations, drug testing, audiograms, and respirator fit testing.",
    });
    const engineering = record("2026 Professional Engineering Services");
    const janitorial = record(
      "DFCM Maintenance - Stage II Janitorial Services - Invitation to Bid",
      { type: "Bid" },
    );
    const legal = record("Legal Services for Opioid Litigation");

    const result = filterRecordsForManualQuery(
      [relevant, engineering, janitorial, legal],
      "occupational health services",
    );

    assert.deepEqual(result.records.map((item) => item.title), [
      "Occupational Health Services",
    ]);
    assert.equal(result.skipped, 3);
  });

  it("uses every meaningful term for a custom manual query", () => {
    const mobileMri = record("Mobile MRI and CT Services", {
      description: "Mobile diagnostic imaging services.",
    });
    assert.equal(recordMatchesManualQuery(mobileMri, "mobile MRI services"), true);
    assert.equal(recordMatchesManualQuery(mobileMri, "mobile dental services"), false);
  });

  it("matches stemmed terms and keeps quoted phrases strict", () => {
    const exams = record("Annual Medical Examinations for Firefighters", {
      description: "Contractor shall perform annual examinations and fitness testing.",
    });
    assert.equal(recordMatchesManualQuery(exams, "firefighter medical examination"), true);
    assert.equal(recordMatchesManualQuery(exams, '"medical examinations for police"'), false);
    assert.equal(recordMatchesManualQuery(exams, '"medical examinations"'), true);
  });

  it("keeps a relevant notice whose wording differs from a service query", () => {
    const differentWording = record("Employee Health Program Support", {
      description: "Pre-employment physical examinations, DOT drug testing, audiograms, and respirator fit testing for county employees.",
    });
    assert.equal(recordMatchesManualQuery(differentWording, "occupational medicine provider statewide"), true);
    const unrelated = record("Fleet Vehicle Maintenance", { description: "Oil changes and tire rotation for county vehicles." });
    assert.equal(recordMatchesManualQuery(unrelated, "occupational medicine provider statewide"), false);
  });

  it("recognizes structured RFP type as procurement evidence", () => {
    const directPortalRecord = record("Occupational Health Program", {
      type: "Request for Proposals (RFP)",
      description:
        "Pre-employment physical examinations and drug testing for employees.",
    });
    assert.equal(decideOpportunityQuality(directPortalRecord).status, "accepted");
  });

  it("uses expanded SAM NAICS/PSC taxonomy as additive relevance evidence, never a whitelist", () => {
    const q533GenericTitle = record("Employee Readiness Support", {
      source: "samGov",
      agency: "DEPARTMENT OF THE AIR FORCE",
      type: "Solicitation",
      description: "",
      naicsCode: "621498",
      pscCode: "Q533",
      sourceUrl: "https://sam.gov/opp/example-q533/view",
      rawData: {
        sourceConfidence: "high",
        providerPlatform: "sam.gov",
        classificationCode: "Q533",
        naicsCode: "621498",
      },
    });

    const newUnlistedCodeButRelevantScope = record("Occupational Health Services", {
      source: "samGov",
      agency: "NEW FEDERAL BUYER",
      type: "Solicitation",
      description: "Pre-employment physical examinations and drug testing for employees.",
      naicsCode: "999999",
      pscCode: "Z999",
      sourceUrl: "https://sam.gov/opp/example-new-code/view",
      rawData: {
        sourceConfidence: "high",
        providerPlatform: "sam.gov",
        classificationCode: "Z999",
        naicsCode: "999999",
      },
    });

    assert.equal(decideOpportunityQuality(q533GenericTitle).status, "accepted");
    assert.equal(decideOpportunityQuality(newUnlistedCodeButRelevantScope).status, "accepted");

    const stored = normalizedToDbRecord(q533GenericTitle);
    assert.equal(stored.naicsCode, "621498");
    assert.equal(stored.pscCode, "Q533");

    const qualityNow = new Date("2026-07-29T12:00:00Z");
    const taxonomyOnlyQuality = classifyOpportunityQuality(
      {
        ...q533GenericTitle,
        providerName: "samGov",
        sourceConfidence: "high",
        samUrl: q533GenericTitle.sourceUrl,
      },
      qualityNow,
    );
    assert.equal(taxonomyOnlyQuality.classification, "needs-verification");
    assert.equal(taxonomyOnlyQuality.actionable, false);

    assert.equal(
      classifyOpportunityQuality(
        {
          ...newUnlistedCodeButRelevantScope,
          providerName: "samGov",
          sourceConfidence: "high",
          samUrl: newUnlistedCodeButRelevantScope.sourceUrl,
        },
        qualityNow,
      ).classification,
      "verified-open",
    );
  });

  it("does not count the epoch sentinel as a real posted date", () => {
    const unknownDate = record("Occupational Health Services", {
      description: "Occupational health examinations and drug testing.",
      postedDate: new Date(0),
    });
    const knownDate = record("Occupational Health Services", {
      description: "Occupational health examinations and drug testing.",
    });
    assert.equal(calculateCompletenessScore(unknownDate), 88);
    assert.equal(calculateCompletenessScore(knownDate), 100);
  });
});
