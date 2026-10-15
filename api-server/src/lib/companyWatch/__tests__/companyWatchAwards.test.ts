import assert from "node:assert/strict";
import test from "node:test";
import { findAwardee, matchesAwardee, matchesCompanyNews } from "../companyIdentity";
import { assessCompanyArticle, awardAttribution, newsSignal } from "../newsAssessment";
import { assessOccuMedDemand } from "../occuMedDemand";
import { announcementDate, parseAnnouncement, parseContractsRss, recipientSpan } from "../dodContracts";
import { locationCountry } from "../officialAward";
import { normalizeUsaSpendingRow, fetchUsaSpendingAwards, usaSpendingRequestBody } from "../usaSpendingAwards";
import { buildCompanyLeads, dedupeLeads } from "../awardLeads";
import { upsertAwards, type SqlRunner, type StoredAward } from "../awardStore";
import { companyAwards, runAwardPass } from "../awardWatcher";
import { buildProfile, type ProfileRows } from "../../search/relevanceProfile";

const NOW = Date.parse("2026-10-15T12:00:00Z");

// ── Award headlines and attribution ────────────────────────────────────────────────────────────────────────────────

test("real award headline shapes are award signals with the company as reported winner", () => {
  const cases: Array<[string, string, string?]> = [
    ["KBR wins $90 million Army LOGCAP task order", "KBR"],
    ["Army awards $412M base operations contract to Amentum", "Amentum"],
    ["V2X secures $1.2B Air Force contract for overseas base support", "V2X"],
    ["Pentagon contract won by Leidos for medical readiness support", "Leidos"],
    ["Fluor lands Department of Energy cleanup contract", "Fluor Corporation"],
    ["Navy selects KBR for $250 million engineering services contract", "KBR"],
  ];
  for (const [title, company] of cases) {
    assert.equal(newsSignal({ title }), "award", title);
    assert.equal(awardAttribution(title, company), "reported_awardee", `${company}: ${title}`);
  }
});

test("a known winner versus a losing or protesting bidder", () => {
  const headline = "Leidos beats KBR to win $1B Army health readiness contract";
  assert.equal(awardAttribution(headline, "Leidos"), "reported_awardee");
  assert.equal(awardAttribution(headline, "KBR"), "not_awardee");
  const protest = "GAO denies KBR protest of Leidos Army contract win";
  assert.equal(awardAttribution(protest, "KBR"), "not_awardee");
  assert.equal(awardAttribution(protest, "Leidos"), "reported_awardee");
  const bystander = "KBR, Fluor among bidders as Amentum wins Army LOGCAP contract";
  assert.equal(awardAttribution(bystander, "Amentum"), "reported_awardee");
  assert.equal(awardAttribution(bystander, "KBR"), "mentioned");
  assert.equal(awardAttribution(bystander, "Fluor Corporation"), "mentioned");
  const assessed = assessCompanyArticle({ title: headline, publishedAt: "2026-10-14T00:00:00Z" }, "KBR", NOW);
  assert.equal(assessed.signal, "award");
  assert.equal(assessed.attribution, "not_awardee");
});

test("false positives are not awards: private-sector, earnings, protests and industry prizes", () => {
  for (const title of [
    "Honda awards private vehicle contract to supplier",
    "KBR reports third-quarter earnings",
    "Leidos wins innovation award from industry group",
    "Amentum protests Army award",
    "Defense contractor V2X not awarded Army recompete",
  ]) {
    assert.notEqual(newsSignal({ title }), "award", title);
  }
  assert.equal(newsSignal({ title: "Army issues RFP for LOGCAP VI recompete" }), "solicitation");
});

test("an unrelated article is neither an award nor attributed", () => {
  const assessed = assessCompanyArticle({ title: "Amentum sponsors local charity run", snippet: "Employees volunteered on Saturday.", publishedAt: "2026-10-14T00:00:00Z" }, "Amentum", NOW);
  assert.equal(assessed.signal, null);
  assert.equal(assessed.attribution, "mentioned");
  assert.equal(assessCompanyArticle({ title: "Weather delays shipping", publishedAt: "2026-10-14T00:00:00Z" }, "KBR", NOW).attribution, "none");
  // Older than the 7-day window: not fresh, so not highlighted.
  assert.equal(assessCompanyArticle({ title: "KBR wins $90 million Army contract", publishedAt: "2026-09-01T00:00:00Z" }, "KBR", NOW).fresh, false);
});

// ── Company identity and name collisions ──────────────────────────────────────────────────────────────────────────

test("company name collisions never attribute another firm's award", () => {
  assert.equal(matchesAwardee("INTERNATIONAL SOS GOVERNMENT SERVICES, INC.", "SOS International"), null);
  assert.equal(matchesAwardee("SOS INTERNATIONAL LLC", "SOS International")?.basis, "name");
  assert.equal(matchesAwardee("SOS INTERNATIONAL LLC", "International SOS"), null);
  assert.equal(matchesAwardee("JACOBS FAMILY CONSTRUCTION LLC", "Jacobs Technology"), null);
  assert.equal(matchesAwardee("Jacobs Technology Inc., Tullahoma, Tennessee", "Jacobs Technology")?.basis, "name");
  assert.equal(matchesAwardee("KBR WYLE SERVICES, LLC", "KBR")?.basis, "name");
  assert.equal(matchesAwardee("Kellogg Brown & Root Services Inc., Houston, Texas", "KBR")?.basis, "alias");
  assert.equal(matchesAwardee("VECTRUS SYSTEMS CORPORATION", "V2X")?.basis, "alias");
  assert.equal(matchesAwardee("BAE SYSTEMS LAND & ARMAMENTS L.P.", "BAE Systems")?.basis, "name");
  assert.equal(matchesAwardee("Acme Leidos Partners LLC", "Leidos"), null, "must START with the company name");
  assert.equal(matchesAwardee("GDC CONSTRUCTION LLC", "GDC")?.basis, "short_name", "short acronym names are only possible matches");
  assert.ok(!matchesCompanyNews("MAGNIFICENT results", "MAG"));
  assert.ok(matchesCompanyNews("GDIT expands hiring in Europe", "General Dynamics Information Technology"));
});

test("company-level match inside a multi-awardee notice", () => {
  const span = "Amentum Services Inc., Germantown, Maryland (W52P1J-26-D-0011); Fluor Intercontinental Inc., Greenville, South Carolina (W52P1J-26-D-0012); and SOS International LLC, Reston, Virginia (W52P1J-26-D-0013)";
  assert.equal(findAwardee(span, "Amentum")?.match.basis, "name");
  assert.match(findAwardee(span, "Fluor Corporation")?.recipient ?? "", /^Fluor Intercontinental Inc\./);
  assert.ok(findAwardee(span, "SOS International"));
  assert.equal(findAwardee(span, "International SOS"), null);
  assert.equal(findAwardee(span, "Leidos"), null);
});

// ── Official award ingestion (DoD announcements, USAspending) ───────────────────────────────────────────────────────

const ANNOUNCEMENT = `<html><body><div class="body">
<p style="text-align:center"><strong>ARMY</strong></p>
<p>Leidos Inc., Reston, Virginia, was awarded a $48,215,330 cost-plus-fixed-fee contract for pre-deployment medical screening and medical readiness services for contractor personnel. Bids were solicited via the internet with three received. Work will be performed in Camp Arifjan, Kuwait, with an estimated completion date of Oct. 14, 2031. Fiscal 2026 operation and maintenance, Army funds in the amount of $5,000,000 were obligated at the time of the award. Army Contracting Command, Rock Island Arsenal, Illinois, is the contracting activity (W52P1J-26-C-0042).</p>
<p>KBR Wyle Services LLC, Houston, Texas, was awarded a $12,500,000 modification (P00017) to contract W9124P-22-F-0104 for logistics support. Work will be performed in Fort Bragg, North Carolina, with an estimated completion date of Sept. 30, 2027. Army Contracting Command, Fort Bragg, North Carolina, is the contracting activity.</p>
<p style="text-align:center"><strong>NAVY</strong></p>
<p>Amentum Services Inc., Germantown, Maryland (N62470-26-D-0101); Fluor Intercontinental Inc., Greenville, South Carolina (N62470-26-D-0102); and International SOS Government Services Inc., Houston, Texas (N62470-26-D-0103), are each awarded a firm-fixed-price, indefinite-delivery/indefinite-quantity contract with a combined maximum value of $950,000,000 for base operating support. Work will be performed in Naples, Italy (60%); and Norfolk, Virginia (40%), and is expected to be completed by October 2031. Naval Facilities Engineering Systems Command Atlantic, Norfolk, Virginia, is the contracting activity.</p>
<p>*Small business</p>
</div></body></html>`;
const PAGE_URL = "https://www.war.gov/News/Contracts/Contract/Article/4300001/";

test("DoD daily announcement paragraphs become official award records with sourced fields", () => {
  const awards = parseAnnouncement(ANNOUNCEMENT, PAGE_URL, "2026-10-14");
  assert.equal(awards.length, 3);
  const [leidos, kbr, navy] = awards;
  assert.equal(leidos!.recipientText, "Leidos Inc., Reston, Virginia");
  assert.equal(leidos!.amount, 48_215_330);
  assert.equal(leidos!.contractNumber, "W52P1J-26-C-0042");
  assert.equal(leidos!.modification, false);
  assert.equal(leidos!.workLocation, "Camp Arifjan, Kuwait");
  assert.equal(leidos!.popCountry, "Kuwait");
  assert.match(leidos!.awardingAgency ?? "", /^ARMY — Army Contracting Command, Rock Island Arsenal, Illinois/);
  assert.equal(leidos!.sourceUrl, PAGE_URL);
  assert.equal(kbr!.modification, true);
  assert.equal(kbr!.popCountry, "USA");
  assert.match(kbr!.awardKey, /^dod:W9124P22F0104:P00017:2026-10-14:/);
  assert.match(navy!.recipientText, /^Amentum Services Inc\./);
  assert.equal(navy!.popCountry, "Italy");
  assert.equal(navy!.amount, 950_000_000);
  // Same input, same key: re-processing a page never creates a second record.
  assert.deepEqual(parseAnnouncement(ANNOUNCEMENT, PAGE_URL, "2026-10-14").map(a => a.awardKey), awards.map(a => a.awardKey));
});

test("DoD RSS feed items, dates, recipient spans and locations", () => {
  const xml = `<rss><channel><item><title>Contracts For Oct. 14, 2026</title><link>${PAGE_URL}</link><pubDate>Tue, 14 Oct 2026 21:00:00 GMT</pubDate><description>&lt;p&gt;short&lt;/p&gt;</description></item><item><title>bad</title><link>javascript:x</link></item></channel></rss>`;
  const items = parseContractsRss(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.description, "<p>short</p>");
  assert.equal(announcementDate(items[0]!.title, items[0]!.pubDate), "2026-10-14");
  assert.equal(announcementDate("Contracts", "Tue, 14 Oct 2026 21:00:00 GMT"), "2026-10-14");
  assert.equal(recipientSpan("The following companies have been awarded a $9,000,000 contract for support: Acme Inc., Dayton, Ohio (FA8601-26-D-0001); and Beta LLC, Austin, Texas (FA8601-26-D-0002). Work will be performed in Dayton, Ohio."),
    "Acme Inc., Dayton, Ohio (FA8601-26-D-0001); and Beta LLC, Austin, Texas (FA8601-26-D-0002)");
  assert.equal(locationCountry("Huntsville, Alabama"), "USA");
  assert.equal(locationCountry("Washington, D.C."), "USA");
  assert.equal(locationCountry("various locations"), null);
  assert.equal(locationCountry("Grafenwoehr, Germany; and Fort Bliss, Texas"), "Germany");
});

test("USAspending rows are kept only when the recipient is verifiably the company", async () => {
  const body = usaSpendingRequestBody("KBR", new Date(NOW)) as { filters: { recipient_search_text: string[]; award_type_codes: string[]; time_period: Array<{ date_type?: string }> } };
  assert.deepEqual(body.filters.recipient_search_text, ["KBR"]);
  assert.deepEqual(body.filters.award_type_codes, ["A", "B", "C", "D"]);
  assert.equal(body.filters.time_period[0]!.date_type, "date_signed");
  const rows = [
    { generated_internal_id: "CONT_AWD_1", "Award ID": "W91CRB26C0001", "Recipient Name": "KBR WYLE SERVICES, LLC", "Recipient UEI": "ABC123DEF456", "Award Amount": 3_000_000, "Start Date": "2026-09-20", "Awarding Agency": "Department of State", "Place of Performance Country Code": "IRQ", Description: "Life support services" },
    { generated_internal_id: "CONT_AWD_2", "Award ID": "X1", "Recipient Name": "SKBR HOLDINGS LLC", "Award Amount": 50_000, "Start Date": "2026-09-21" },
  ];
  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json({ results: rows });
  }) as typeof fetch;
  const result = await fetchUsaSpendingAwards("KBR", new Date(NOW), fakeFetch);
  assert.equal(result.rows, 2);
  assert.equal(result.awards.length, 1);
  assert.deepEqual(result.rejectedRecipients, ["SKBR HOLDINGS LLC"]);
  assert.equal(result.awards[0]!.recipientUei, "ABC123DEF456");
  assert.equal(result.awards[0]!.popCountry, "IRQ");
  assert.equal(result.awards[0]!.sourceUrl, "https://www.usaspending.gov/award/CONT_AWD_1");
  assert.ok(calls.every(url => url.startsWith("https://api.usaspending.gov/")));
  assert.equal(normalizeUsaSpendingRow({}), null);
});

// ── Leads, first-seen, de-duplication ─────────────────────────────────────────────────────────────────────────────

function stored(awards: ReturnType<typeof parseAnnouncement>, firstSeenAt: string): StoredAward[] {
  return awards.map(award => ({ ...award, firstSeenAt }));
}

test("leads: confirmed awardee, documented incumbent, collision-safe, newest and newly detected first", () => {
  const fresh = stored(parseAnnouncement(ANNOUNCEMENT, PAGE_URL, "2026-10-14"), new Date(NOW - 3_600_000).toISOString());
  const leidos = buildCompanyLeads("Leidos", fresh, NOW);
  assert.equal(leidos.length, 1);
  assert.equal(leidos[0]!.attribution, "confirmed_awardee");
  assert.equal(leidos[0]!.matchedRecipient, "Leidos Inc.");
  assert.equal(leidos[0]!.newlyDetected, true);
  assert.ok(leidos[0]!.missing.includes("recipient UEI"));
  assert.ok(!leidos[0]!.missing.includes("amount"));
  const kbr = buildCompanyLeads("KBR", fresh, NOW);
  assert.equal(kbr[0]!.attribution, "documented_incumbent");
  assert.equal(buildCompanyLeads("Amentum", fresh, NOW)[0]!.popCountry, "Italy");
  assert.equal(buildCompanyLeads("SOS International", fresh, NOW).length, 0, "International SOS's award is not SOS International's");
  assert.equal(buildCompanyLeads("Peraton", fresh, NOW).length, 0);
  // An earlier, different contract (another contract number) detected 10 days ago.
  const old = stored(parseAnnouncement(ANNOUNCEMENT.replace("W52P1J-26-C-0042", "W52P1J-26-C-0007"), PAGE_URL, "2026-10-01"), new Date(NOW - 10 * 86_400_000).toISOString());
  const both = buildCompanyLeads("Leidos", [...old, ...fresh], NOW);
  assert.equal(both.length, 2);
  assert.equal(both[0]!.newlyDetected, true);
  assert.equal(both[1]!.newlyDetected, false);
});

test("the same contract from two official sources is one lead", () => {
  const dod = buildCompanyLeads("Leidos", stored(parseAnnouncement(ANNOUNCEMENT, PAGE_URL, "2026-10-14"), new Date(NOW).toISOString()), NOW);
  const usa = buildCompanyLeads("Leidos", [{
    ...normalizeUsaSpendingRow({ generated_internal_id: "CONT_AWD_W52P1J26C0042", "Award ID": "W52P1J26C0042", "Recipient Name": "LEIDOS, INC.", "Recipient UEI": "LEIDOSUEI001", "Start Date": "2026-10-14" })!,
    firstSeenAt: new Date(NOW).toISOString(),
  }], NOW);
  const merged = dedupeLeads([...usa, ...dod]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.source, "dod_contract_announcement");
  assert.equal(merged[0]!.recipientUei, "LEIDOSUEI001");
});

test("first-seen tracking: an award is new once; re-seeing it keeps the original first_seen_at", async () => {
  const seen = new Set<string>();
  const statements: string[] = [];
  const run: SqlRunner = async (text, params = []) => {
    statements.push(text);
    const key = String(params[0]);
    const inserted = !seen.has(key);
    seen.add(key);
    return [{ inserted }];
  };
  const awards = parseAnnouncement(ANNOUNCEMENT, PAGE_URL, "2026-10-14");
  assert.equal(await upsertAwards(run, awards), 3);
  assert.equal(await upsertAwards(run, awards), 0);
  assert.ok(statements.every(sql => /ON CONFLICT \(award_key\) DO UPDATE SET last_seen_at = now\(\)/.test(sql)));
  assert.ok(statements.every(sql => !/first_seen_at\s*=/.test(sql)), "first_seen_at is never overwritten");
});

// ── No paid news calls ────────────────────────────────────────────────────────────────────────────────────────────

test("official awards and the background pass make no paid news API calls", async t => {
  const hosts: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    hosts.push(url.hostname);
    if (url.hostname === "www.war.gov" && url.pathname.includes("RSS")) {
      return new Response(`<rss><channel><item><title>Contracts For Oct. 14, 2026</title><link>${PAGE_URL}</link></item></channel></rss>`);
    }
    if (url.hostname === "www.war.gov") return new Response(ANNOUNCEMENT);
    if (url.hostname === "api.usaspending.gov") return Response.json({ results: [] });
    throw new Error(`unexpected host ${url.hostname}`);
  }) as typeof fetch;
  const globalFetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("global fetch must not be used"); });
  const rows: Array<Record<string, unknown>> = [];
  const run: SqlRunner = async (text) => {
    if (/RETURNING \(xmax = 0\)/.test(text)) return [{ inserted: true }];
    if (/FROM company_watch_companies/.test(text) && /SELECT company_key/.test(text)) return [{ company_key: "kbr", name: "KBR" }];
    if (/FROM company_watch_awards\s+WHERE action_date/.test(text)) return rows;
    return [];
  };
  const summary = await runAwardPass(run, fakeFetch);
  assert.equal(summary.dod.feedItems, 1);
  assert.equal(summary.dod.awardsParsed, 3);
  assert.equal(summary.dod.newAwards, 3);
  assert.equal(summary.usaspending.companies, 1);
  assert.deepEqual([...new Set(hosts)].sort(), ["api.usaspending.gov", "www.war.gov"]);
  for (const paid of ["gnews.io", "api.apitube.io", "api.search.tinyfish.ai"]) assert.ok(!hosts.includes(paid));

  const response = await companyAwards(["KBR", "Leidos"], run);
  assert.deepEqual(Object.keys(response.companies), ["KBR", "Leidos"]);
  assert.equal(globalFetch.mock.callCount(), 0, "reading awards calls no external API");
});

// ── OCCU_MED_AWARE demand ────────────────────────────────────────────────────────────────────────────────────────

const ROWS: ProfileRows = {
  terms: [
    { phrase: "pre-deployment medical", term_type: "procurement_phrase", match_strength: "direct", target_keys: null, metadata: { category: "deployment_readiness" } },
    { phrase: "OCONUS", term_type: "regulatory_reference", match_strength: "review", target_keys: null, metadata: { category: "deployment_readiness" } },
    { phrase: "contractor personnel", term_type: "workforce_signal", match_strength: "review", target_keys: null, metadata: null },
    { phrase: "logcap", term_type: "buyer_sector_signal", match_strength: "direct", target_keys: null, metadata: null },
  ],
  rules: [
    { rule_key: "workers_comp_excluded", category: "scope", title: "Workers' compensation is excluded", rule_text: "", machine_action: "reject_as_out_of_scope", hard_rule: true, priority: 100, scope: null, search_triggers: ["workers compensation", "managed care"] },
  ],
  facts: [{ fact_key: "c1", category: "relevance_category", predicate: "deployment_readiness", value_text: "Deployment / overseas medical readiness", value_json: {}, value_numeric: null }],
  policies: [],
};

test("OCCU_MED_AWARE demand: cited evidence, overseas work, workers' comp excluded, unavailable profile", () => {
  const profile = buildProfile(ROWS, "neon");
  const high = assessOccuMedDemand("Pre-deployment medical screening for contractor personnel", {}, "award_text", profile);
  assert.equal(high.level, "high");
  assert.ok(high.evidence.some(item => item.kind === "service" && item.terms.includes("pre-deployment medical")));
  assert.ok(high.evidence.some(item => item.kind === "workforce"));

  const overseas = assessOccuMedDemand("Base operating support services", { placeOfPerformanceCountry: "Kuwait", placeOfPerformanceText: "Camp Arifjan, Kuwait", newAward: true }, "award_text", profile);
  assert.equal(overseas.level, "medium");
  assert.ok(overseas.evidence.some(item => item.kind === "overseas" && item.source === "official_record"));
  assert.match(overseas.uncertainty, /not confirm hiring/);

  const comp = assessOccuMedDemand("Workers compensation managed care claims for contractor personnel", {}, "award_text", profile);
  assert.equal(comp.level, "excluded");
  assert.ok(!comp.evidence.some(item => item.kind === "service"), "workers' compensation is never shown as in scope");

  const low = assessOccuMedDemand("Software license renewal", { placeOfPerformanceCountry: "USA" }, "award_text", profile);
  assert.equal(low.level, "low");

  const unavailable = assessOccuMedDemand("Pre-deployment medical screening", {}, "award_text", buildProfile({ terms: [], rules: [], facts: [], policies: [] }, "unavailable"));
  assert.equal(unavailable.level, "unknown");
});
