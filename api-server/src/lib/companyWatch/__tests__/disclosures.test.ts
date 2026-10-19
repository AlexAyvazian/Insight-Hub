import assert from "node:assert/strict";
import test from "node:test";
import { legalName, matchIssuers, parseFecCommittees, parseFecTotals, parseIssuers, parseSecFilings } from "../disclosures";
import { validateDisclosureSettings } from "../../../routes/company-disclosures";
import { expensiveRoutePolicy, writeCapability } from "../../../middleware/api-hardening";
import express from "express";
import disclosureRouter from "../../../routes/company-disclosures";

const issuers = parseIssuers({ 0: { cik_str: 1336920, ticker: "LDOS", title: "Leidos Holdings, Inc." },
  1: { cik_str: 1601548, ticker: "VVX", title: "V2X, Inc." }, 2: { cik_str: 40533, ticker: "GD", title: "GENERAL DYNAMICS CORP" } });

test("SEC identity uses exact legal names and documented aliases, never inferred parent-company filings", () => {
  assert.equal(matchIssuers("Leidos", issuers)[0]?.cik, "0001336920");
  assert.equal(matchIssuers("Vectrus", issuers)[0]?.ticker, "VVX");
  assert.deepEqual(matchIssuers("General Dynamics Information Technology", issuers), []);
  assert.deepEqual(matchIssuers("Lei", issuers), []);
  assert.equal(legalName("CACI INTERNATIONAL INC /DE/"), "caci international");
  assert.throws(() => parseIssuers({ invalid: {} }), /invalid issuer/);
});

test("ambiguous issuer names stay ambiguous instead of silently taking the first match", () => {
  const matches = matchIssuers("Leidos", [...issuers, { cik: "0000000123", name: "Leidos Inc", ticker: "OTHER" }]);
  assert.equal(matches.length, 2);
});

test("SEC filing links use verified CIK and accession metadata; incorrect issuers are rejected", () => {
  const issuer = issuers[0]!;
  const data = { cik: "0001336920", name: "Leidos Holdings, Inc.", filings: { recent: {
    form: ["4", "8-K", "10-Q"], accessionNumber: ["0001336920-26-000001", "0001336920-26-000002", "0001336920-26-000003"],
    filingDate: ["2026-10-19", "2026-10-18", "2026-09-01"], primaryDocument: ["ownership.xml", "current-report.htm", "../unsafe.htm"],
    items: ["", "1.01", ""], reportDate: ["", "2026-10-17", "2026-06-30"],
  } } };
  const result = parseSecFilings(data, issuer);
  assert.equal(result.filings.length, 2);
  assert.equal(result.filings[0]?.url, "https://www.sec.gov/Archives/edgar/data/1336920/000133692026000002/current-report.htm");
  assert.equal(result.filings[0]?.items, "1.01");
  assert.match(result.filings[1]!.url, /-index\.html$/);
  assert.throws(() => parseSecFilings({ ...data, cik: "123" }, issuer), /identity/);
  assert.throws(() => parseSecFilings({ ...data, name: "Unrelated Company" }, issuer), /identity/);
  assert.throws(() => parseSecFilings({ cik: issuer.cik, name: issuer.name }, issuer), /metadata/);
});

test("FEC corporate affiliation requires the official organization field; a name-only candidate stays unconfirmed", () => {
  const committees = parseFecCommittees({ results: [
    { committee_id: "C00546234", name: "LEIDOS INC. POLITICAL ACTION COMMITTEE", affiliated_committee_name: "LEIDOS, INC.", committee_type_full: "Qualified - Non-party" },
    { committee_id: "C00000001", name: "LEIDOS PAC" },
    { committee_id: "C00000002", name: "FRIENDS OF LEIDOS PAC" },
    { committee_id: "C00000003", name: "LEIDOS EXTRA PAC", affiliated_committee_name: "LEIDOS EXTRA INC" },
  ] }, "Leidos");
  assert.equal(committees.length, 2);
  assert.equal(committees[0]?.match, "documented_affiliation");
  assert.equal(committees[1]?.match, "name_only");
  assert.equal(committees[0]?.url, "https://www.fec.gov/data/committee/C00546234/");
  assert.deepEqual(parseFecCommittees({ results: [] }, "Leidos"), []);
  assert.throws(() => parseFecCommittees({}, "Leidos"), /invalid committee/);
});

test("FEC financial summaries preserve reporting coverage and unknown values; missing money is never invented as zero", () => {
  const totals = parseFecTotals({ results: [
    { cycle: 2024, receipts: 0, disbursements: null, coverage_start_date: "2023-01-01T00:00:00", coverage_end_date: "2024-12-31T00:00:00" },
    { cycle: 2026, receipts: 1461734.69, disbursements: 1489316, last_cash_on_hand_end_period: 945828.25, coverage_end_date: "2026-08-31T00:00:00" },
  ] });
  assert.equal(totals[0]?.cycle, 2026);
  assert.equal(totals[0]?.cashOnHand, 945828.25);
  assert.equal(totals[0]?.coverageEnd, "2026-08-31T00:00:00");
  assert.equal(totals[1]?.receipts, 0);
  assert.equal(totals[1]?.disbursements, null);
  assert.equal(totals[1]?.cashOnHand, null);
  assert.throws(() => parseFecTotals({}), /invalid financial/);
});

test("source configuration validates headers and inherits the existing admin boundary", () => {
  assert.deepEqual(validateDisclosureSettings({ fecApiKey: "fake-test-key-123", secUserAgent: "Example Company contact@example.com" }), { fecApiKey: "fake-test-key-123", secUserAgent: "Example Company contact@example.com" });
  assert.throws(() => validateDisclosureSettings({ secUserAgent: "Example\r\nInjected: value" }));
  assert.throws(() => validateDisclosureSettings({ fecApiKey: "bad" }));
  assert.equal(writeCapability({ method: "PUT", path: "/settings/company-watch-sources" }), "admin_write");
  assert.equal(expensiveRoutePolicy({ method: "GET", path: "/company-watch/disclosures" })?.limit, 60);
});

test("source failures stay explicit and do not leak credentials or become zero-result successes", async t => {
  const savedKey = process.env.FEC_API_KEY;
  const savedAgent = process.env.SEC_USER_AGENT;
  process.env.FEC_API_KEY = "fake-test-key-123";
  process.env.SEC_USER_AGENT = "Example Company contact@example.com";
  t.after(() => {
    if (savedKey === undefined) delete process.env.FEC_API_KEY; else process.env.FEC_API_KEY = savedKey;
    if (savedAgent === undefined) delete process.env.SEC_USER_AGENT; else process.env.SEC_USER_AGENT = savedAgent;
  });
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.hostname);
    if (url.hostname === "www.sec.gov") assert.equal((init.headers as Record<string, string>)["User-Agent"], "Example Company contact@example.com");
    if (url.hostname === "api.open.fec.gov") assert.equal(url.searchParams.get("api_key"), "fake-test-key-123");
    return new Response("private provider error body fake-test-key-123", { status: 401 });
  });
  const app = express();
  app.use("/api", disclosureRouter);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await realFetch(`http://127.0.0.1:${address.port}/api/company-watch/disclosures?company=Leidos`);
  const body = await response.text();
  const result = JSON.parse(body);
  assert.equal(result.sec.status, "error");
  assert.equal(result.fec.status, "error");
  assert.match(result.sec.message, /HTTP 401/);
  assert.ok(calls.includes("www.sec.gov") && calls.includes("api.open.fec.gov"));
  assert.ok(!body.includes("fake-test-key-123") && !body.includes("private provider error body"));
  assert.equal(result.fec.committees, undefined);
});
