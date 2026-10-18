/**
 * Task 05 (F-05, F-06, F-07, F-10, F-13, F-15, F-22): the live GET /opportunities is the handler in
 * opportunity-safety-boundary.ts (registered first in routes/index.ts). Its visible score, verdict and ranking must
 * agree with the authoritative quality decision; a stored or LLM self-reported score must not produce a green
 * "accept" for unevidenced scope. Uses the real router with only the database transport mocked.
 */
import "../../lib/search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it, mock } from "node:test";
import express from "express";
import { rfpDb } from "@workspace/db";
import { opportunitiesTable } from "@workspace/db/schema";
import router from "../index";
import { calculateOpportunityRank, classifyOpportunityQuality } from "../../lib/opportunityQuality";
import { HARD_NEGATIVES, HARD_POSITIVES, RECOMPETE_SOLICITATION } from "../../lib/search/__tests__/support/opportunityAuditCorpus";

const future = new Date(Date.now() + 30 * 86_400_000);

function row(id: string, title: string, description: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    noticeId: null,
    title,
    agency: "Department of Example",
    type: "Solicitation",
    status: "active",
    description,
    solicitationNumber: `SOL-${id}`,
    samUrl: `https://sam.gov/opp/${id}/view`,
    providerName: "samGov",
    source: "samGov",
    sourceConfidence: "high",
    relevanceScore: "95",
    postedDate: new Date("2026-10-01T00:00:00Z"),
    responseDeadline: future,
    tags: "[]",
    userConfidence: null,
    userGrade: null,
    ...extra,
  };
}

const qa = HARD_NEGATIVES.find((c) => c.id === "neg-construction-qa")!;
const oconus = HARD_POSITIVES.find((c) => c.id === "pos-oconus-clearance")!;
const ROWS = [
  row("qa", qa.title, qa.description),
  row("oconus", oconus.title, oconus.description, { relevanceScore: "60" }),
  row("recompete", RECOMPETE_SOLICITATION.title, RECOMPETE_SOLICITATION.description),
];

function chain(result: unknown[]) {
  const c: any = {};
  for (const method of ["from", "where", "orderBy", "limit", "offset"]) {
    c[method] = (arg?: unknown) => {
      if (method === "from" && arg !== opportunitiesTable) c.__result = [];
      return c;
    };
  }
  c.__result = result;
  c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(c.__result).then(resolve, reject);
  return c;
}

let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;

before(async () => {
  mock.method(rfpDb as any, "select", () => chain(ROWS));
  const app = express();
  app.use((req: any, _res, next) => {
    req.log = { error() {}, warn() {}, info() {} };
    next();
  });
  app.use("/api", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(() => {
  server?.close();
  mock.restoreAll();
});

describe("active GET /opportunities", () => {
  it("is answered by the safety-boundary handler (ranking metadata present)", async () => {
    const res = await fetch(`${base}/opportunities?view=all`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.ranking?.mode, "best-match-v3");
  });

  it("construction QA with stored score 95: capped score, review verdict, never green accept", async () => {
    const body = (await (await fetch(`${base}/opportunities?view=all`)).json()) as any;
    const item = body.data.find((d: any) => d.id === "qa");
    assert.ok(item, "construction QA row retained (view=all)");
    assert.ok(item.relevance.score <= 49, `score ${item.relevance.score}`);
    assert.notEqual(item.relevance.verdict, "accept");
    assert.equal(item.relevance.purchasedScopeEvidenced, false);
    assert.equal(item.quality.classification === "verified-open", false);
    assert.ok(item.crossSource.rankBreakdown.baseRelevanceScore <= 49, "stored 95 cannot lift rank");
  });

  it("construction QA is not in the actionable view; evidenced positive and live recompete are", async () => {
    const body = (await (await fetch(`${base}/opportunities?view=actionable`)).json()) as any;
    const ids = body.data.map((d: any) => d.id).sort();
    assert.deepEqual(ids, ["oconus", "recompete"]);
    const oconusItem = body.data.find((d: any) => d.id === "oconus");
    assert.equal(oconusItem.relevance.verdict, "accept");
  });

  it("disabled purge still returns 410", async () => {
    const res = await fetch(`${base}/opportunities/purge-junk`, { method: "POST", headers: { origin: base } });
    assert.equal(res.status, 410);
    assert.match(((await res.json()) as any).error, /disabled/i);
  });
});

describe("notice stage, trust and ranking rules", () => {
  it("a live re-solicitation that mentions its prior award is not an award", () => {
    const q = classifyOpportunityQuality(row("r", RECOMPETE_SOLICITATION.title, RECOMPETE_SOLICITATION.description));
    assert.equal(q.classification, "verified-open");
  });

  it("an actual award notice is still not bid-ready", () => {
    const q = classifyOpportunityQuality(row("a", "Award Notice: Pre-Employment Physical Examination Services", "Contract awarded to Acme Clinics.", { type: "Award Notice" }));
    assert.equal(q.classification, "award");
  });

  it("a 'forecast' URL slug alone does not change the notice stage", () => {
    const q = classifyOpportunityQuality(row("f", oconus.title, oconus.description, { samUrl: "https://example.gov/forecast-medical/bid/1" }));
    assert.notEqual(q.classification, "forecast");
  });

  it("Tango is trusted only with an official notice URL; otherwise it needs verification", () => {
    const official = classifyOpportunityQuality(row("t1", oconus.title, oconus.description, { providerName: "tango", samUrl: "https://sam.gov/opp/t1/view" }));
    const offsite = classifyOpportunityQuality(row("t2", oconus.title, oconus.description, { providerName: "tango", samUrl: "https://tango.makegov.com/o/1" }));
    assert.equal(official.classification, "verified-open");
    assert.equal(offsite.classification, "needs-verification");
  });

  it("a stored score cannot outrank current evidence when the current decision rejects", () => {
    const junk = row("j", "Janitorial Services Solicitation", "Request for proposal for janitorial services.", { relevanceScore: "99" });
    const rank = calculateOpportunityRank(junk, classifyOpportunityQuality(junk));
    assert.ok(rank.baseRelevanceScore <= 49);
  });
});
