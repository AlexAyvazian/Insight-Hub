import "../../search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import test from "node:test";

process.env.RFP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.INTEL_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.AUTH_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.APP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const {
  buildCanadaBuysQueries,
  internationalPublicPortalsProvider,
  isOfficialCanadaBuysTenderUrl,
} = await import("../internationalPublicPortals");

test("CanadaBuys discovery is pinned to official tender-opportunity pages", () => {
  assert.equal(
    isOfficialCanadaBuysTenderUrl(
      "https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/example",
    ),
    true,
  );
  assert.equal(
    isOfficialCanadaBuysTenderUrl(
      "https://www.canadabuys.canada.ca/en/tender-opportunities",
    ),
    true,
  );
  assert.equal(
    isOfficialCanadaBuysTenderUrl(
      "https://canadabuys.canada.ca/en/contract-history",
    ),
    false,
  );
  assert.equal(
    isOfficialCanadaBuysTenderUrl(
      "https://canadabuys.canada.ca.evil.test/en/tender-opportunities/example",
    ),
    false,
  );
});

test("CanadaBuys queries are built from the Neon-backed relevance profile", async () => {
  const { getRelevanceProfile } = await import("../../search/relevanceProfile");
  const { profileSearchPhrases, profileLeadQueries } = await import("../profileQueryTerms");
  const profile = getRelevanceProfile();
  const queries = buildCanadaBuysQueries();
  assert.equal(queries.length, 2);
  assert.ok(queries.every((query: string) => query.includes("site:canadabuys.canada.ca/en/tender-opportunities")));

  // Every lead service query from the profile is searched, quoted, in one of the two queries.
  const leads = profileLeadQueries();
  assert.ok(leads.length > 0);
  for (const lead of leads) {
    assert.ok(queries.some((query: string) => query.includes(`"${lead}"`)), `missing profile lead query ${lead}`);
  }
  // The phrases are the profile's own: the first query carries the leading phrases verbatim.
  for (const phrase of profileSearchPhrases(10)) {
    assert.ok(queries[0]!.includes(`"${phrase}"`), `first query missing ${phrase}`);
  }
  // Procurement wording is the profile's bundle procurement terms.
  const procurementTerm = profile.searchBundles.flatMap((bundle) => bundle.procurementTerms)[0]!;
  assert.ok(queries[0]!.toLowerCase().includes(procurementTerm.toLowerCase()));
  // Caller keywords are appended to every query.
  assert.ok(buildCanadaBuysQueries("ergonomics").every((query: string) => query.includes("(ergonomics)")));
});

test("TED query anchors on the profile's CPV discovery codes", async () => {
  const { getRelevanceProfile } = await import("../../search/relevanceProfile");
  const { buildTedQuery } = await import("../internationalPublicPortals");
  const cpvCodes = getRelevanceProfile()
    .discoveryCodes.filter((d) => d.system === "CPV" && d.match === "exact" && d.effect.startsWith("include"))
    .map((d) => d.code);
  assert.ok(cpvCodes.length > 0, "profile must carry a CPV anchor");
  const query = buildTedQuery();
  for (const code of cpvCodes) assert.ok(query.includes(`classification-cpv=${code}`));
  const withKeywords = buildTedQuery('lead "testing"');
  for (const code of cpvCodes) assert.ok(withKeywords.includes(`classification-cpv=${code}`));
  assert.ok(withKeywords.includes('FT~"lead testing"'));
});

test("international provider is keyless-configured because TED published search is anonymous", async () => {
  assert.equal(await internationalPublicPortalsProvider.isConfigured(), true);
  const status = await internationalPublicPortalsProvider.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.healthy, true);
  assert.equal(status.recordCount, 5);
});
