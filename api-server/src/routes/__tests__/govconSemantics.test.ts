import assert from "node:assert/strict";
import test from "node:test";

process.env.RFP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.INTEL_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const [
  { isGovConSemanticCandidate, safeForecastProviderError },
  { isForwardForecast },
  { forecastSearchHitCurrent },
  { policyFeedDate },
] = await Promise.all([
  import("../govcon"),
  import("../govcon-forecast-ensemble"),
  import("../../lib/intelligence/agencyForecastDiscovery"),
  import("../forecast-policy-boundary"),
]);

const DAY_MS = 86_400_000;

function currentFederalFiscalYear(now: number): number {
  const date = new Date(now);
  return date.getUTCFullYear() + (date.getUTCMonth() >= 9 ? 1 : 0);
}

function candidate(now: number, overrides: Record<string, unknown> = {}) {
  return {
    id: "forecast-1",
    source: "agency",
    sourceId: "1",
    title: "Occupational health services forecast",
    agency: "Department of Example",
    subAgency: null,
    description: "Planned occupational health requirement",
    naics: "621111",
    setAside: null,
    state: null,
    valueRangeText: null,
    valueLow: null,
    valueHigh: null,
    estimatedSolicitationDate: new Date(now + 90 * DAY_MS).toISOString(),
    estimatedAwardFiscalYear: currentFederalFiscalYear(now) + 1,
    estimatedAwardQuarter: "Q2",
    status: "planned",
    isRecompete: false,
    recompeteEvidence: "none",
    incumbentName: null,
    incumbentAward: null,
    pointOfContact: { name: null, email: null, phone: null },
    sourceUrl: "https://example.gov/forecast/1",
    lastUpdatedDate: new Date(now).toISOString(),
    ...overrides,
  } as any;
}

function assertForecastDecision(
  item: ReturnType<typeof candidate>,
  now: number,
  expected: boolean,
): void {
  assert.equal(
    isGovConSemanticCandidate(item, "forecast", now),
    expected,
    "legacy GovCon semantic gate",
  );
  assert.equal(
    isForwardForecast(item, now),
    expected,
    "live forecast ensemble gate",
  );
}

test("forecast mode requires forward-looking forecast semantics", () => {
  const now = Date.now();
  assertForecastDecision(candidate(now), now, true);
  assertForecastDecision(candidate(now, { status: "closed" }), now, false);
});

test("stale forecast dates are rejected even when status says planned", () => {
  const now = Date.now();
  assertForecastDecision(
    candidate(now, {
      estimatedSolicitationDate: new Date(now - 60 * DAY_MS).toISOString(),
      estimatedAwardFiscalYear: null,
      estimatedAwardQuarter: null,
      status: "planned",
    }),
    now,
    false,
  );
});

test("past award fiscal years are rejected when no future timing exists", () => {
  const now = Date.now();
  assertForecastDecision(
    candidate(now, {
      estimatedSolicitationDate: null,
      estimatedAwardFiscalYear: currentFederalFiscalYear(now) - 1,
      estimatedAwardQuarter: "Q4",
      status: "forecast",
    }),
    now,
    false,
  );
});

test("status fallback is used only when timing fields are absent", () => {
  const now = Date.now();
  assertForecastDecision(
    candidate(now, {
      estimatedSolicitationDate: null,
      estimatedAwardFiscalYear: null,
      estimatedAwardQuarter: null,
      status: "anticipated",
    }),
    now,
    true,
  );
});

test("official forecast search rejects stale dated hits", () => {
  const now = Date.UTC(2026, 7, 6, 12, 0, 0);
  assert.equal(
    forecastSearchHitCurrent(
      {
        title: "FY2024 Occupational Health Acquisition Forecast",
        text: "Planned employee medical examination procurement.",
        date: new Date(now - 700 * DAY_MS).toISOString(),
      },
      now,
    ),
    false,
  );
});

test("official forecast search rejects explicitly old forecast years without dates", () => {
  const now = Date.UTC(2026, 7, 6, 12, 0, 0);
  assert.equal(
    forecastSearchHitCurrent(
      {
        title: "FY2024 Acquisition Forecast",
        text: "Occupational health and medical surveillance forecast",
      },
      now,
    ),
    false,
  );
  assert.equal(
    forecastSearchHitCurrent(
      {
        title: "FY2026 Acquisition Forecast",
        text: "Occupational health and medical surveillance forecast",
      },
      now,
    ),
    true,
  );
});

test("policy feed dates degrade malformed values to null", () => {
  assert.equal(policyFeedDate(null), null);
  assert.equal(policyFeedDate("not-a-real-date"), null);
  assert.equal(
    policyFeedDate("Thu, 06 Aug 2026 12:00:00 GMT")?.toISOString(),
    "2026-08-06T12:00:00.000Z",
  );
});

test("normal active solicitations are not automatically recompetes", () => {
  const now = Date.now();
  assert.equal(
    isGovConSemanticCandidate(
      candidate(now, {
        status: "active",
        isRecompete: false,
        recompeteEvidence: "none",
      }),
      "recompete",
      now,
    ),
    false,
  );
});

test("recompete mode requires incumbent or award evidence", () => {
  const now = Date.now();
  assert.equal(
    isGovConSemanticCandidate(
      candidate(now, {
        isRecompete: true,
        recompeteEvidence: "none",
      }),
      "recompete",
      now,
    ),
    false,
  );

  assert.equal(
    isGovConSemanticCandidate(
      candidate(now, {
        isRecompete: true,
        recompeteEvidence: "incumbent-award",
        incumbentName: "Incumbent Corp",
        incumbentAward: {
          recipientName: "Incumbent Corp",
          currentValue: 2_000_000,
          expires: new Date(now + 240 * DAY_MS).toISOString(),
          awardingAgency: "Department of Example",
          latestActionDate: new Date(now - 30 * DAY_MS).toISOString(),
        },
      }),
      "recompete",
      now,
    ),
    true,
  );
});

test("very stale incumbent expirations do not remain recompete candidates", () => {
  const now = Date.now();
  assert.equal(
    isGovConSemanticCandidate(
      candidate(now, {
        estimatedSolicitationDate: null,
        isRecompete: true,
        recompeteEvidence: "incumbent-award",
        incumbentName: "Old Incumbent",
        incumbentAward: {
          recipientName: "Old Incumbent",
          currentValue: 1_000_000,
          expires: new Date(now - 400 * DAY_MS).toISOString(),
          awardingAgency: "Department of Example",
          latestActionDate: null,
        },
      }),
      "recompete",
      now,
    ),
    false,
  );
});


test("partial GovCon and Tango source errors are sanitized without leaking provider responses", () => {
  assert.equal(safeForecastProviderError("GovCon", "GovCon API returned 403: secret=hidden"), "GovCon service returned HTTP 403");
  assert.equal(safeForecastProviderError("Tango", "Tango forecast API 429: key=hidden"), "Tango service returned HTTP 429");
  assert.equal(safeForecastProviderError("GovCon", "GOVCON_API_KEY is not configured"), "GovCon API key is not configured");
  assert.equal(safeForecastProviderError("Tango", "Tango forecast budget is in cooldown"), "Tango provider is in budget cooldown");
  assert.equal(safeForecastProviderError("GovCon", "Unexpected private response"), "GovCon provider request failed");
});
