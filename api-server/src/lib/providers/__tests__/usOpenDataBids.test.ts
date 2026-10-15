import "../../search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import test from "node:test";

process.env.RFP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.INTEL_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.AUTH_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.APP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const { fetchLaRamp, fetchNycCityRecord, laRampToOpportunity, montgomeryToOpportunity, nycNoticeToOpportunity } =
  await import("../usOpenDataBids");
const { profileLeadQueries } = await import("../profileQueryTerms");

const FUTURE = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 23);
const PAST = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 23);

function service(): string {
  const lead = profileLeadQueries(1)[0];
  assert.ok(lead, "fixture profile must carry a lead service query");
  return `Provision of ${lead} services`;
}

const nyc = (o: Record<string, unknown> = {}) => ({
  request_id: "20260923037",
  start_date: "2026-09-30T00:00:00.000",
  agency_name: "City University",
  type_of_notice_description: "Solicitation",
  category_description: "Services (other than human services)",
  short_title: service(),
  selection_method_description: "Request for Proposals",
  section_name: "Procurement",
  pin: "LAG-06908272026",
  due_date: FUTURE,
  email: "pricequote@example.edu",
  additional_description_1: `<p>Seeking proposals for ${service()}.</p>`,
  ...o,
});

test("an open relevant NYC solicitation maps with its City Record link and contact", () => {
  const record = nycNoticeToOpportunity(nyc());
  assert.ok(record);
  assert.equal(record.sourceUrl, "https://a856-cityrecord.nyc.gov/RequestDetail/20260923037");
  assert.equal(record.agency, "City University");
  assert.equal(record.solicitationNumber, "LAG-06908272026");
  assert.equal(record.rawData?.contactEmail, "pricequote@example.edu");
  assert.equal(record.rawData?.internationalSource, "nycCityRecord");
  assert.ok(!record.description?.includes("<p>"));
});

test("NYC awards, expired and irrelevant notices are dropped", () => {
  assert.equal(nycNoticeToOpportunity(nyc({ type_of_notice_description: "Award" })), null);
  assert.equal(nycNoticeToOpportunity(nyc({ due_date: PAST })), null);
  assert.equal(
    nycNoticeToOpportunity(nyc({ short_title: "Xerox printer rental", additional_description_1: "Printers" })),
    null,
  );
});

const ramp = (o: Record<string, unknown> = {}) => ({
  rampid: "229205",
  title: service(),
  stagename: "Open",
  category: "Services",
  type: "RFB - Request For Bid",
  bidpost: "2026-10-01T10:00:00.000",
  closedate: FUTURE,
  department: "General Services",
  url: { url: "https://www.rampla.org/s/opportunity-details?id=006abc" },
  ...o,
});

test("LA RAMP rows map with the nested bid link; cancelled, closed, undated and practice rows are dropped", () => {
  const record = laRampToOpportunity(ramp());
  assert.ok(record);
  assert.equal(record.sourceUrl, "https://www.rampla.org/s/opportunity-details?id=006abc");
  assert.equal(record.agency, "General Services");
  assert.equal(laRampToOpportunity(ramp({ title: `*CANCELLED* ${service()}` })), null);
  assert.equal(laRampToOpportunity(ramp({ stagename: "Closed" })), null);
  assert.equal(laRampToOpportunity(ramp({ closedate: undefined })), null);
  assert.equal(laRampToOpportunity(ramp({ closedate: "2037-06-30T20:00:00.000" })), null);
  assert.equal(laRampToOpportunity(ramp({ closedate: PAST })), null);
});

const mc = (o: Record<string, unknown> = {}) => ({
  number: "1203258",
  status: "Active",
  type: "Informal",
  description: service(),
  issuancedate: "2026-10-15T00:00:00.000",
  closingdate: FUTURE,
  department: "Department of Correction & Rehabilitation",
  deptcontact: "Rita Ellis",
  ...o,
});

test("Montgomery County rows map with a unique per-bid link; inactive and expired rows are dropped", () => {
  const record = montgomeryToOpportunity(mc());
  assert.ok(record);
  assert.equal(record.sourceUrl, "https://data.montgomerycountymd.gov/d/eeq6-nnwe?number=1203258");
  assert.equal(record.rawData?.sourceConfidence, "medium");
  assert.equal(montgomeryToOpportunity(mc({ status: "Closed" })), null);
  assert.equal(montgomeryToOpportunity(mc({ closingdate: PAST })), null);
  assert.equal(montgomeryToOpportunity(mc({ description: "Custom cardboard boxes" })), null);
});

test("fetchers query SODA with open-bid filters and the optional app token", async () => {
  const realFetch = globalThis.fetch;
  const realToken = process.env.SOCRATA_APP_TOKEN;
  process.env.SOCRATA_APP_TOKEN = "test-token";
  const calls: Array<{ url: string; token?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), token: (init?.headers as Record<string, string> | undefined)?.["X-App-Token"] });
    const body = String(input).includes("dg92-zbpx") ? [nyc(), nyc({ request_id: "x2", short_title: "Printer rental", additional_description_1: "Printers" })] : [ramp()];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const nycResult = await fetchNycCityRecord({});
    const laResult = await fetchLaRamp({});
    assert.equal(nycResult.records.length, 1);
    assert.equal(nycResult.diagnostics?.candidates, 2);
    assert.equal(laResult.records.length, 1);
    assert.ok(decodeURIComponent(calls[0]!.url.replace(/\+/g, " ")).includes("section_name='Procurement'"));
    assert.ok(decodeURIComponent(calls[1]!.url.replace(/\+/g, " ")).includes("closedate > '"));
    assert.ok(calls.every((call) => call.token === "test-token"));
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.SOCRATA_APP_TOKEN;
    else process.env.SOCRATA_APP_TOKEN = realToken;
  }
});

test("a SODA error is thrown so the provider can report that source as failed", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("throttled", { status: 429 })) as typeof fetch;
  try {
    await assert.rejects(() => fetchLaRamp({}), /Socrata SODA 429/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
