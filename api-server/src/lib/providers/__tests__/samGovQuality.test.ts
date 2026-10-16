import "../../search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSamGovAutonomousTitleQueries,
  buildSamGovTitleQueries,
  isBidReadySamOpportunity,
  samGovTitleProfiles,
} from "../samGovQuality";
import {
  SAM_GOV_DISCOVERY_TAXONOMY,
  buildSamGovClassificationQueries,
} from "../samGovTaxonomy";
import {
  samGovClassificationEvidence,
  samGovDiscoveryClassificationCodes,
  samGovStrongClassificationCodes,
} from "../samGovTaxonomyEvidence";
import { getRelevanceProfile } from "../../search/relevanceProfile";

const now = new Date("2026-07-29T19:00:00.000Z");
const openSolicitation = {
  noticeId: "notice-1",
  title: "Occupational Health Services",
  type: "Solicitation",
  active: "Yes",
  postedDate: "2026-07-20",
  responseDeadLine: "2026-08-30T23:59:00.000Z",
};

describe("SAM.gov bid-ready query policy", () => {
  it("derives title queries from the profile's search bundles, never from a local vocabulary", () => {
    const profile = getRelevanceProfile();
    const titles = samGovTitleProfiles(profile);
    const bundlesWithServices = profile.searchBundles.filter((bundle) => bundle.serviceTerms.length > 0);
    assert.ok(titles.length > 0, "profile must supply title queries");
    assert.ok(titles.length <= bundlesWithServices.length);

    // A caller phrase that names any of a bundle's service terms selects that bundle's lead query.
    for (const entry of titles) {
      for (const alias of entry.aliases) {
        const queries = buildSamGovTitleQueries(`city county RFP ${alias} due soon`);
        assert.ok(queries.includes(entry.title), `alias "${alias}" should select "${entry.title}"`);
      }
    }

    // Two bundles named in one request are both returned, in profile order, capped at four.
    const [first, second] = titles;
    if (first && second) {
      assert.deepEqual(
        buildSamGovTitleQueries(`${second.aliases[0]} and ${first.aliases[0]}`).slice(0, 2),
        [first.title, second.title],
      );
    }
  });

  it("falls back to the cleaned caller keywords when no profile service term is named", () => {
    assert.deepEqual(buildSamGovTitleQueries("zzz qqq widget federal RFP"), ["zzz qqq widget"]);
    assert.deepEqual(buildSamGovTitleQueries("rfp"), []);
  });

  it("reserves blank input for the rotating autonomous service portfolio", () => {
    const titles = samGovTitleProfiles().map((entry) => entry.title);
    assert.deepEqual(buildSamGovTitleQueries(), []);
    assert.deepEqual(buildSamGovAutonomousTitleQueries(0, 2), titles.slice(0, 2));
    // The cursor wraps around the profile-sized portfolio.
    const wrapped = buildSamGovAutonomousTitleQueries(titles.length - 1, 3);
    assert.deepEqual(wrapped, [titles[titles.length - 1], titles[0], titles[1]]);
    // A cursor beyond the portfolio size still lands on a profile title.
    assert.deepEqual(buildSamGovAutonomousTitleQueries(titles.length + 1, 1), [titles[1]]);
  });

  it("expands SAM discovery to every profile discovery code without turning history into a whitelist", () => {
    const profile = getRelevanceProfile();
    const queries = buildSamGovClassificationQueries();
    const naics = new Set(
      queries.filter((query) => query.parameter === "ncode").map((query) => query.code),
    );
    const psc = new Set(
      queries.filter((query) => query.parameter === "ccode").map((query) => query.code),
    );

    // Every exact, positive NAICS/PSC discovery fact in the profile is a searched lane (tiers preserved).
    const exact = profile.discoveryCodes.filter((d) => d.match === "exact" && d.effect.startsWith("include"));
    const profileNaics = exact.filter((d) => d.system.startsWith("NAICS"));
    const profilePsc = exact.filter((d) => d.system === "PSC");
    assert.ok(profileNaics.length > 0 && profilePsc.length > 0);
    for (const d of profileNaics) assert.equal(naics.has(d.code), true, `missing profile NAICS ${d.code}`);
    for (const d of profilePsc) assert.equal(psc.has(d.code), true, `missing profile PSC ${d.code}`);
    assert.equal(naics.size, new Set(profileNaics.map((d) => d.code)).size);
    assert.equal(psc.size, new Set(profilePsc.map((d) => d.code)).size);

    // Prefix families and other code systems are matchers, not SAM query codes.
    for (const d of profile.discoveryCodes.filter((x) => x.match === "prefix" || x.system === "CPV")) {
      assert.equal(naics.has(d.code) || psc.has(d.code), false, `${d.system} ${d.code} must not be queried`);
    }

    // Tiers, titles and the registered-first ordering come straight from the profile.
    for (const query of queries) {
      const fact = exact.find((d) => d.code === query.code && (query.parameter === "ncode" ? d.system.startsWith("NAICS") : d.system === "PSC"));
      assert.ok(fact, `${query.code} has no profile fact`);
      assert.equal(query.tier, fact!.tier);
      assert.equal(query.title, fact!.title);
    }
    const tierRank = ["registered", "capability", "classification-drift", "secondary-adjacent"];
    const psc2 = queries.filter((query) => query.parameter === "ccode").map((query) => tierRank.indexOf(query.tier));
    assert.deepEqual(psc2, [...psc2].sort((a, b) => a - b));

    // The lazy taxonomy view reads the same profile.
    assert.deepEqual(
      SAM_GOV_DISCOVERY_TAXONOMY.psc.map((entry) => entry.code),
      queries.filter((query) => query.parameter === "ccode").map((query) => query.code),
    );
    assert.deepEqual(samGovDiscoveryClassificationCodes().naics, [...naics]);

    // Every taxonomy entry is a positive discovery lane. None represents an
    // exclusion rule or negative score when an opportunity uses another code.
    assert.equal(queries.every((query) => query.effect === "include"), true);
  });

  it("builds synthetic classification evidence only from profile relevance phrases", () => {
    const profile = getRelevanceProfile();
    const withPhrases = profile.discoveryCodes.filter(
      (d) => d.match === "exact" && d.effect.startsWith("include") && d.relevancePhrases.length > 0 && (d.system === "PSC" || d.system.startsWith("NAICS")),
    );
    assert.ok(withPhrases.length > 0);
    for (const d of withPhrases) {
      const evidence = d.system === "PSC" ? samGovClassificationEvidence(null, d.code) : samGovClassificationEvidence(d.code, null);
      assert.equal(evidence.length, 1);
      assert.ok(evidence[0]!.startsWith(`${d.system === "PSC" ? "PSC" : "NAICS"} ${d.code}: ${d.title}`));
      for (const phrase of d.relevancePhrases) assert.ok(evidence[0]!.includes(phrase));
    }
    // Broad codes (no relevance phrases) and unknown codes yield no evidence and no penalty.
    const broad = profile.discoveryCodes.find((d) => d.match === "exact" && d.system === "PSC" && d.relevancePhrases.length === 0);
    if (broad) assert.deepEqual(samGovClassificationEvidence(null, broad.code), []);
    assert.deepEqual(samGovClassificationEvidence("999999", "Z999"), []);
    assert.deepEqual(samGovClassificationEvidence(undefined, undefined), []);

    const strong = samGovStrongClassificationCodes();
    assert.deepEqual(
      [...strong.psc, ...strong.naics].sort(),
      withPhrases.map((d) => d.code).sort(),
    );
  });

  it("accepts only active bid notices with a future response deadline", () => {
    assert.equal(isBidReadySamOpportunity(openSolicitation, now), true);
    assert.equal(
      isBidReadySamOpportunity(
        { ...openSolicitation, responseDeadLine: "2026-07-01" },
        now,
      ),
      false,
    );
    assert.equal(
      isBidReadySamOpportunity(
        { ...openSolicitation, type: "Sources Sought" },
        now,
      ),
      false,
    );
    assert.equal(
      isBidReadySamOpportunity(
        {
          ...openSolicitation,
          type: "Award Notice",
          award: { amount: 125000 },
        },
        now,
      ),
      false,
    );
  });

  it("searches the full Occu-Med SAM classification taxonomy and hydrates thin SAM metadata before semantic review", async () => {
    const originalFetch = globalThis.fetch;
    const originalSamKey = process.env.SAM_GOV_API_KEY;
    const originalSamBase = process.env.SAM_GOV_BASE_URL;
    const originalJinaKey = process.env.JINA_API_KEY;
    const samRequests: string[] = [];
    const jinaRequests: string[] = [];

    process.env.SAM_GOV_API_KEY = "test-sam-key";
    process.env.SAM_GOV_BASE_URL = "https://api.sam.gov/opportunities/v2/search";
    process.env.JINA_API_KEY = "test-jina-key";

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://api.sam.gov/opportunities/v2/search")) {
        samRequests.push(url);
        return new Response(
          JSON.stringify({
            opportunitiesData: [
              {
                noticeId: "hydration-notice",
                solicitationNumber: "TEST-26-001",
                title: "Testing Services",
                fullParentPathName: "DEPARTMENT OF TESTING.TEST OFFICE",
                type: "Solicitation",
                baseType: "Solicitation",
                active: "Yes",
                naicsCode: "621999",
                classificationCode: "Q999",
                postedDate: "2026-08-18",
                responseDeadLine: "2099-09-30T23:59:00.000Z",
                description: "https://api.sam.gov/prod/opps/v3/opportunities/resources/files/test",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://r.jina.ai/")) {
        jinaRequests.push(url);
        return new Response(
          "Official SAM.gov solicitation for employee occupational medical examinations, medical surveillance, audiometry, spirometry, drug testing, and fitness-for-duty services for a federal workforce. Proposals are currently being accepted.",
          { status: 200, headers: { "content-type": "text/plain" } },
        );
      }
      throw new Error(`Unexpected fetch in SAM regression: ${url}`);
    };

    try {
      const { SamGovProvider } = await import("../samGov");
      const classificationQueries = buildSamGovClassificationQueries();
      const result = await new SamGovProvider().fetch({ dateRange: 30, limit: 1000 });

      // Same number of quota-limited API calls, now retaining early and award notice types in a separate cache.
      // One run rotates a bounded window of the taxonomy (default 6 codes) so a
      // single Fetch cannot burn a small daily SAM.gov quota; coverage comes
      // from the cursor advancing across runs, not from firing every code.
      const perRun = Math.min(
        classificationQueries.length,
        Math.max(1, Math.min(12, Number(process.env.SAM_GOV_CLASSIFICATION_QUERIES_PER_RUN ?? 6) || 6)),
      );
      assert.equal(samRequests.length, 2 + perRun);
      const titleRequests = samRequests.filter((request) => new URL(request).searchParams.has("title"));
      const classificationRequests = samRequests.filter((request) => {
        const params = new URL(request).searchParams;
        return params.has("ncode") || params.has("ccode");
      });
      assert.equal(titleRequests.length, 2);
      assert.equal(classificationRequests.length, perRun);

      for (const request of titleRequests) {
        const params = new URL(request).searchParams;
        assert.ok(params.get("title"));
        assert.deepEqual(params.getAll("ptype"), ["o", "k", "p", "r", "a"]);
        assert.equal(params.get("limit"), "250");
      }
      for (const request of classificationRequests) {
        const params = new URL(request).searchParams;
        assert.notEqual(Boolean(params.get("ncode")), Boolean(params.get("ccode")));
        assert.deepEqual(params.getAll("ptype"), ["o", "k", "p", "r", "a"]);
        assert.equal(params.get("limit"), "75");
      }

      assert.equal(jinaRequests.length, 1);
      assert.equal(result.records.length, 1);
      assert.match(result.records[0]!.description ?? "", /occupational medical examinations/i);
      assert.equal(result.records[0]!.rawData?.descriptionHydratedBy, "jina-reader");
      assert.equal(result.errors.length, 0);
      assert.equal(result.diagnostics?.classificationQueryCount, classificationQueries.length);
      assert.deepEqual(
        result.diagnostics?.expandedPscCodes,
        classificationQueries.filter((query) => query.parameter === "ccode").map((query) => query.code),
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSamKey === undefined) delete process.env.SAM_GOV_API_KEY;
      else process.env.SAM_GOV_API_KEY = originalSamKey;
      if (originalSamBase === undefined) delete process.env.SAM_GOV_BASE_URL;
      else process.env.SAM_GOV_BASE_URL = originalSamBase;
      if (originalJinaKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = originalJinaKey;
    }
  });
});
