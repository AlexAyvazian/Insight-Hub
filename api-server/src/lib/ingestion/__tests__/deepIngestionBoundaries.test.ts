import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedOpportunity } from "../../providers/types";
import {
  partitionProviderRecordsForQuery,
  normalizeProviderPostedDate,
} from "../../providers/providerQueryMatch";
import { fairMergeOpportunityGroups } from "../../providers/fairOpportunityMerge";
import { successfulYieldStatus } from "../../providers/auditedPublicPortalProvider";
import { decideOpportunityQuality } from "../opportunityIdentity";
import type { PublicPortalSource } from "../../providers/publicPortalProviders/catalog";

function opportunity(
  sourceId: string,
  title: string,
  overrides: Partial<NormalizedOpportunity> = {},
): NormalizedOpportunity {
  return {
    externalId: `${sourceId}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title,
    agency: "State Procurement Office",
    type: "RFP",
    status: "active",
    postedDate: new Date("2026-07-24T00:00:00Z"),
    responseDeadline: new Date("2026-08-24T00:00:00Z"),
    description: "",
    solicitationNumber: `RFP-${sourceId}-100`,
    sourceUrl: `https://example.gov/${sourceId}/100`,
    source: "publicPortalProviders",
    providerName: "publicPortalProviders",
    rawData: { sourceId, sourceConfidence: "high" },
    ...overrides,
  };
}

function source(id: string): PublicPortalSource {
  return {
    id,
    agencyName: "State Procurement Office",
    agencyType: "state",
    state: "UT",
    sourceUrl: "https://example.gov/opportunities",
    searchUrl: "https://example.gov/opportunities",
    domain: "example.gov",
    portalPlatform: "Test",
    sourceLevel: "state",
    level: "state",
    accessMode: "public_html",
    scraperType: "existing_parser",
    enabled: true,
    verificationStatus: "verified",
  };
}

describe("deep manual-ingestion boundaries", () => {
  it("prevents a 47-row services source from monopolizing a three-source result page", () => {
    const utah = Array.from({ length: 47 }, (_, index) =>
      opportunity("ut-purchasing", `Professional Engineering Services ${index}`),
    );
    const alaska = [
      opportunity("ak-iris-vss", "Occupational Health Services for Employees", {
        description: "Pre-employment physical examinations and drug testing.",
      }),
    ];
    const newYork = [
      opportunity("ny-contract-reporter", "Employee Medical Surveillance RFP", {
        description: "Occupational health examinations, audiograms, and spirometry.",
      }),
    ];

    const merged = fairMergeOpportunityGroups(
      [
        { sourceId: "ut-purchasing", records: utah },
        { sourceId: "ak-iris-vss", records: alaska },
        { sourceId: "ny-contract-reporter", records: newYork },
      ],
      3,
    );

    assert.deepEqual(
      merged.map((record) => record.rawData?.sourceId),
      ["ak-iris-vss", "ny-contract-reporter", "ut-purchasing"],
    );
  });

  it("admits relevant rows first and defers every mismatch instead of dropping it", () => {
    const records = [
      opportunity("ut-purchasing", "Professional Engineering Services"),
      opportunity("ut-purchasing", "Janitorial Services Invitation to Bid"),
      opportunity("ut-purchasing", "Legal Services for Litigation"),
      opportunity("ut-purchasing", "Occupational Health Services", {
        description: "Drug testing, physical examinations, and audiograms.",
      }),
    ];

    const partition = partitionProviderRecordsForQuery(
      records,
      "occupational health services",
      2,
    );

    assert.equal(partition.rawCount, 4);
    assert.equal(partition.matchedCount, 1);
    assert.equal(partition.rejectedCount, 3);
    assert.equal(partition.rejectedSamples.length, 2);
    assert.equal(partition.matched[0]?.title, "Occupational Health Services");
    assert.ok(
      partition.rejectedSamples.every(
        (record) => record.rawData?.manualQueryMismatch === true,
      ),
    );
    // Every non-match is kept (deferred), not just the bounded sample; none is promoted on missing keywords.
    assert.equal(partition.deferred.length, 3);
    assert.ok(
      partition.deferred.every((record) => record.rawData?.queryMatchDeferred === true),
    );
    assert.ok(
      partition.deferred.every(
        (record) => decideOpportunityQuality(record).status !== "accepted",
      ),
    );
  });

  it("scores health from relevant yield rather than raw junk volume", () => {
    const status = successfulYieldStatus(
      source("ut-purchasing"),
      undefined,
      new Date("2026-07-24T00:00:00Z"),
      47,
      0,
    );

    assert.equal(status.resultCount, 47);
    assert.equal(status.matchedCount, 0);
    assert.equal(status.lastOutcome, "no_results");
    assert.equal(status.consecutiveNoResultSuccesses, 1);
  });

  it("converts the 1970 sentinel to null and blocks canonical promotion", () => {
    const normalized = normalizeProviderPostedDate(
      opportunity("ut-purchasing", "Occupational Health Services", {
        postedDate: new Date(0),
        description: "Occupational health examinations and drug testing.",
        rawData: {
          sourceId: "ut-purchasing",
          sourceConfidence: "high",
          dateUnknown: true,
        },
      }),
    );

    assert.equal(normalized.postedDate, null);
    assert.notEqual(decideOpportunityQuality(normalized).status, "accepted");
  });

  it("uses structured RFP evidence for a complete direct record", () => {
    const result = decideOpportunityQuality(
      opportunity("ak-iris-vss", "Occupational Health Program", {
        type: "Request for Proposals (RFP)",
        description: "Pre-employment physical examinations and drug testing.",
      }),
    );
    assert.equal(result.status, "accepted");
  });
});
