import "../../search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import test from "node:test";

process.env.RFP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.INTEL_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.AUTH_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.APP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const {
  buildWorldBankQueries,
  fetchFindATender,
  fetchWorldBank,
  ocdsNextCursor,
  ocdsReleaseToOpportunity,
  worldBankNoticeToOpportunity,
} = await import("../openGovernmentTenderApis");
const { profileLeadQueries } = await import("../profileQueryTerms");

const FUTURE = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

function serviceTitle(): string {
  const lead = profileLeadQueries(1)[0];
  assert.ok(lead, "fixture profile must carry a lead service query");
  return `Provision of ${lead} services`;
}

function release(overrides: Record<string, unknown> = {}) {
  return {
    ocid: "ocds-h6vhtk-0abcde",
    id: "012345-2026",
    date: "2026-10-12T09:00:00Z",
    tag: ["tender"],
    buyer: { name: "NHS Example Trust" },
    tender: {
      title: serviceTitle(),
      description: `${serviceTitle()} for NHS staff.`,
      status: "active",
      value: { amount: 250000, currency: "GBP" },
      tenderPeriod: { endDate: FUTURE },
    },
    ...overrides,
  };
}

test("an open relevant UK tender maps to a normalized opportunity", () => {
  const record = ocdsReleaseToOpportunity(release(), "findATender");
  assert.ok(record);
  assert.equal(record.agency, "NHS Example Trust");
  assert.equal(record.sourceUrl, "https://www.find-tender.service.gov.uk/Notice/012345-2026");
  assert.equal(record.estimatedValue, 250000);
  assert.equal(record.providerName, "internationalPublicPortals");
  assert.equal(record.rawData?.internationalSource, "findATender");
  assert.equal(record.responseDeadline?.toISOString(), FUTURE);
});

test("Contracts Finder notices use the notice GUID for their link", () => {
  const record = ocdsReleaseToOpportunity(
    release({ id: "0a1b2c3d-1111-2222-3333-444455556666-1" }),
    "contractsFinder",
  );
  assert.ok(record);
  assert.equal(
    record.sourceUrl,
    "https://www.contractsfinder.service.gov.uk/Notice/0a1b2c3d-1111-2222-3333-444455556666",
  );
});

test("expired, awarded, cancelled and irrelevant UK notices are dropped", () => {
  const base = release() as { tender: Record<string, unknown> };
  assert.equal(
    ocdsReleaseToOpportunity(release({ tender: { ...base.tender, tenderPeriod: { endDate: PAST } } }), "findATender"),
    null,
    "expired",
  );
  assert.equal(ocdsReleaseToOpportunity(release({ tag: ["award"] }), "findATender"), null, "award");
  assert.equal(
    ocdsReleaseToOpportunity(release({ tender: { ...base.tender, status: "cancelled" } }), "findATender"),
    null,
    "cancelled",
  );
  assert.equal(
    ocdsReleaseToOpportunity(
      release({ tender: { title: "Supply of office furniture", description: "Desks and chairs", status: "active" } }),
      "findATender",
    ),
    null,
    "irrelevant",
  );
});

test("OCDS next cursor is read from links.next as a token or a URL", () => {
  assert.equal(ocdsNextCursor({ links: { next: "abc123==" } }), "abc123==");
  assert.equal(
    ocdsNextCursor({ links: { next: "https://example.test/api?limit=100&cursor=Zm9vYg%3D%3D" } }),
    "Zm9vYg==",
  );
  assert.equal(ocdsNextCursor({}), undefined);
});

test("Find a Tender pages with the cursor and keeps only relevant open tenders", async () => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const first = !url.includes("cursor=");
    const body = first
      ? {
          releases: [release(), release({ id: "999999-2026", tender: { title: "Supply of vehicles", status: "active" } })],
          links: { next: "PAGE2==" },
        }
      : { releases: [release({ id: "012346-2026" })] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await fetchFindATender({ dateRange: 7 });
    assert.equal(result.records.length, 2);
    assert.equal(urls.length, 2);
    assert.ok(urls[0]!.includes("stages=tender") && urls[0]!.includes("updatedFrom="));
    assert.ok(urls[1]!.includes("cursor=PAGE2%3D%3D"));
    assert.equal(result.diagnostics?.candidates, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failing UK API reports the error and keeps earlier pages", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ releases: [release()], links: { next: "P2" } }), { status: 200 });
    }
    return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
  }) as typeof fetch;
  try {
    const result = await fetchFindATender({});
    assert.equal(result.records.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /429.*retry after 60s/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

function notice(overrides: Record<string, unknown> = {}) {
  return {
    id: "OP00474744",
    notice_type: "Invitation for Bids",
    noticedate: "13-Oct-2026",
    notice_status: "Published",
    project_ctry_name: "Sri Lanka",
    project_id: "P181564",
    project_name: "Primary Healthcare System Enhancing Project",
    bid_reference_no: "LK-PHSEP-PMU-552573-GO-RFB",
    bid_description: serviceTitle(),
    procurement_method_name: "Request for Bids",
    submission_date: FUTURE,
    notice_text: "<div><h4>Invitation</h4><p>Bids are invited.</p></div>",
    ...overrides,
  };
}

test("World Bank invitations map to opportunities; awards, expired and irrelevant notices are dropped", () => {
  const record = worldBankNoticeToOpportunity(notice());
  assert.ok(record);
  assert.equal(
    record.sourceUrl,
    "https://projects.worldbank.org/en/projects-operations/procurement-detail/OP00474744",
  );
  assert.equal(record.location, "Sri Lanka");
  assert.equal(record.solicitationNumber, "LK-PHSEP-PMU-552573-GO-RFB");
  assert.equal(record.rawData?.internationalSource, "worldBank");

  assert.equal(worldBankNoticeToOpportunity(notice({ notice_type: "Contract Award" })), null);
  assert.equal(worldBankNoticeToOpportunity(notice({ submission_date: PAST })), null);
  assert.equal(
    worldBankNoticeToOpportunity(notice({ bid_description: "Procurement of lorries", project_name: "Roads" })),
    null,
  );
});

test("World Bank queries come from the profile and caller keywords, capped at three", () => {
  const queries = buildWorldBankQueries("ergonomics");
  assert.ok(queries.length <= 3);
  assert.equal(queries[0], "ergonomics");
  for (const query of buildWorldBankQueries()) assert.ok(profileLeadQueries().includes(query));
});

test("World Bank fetch de-duplicates notices across queries and tolerates one failed query", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 2) return new Response("oops", { status: 500 });
    return new Response(JSON.stringify({ procnotices: [notice()] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await fetchWorldBank({});
    assert.equal(result.records.length, 1);
    assert.ok(calls >= 2);
    assert.equal(result.errors.length, calls >= 2 ? 1 : 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
