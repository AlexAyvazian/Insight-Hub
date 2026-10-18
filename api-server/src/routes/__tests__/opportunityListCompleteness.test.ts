/**
 * Task 06 (F-09, F-14, F-16, F-22): the live list used to rank only the first 10,000 rows (by stale stored score),
 * loading full descriptions for all of them. It now scans every matching row in batches with a light projection,
 * reports a safety ceiling explicitly, dedupes on one normalized identity that ignores placeholder solicitation
 * numbers, and keeps provenance. Real router; only the database transport is mocked.
 */
import "../../lib/search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it, mock } from "node:test";
import express from "express";
import { rfpDb } from "@workspace/db";
import { opportunitiesTable } from "@workspace/db/schema";
import router from "../index";
import { shouldShowOpportunity } from "../opportunities";
import { canonicalOpportunityKey, normalizedAgencyKey, normalizedSolicitationNumber } from "../../lib/opportunityQuality";

const future = new Date(Date.now() + 30 * 86_400_000);
const EXAM = "Request for proposal for pre-employment physical examinations, audiometric testing and DOT drug testing for county employees.";

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, noticeId: null, title: `Janitorial Services Solicitation ${id}`, agency: "City of Example", type: "Solicitation",
    status: "active", description: "Request for proposal for janitorial services.", solicitationNumber: `SOL-${id}`,
    samUrl: `https://example.gov/bids/${id}`, providerName: "publicPortalProviders", source: "publicPortalProviders",
    sourceConfidence: "high", relevanceScore: "20", postedDate: new Date("2026-10-01T00:00:00Z"), responseDeadline: future,
    tags: "[]", userConfidence: null, userGrade: null, ...extra,
  };
}

let dataset: Record<string, unknown>[] = [];
const selectCalls: number[] = [];

function chain() {
  const state: { table?: unknown; limit?: number; offset: number } = { offset: 0 };
  const c: any = {
    from(table: unknown) { state.table = table; return c; },
    where() { return c; },
    orderBy() { return c; },
    limit(n: number) { state.limit = n; return c; },
    offset(n: number) { state.offset = n; return c; },
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      let result: unknown[] = [];
      if (state.table === opportunitiesTable) {
        // Scan batches use limit/offset; the page fetch (by id) has no limit and the route picks its ids.
        result = state.limit === undefined ? dataset : dataset.slice(state.offset, state.offset + state.limit);
        if (state.limit !== undefined) selectCalls.push(result.length);
      }
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return c;
}

let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
before(async () => {
  mock.method(rfpDb as any, "select", () => chain());
  const app = express();
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {} }; next(); });
  app.use("/api", router);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(() => { server?.close(); mock.restoreAll(); delete process.env.OPPORTUNITY_LIST_MAX_SCAN_ROWS; });

describe("complete, bounded listing", () => {
  it("a relevant record beyond the old 10,000-row cap is ranked and returned", async () => {
    dataset = Array.from({ length: 12_000 }, (_, i) => row(`row-${i}`));
    dataset[11_500] = row("target", { title: "Pre-Employment Physical Examination Services RFP", description: EXAM, providerName: "samGov", samUrl: "https://sam.gov/opp/target/view" });
    const body = (await (await fetch(`${base}/opportunities?view=all&limit=5`)).json()) as any;
    assert.equal(body.ranking.truncated, false);
    assert.equal(body.ranking.totalBasis, "exact");
    assert.equal(body.ranking.candidateCount, 12_000);
    assert.equal(body.total, 12_000);
    assert.equal(body.data[0].id, "target");
    assert.ok(body.data[0].description.length > 0, "page rows carry the full record");
  });

  it("the safety ceiling is reported, never silent", async () => {
    process.env.OPPORTUNITY_LIST_MAX_SCAN_ROWS = "2000";
    try {
      dataset = Array.from({ length: 2_500 }, (_, i) => row(`row-${i}`));
      const body = (await (await fetch(`${base}/opportunities?view=all&limit=5`)).json()) as any;
      assert.equal(body.ranking.truncated, true);
      assert.equal(body.ranking.totalBasis, "partial");
      assert.equal(body.ranking.candidateCount, 2_000);
    } finally {
      delete process.env.OPPORTUNITY_LIST_MAX_SCAN_ROWS;
    }
  });

  it("scans in bounded batches (no single 10k-row load)", async () => {
    dataset = Array.from({ length: 3_500 }, (_, i) => row(`row-${i}`));
    selectCalls.length = 0;
    await fetch(`${base}/opportunities?view=all&limit=5`);
    assert.ok(Math.max(...selectCalls) <= 1_000, `largest batch ${Math.max(...selectCalls)}`);
  });

  it("equivalent agency names merge one notice and keep both sources; placeholders never merge", async () => {
    dataset = [
      row("dup-a", { title: "Pre-Employment Physical Examination Services RFP", description: EXAM, agency: "VETERANS AFFAIRS, DEPARTMENT OF", solicitationNumber: "36C262-26-R-0001", providerName: "samGov", samUrl: "https://sam.gov/opp/a/view" }),
      row("dup-b", { title: "Pre-Employment Physical Examination Services RFP", description: EXAM, agency: "Department of Veterans Affairs", solicitationNumber: "36C26226R0001", providerName: "tango", samUrl: "https://sam.gov/opp/a/view" }),
      row("ph-1", { solicitationNumber: "N/A", samUrl: "https://example.gov/bids/ph1" }),
      row("ph-2", { solicitationNumber: "N/A", samUrl: "https://example.gov/bids/ph2" }),
    ];
    const body = (await (await fetch(`${base}/opportunities?view=all`)).json()) as any;
    assert.equal(body.total, 3);
    const merged = body.data.find((d: any) => d.id === "dup-a");
    assert.ok(merged, "official source owns the canonical row");
    assert.deepEqual([...merged.crossSource.sources].sort(), ["samGov", "tango"]);
  });
});

describe("canonical identity helpers", () => {
  it("normalizes solicitation numbers and rejects placeholders", () => {
    assert.equal(normalizedSolicitationNumber("36C262-26-R-0001"), normalizedSolicitationNumber("36C26226R0001"));
    for (const p of ["N/A", "TBD", "RFP", "none", "0000", "--", "x"]) assert.equal(normalizedSolicitationNumber(p), null, p);
  });

  it("normalizes agency aliases", () => {
    assert.equal(normalizedAgencyKey("VETERANS AFFAIRS, DEPARTMENT OF"), normalizedAgencyKey("Department of Veterans Affairs"));
    assert.notEqual(normalizedAgencyKey("Department of the Army"), normalizedAgencyKey("Department of the Navy"));
  });

  it("placeholder ids fall back to the notice URL", () => {
    assert.notEqual(
      canonicalOpportunityKey({ solicitationNumber: "TBD", agency: "City", samUrl: "https://example.gov/a" }),
      canonicalOpportunityKey({ solicitationNumber: "TBD", agency: "City", samUrl: "https://example.gov/b" }),
    );
  });
});

describe("stale-year handling", () => {
  it("an old year mentioned in the description does not hide a current notice", () => {
    assert.equal(shouldShowOpportunity({
      title: "Pre-Employment Physical Examination Services RFP",
      description: `${EXAM} The prior contract was awarded in 2021.`,
      responseDeadline: future,
    }), true);
  });

  it("an old-year-only notice identity without a future deadline is still hidden", () => {
    assert.equal(shouldShowOpportunity({
      title: "2019 Pre-Employment Physical Examination Services RFP",
      description: EXAM,
      solicitationNumber: "RFP-2019-04",
    }), false);
  });
});
