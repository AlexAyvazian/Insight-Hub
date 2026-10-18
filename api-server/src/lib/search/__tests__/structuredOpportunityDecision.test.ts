import "./support/useFixtureProfile";
import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedOpportunity } from "../../providers/types";
import {
  distinctProviderVotes,
  isDeterministicallyActionable,
  panelResolved,
  structuredReviewCandidateLimit,
  type ReviewVote,
} from "../structuredOpportunityDecision";

const DAY_MS = 24 * 60 * 60 * 1_000;

function record(
  now: number,
  overrides: Partial<NormalizedOpportunity> = {},
): NormalizedOpportunity {
  return {
    externalId: "test-1",
    title: "Occupational Health and Employee Medical Examination Services RFP",
    agency: "Example County",
    type: "Solicitation",
    status: "active",
    postedDate: new Date(now - 30 * DAY_MS),
    responseDeadline: new Date(now + 30 * DAY_MS),
    description:
      "The county requests proposals for pre-employment physical examinations, audiometric testing, spirometry, drug testing, and medical surveillance services for its workforce.",
    sourceUrl: "https://example.gov/procurement/rfp-26-1",
    source: "samGov",
    ...overrides,
  };
}

function vote(
  index: number,
  isOpportunity = true,
  relevanceScore = 90,
): ReviewVote {
  return {
    index,
    isOpportunity,
    relevanceScore,
    reason: "test vote",
  };
}

test("clear active Occu-Med procurements pass without spending AI credits", () => {
  const now = Date.now();
  assert.equal(isDeterministicallyActionable(record(now), now), true);
});

test("unknown or expired deadlines do not bypass review", () => {
  const now = Date.now();
  assert.equal(
    isDeterministicallyActionable(
      record(now, { responseDeadline: undefined }),
      now,
    ),
    false,
  );
  assert.equal(
    isDeterministicallyActionable(
      record(now, { responseDeadline: new Date(now - DAY_MS) }),
      now,
    ),
    false,
  );
});

test("incidental medical wording in unrelated procurements is not actionable", () => {
  const now = Date.now();
  assert.equal(
    isDeterministicallyActionable(
      record(now, {
        title: "Parking Garage Construction Solicitation",
        description:
          "Construct a parking garage. Contractor shall comply with generic employee health and safety requirements.",
      }),
      now,
    ),
    false,
  );
});

test("structured AI review is adaptive by default; the env value is only an optional ceiling", () => {
  const original = process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT;
  try {
    delete process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT;
    assert.equal(structuredReviewCandidateLimit(), null, "no fixed 3/5 ceiling");
    process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT = "99";
    assert.equal(structuredReviewCandidateLimit(), 99, "no hidden maximum of 5");
    process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT = "0";
    assert.equal(structuredReviewCandidateLimit(), 0);
    process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT = "nonsense";
    assert.equal(structuredReviewCandidateLimit(), null);
  } finally {
    if (original === undefined) {
      delete process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT;
    } else {
      process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT = original;
    }
  }
});

test("one judge cannot satisfy a multi-record response by repeating an index", () => {
  assert.deepEqual(
    distinctProviderVotes([vote(0), vote(0), vote(0)], 3).map(
      (entry) => entry.index,
    ),
    [0],
  );
});

test("panel consensus counts distinct providers rather than duplicate rows", () => {
  const duplicateSingleJudge = new Map([
    [
      0,
      [
        { provider: "judge-a", vote: vote(0) },
        { provider: "judge-a", vote: vote(0) },
      ],
    ],
  ]);
  assert.equal(panelResolved(duplicateSingleJudge, 1), false);

  const twoIndependentJudges = new Map([
    [
      0,
      [
        { provider: "judge-a", vote: vote(0) },
        { provider: "judge-b", vote: vote(0) },
      ],
    ],
  ]);
  assert.equal(panelResolved(twoIndependentJudges, 1), true);
});
