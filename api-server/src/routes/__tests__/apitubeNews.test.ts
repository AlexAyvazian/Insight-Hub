import assert from "node:assert/strict";
import test from "node:test";
import { apitubeKeys, contractorNewsSignals, fetchApitubeNews, mapApitubeArticle } from "../../lib/news/apitube";
import { fetchRelevantNews as fetchRelevantNewsAll, normalizeArticle } from "../relevant-news";
// Validate the original GNews + APITube provider contract independently of the optional news sources.
const fetchRelevantNews = (query: string, max: number, page: number, search: string | null) =>
  fetchRelevantNewsAll(query, max, page, search, [], false);

const article = {
  id: 123, title: "Amentum expands workforce after LOGCAP contract award",
  description: "Defense contractor hiring for overseas support.", body: "U.S. Army procurement supports base operations.",
  href: "https://publisher.example/story?utm_source=apitube", published_at: "2026-09-29T12:00:00Z",
  source: { domain: "publisher.example", home_page_url: "https://publisher.example", location: { country_code: "us" } },
};

test("normalizes APITube provenance and admits business/spending signals without requiring federal procurement", () => {
  const normalized = normalizeArticle(mapApitubeArticle(article));
  assert.equal(normalized?.id, "apitube:123");
  assert.equal(normalized?.provider, "apitube");
  assert.equal(normalized?.publishedAt, article.published_at);
  assert.equal(normalized?.source.name, "publisher.example");
  assert.equal(normalized?.source.country, "us");
  assert.ok(normalized?.companies.includes("Amentum"));
  for (const title of ["Amentum reports earnings and workforce expansion", "Defense budget spending grows", "Airbus expands aerospace production", "V2X awarded LOGCAP contract"]) {
    assert.ok(contractorNewsSignals({ title }).score >= 6, title);
  }
  for (const title of ["Honda awards private vehicle contract", "Military clashes at the border", "U.S. Army awards workers' compensation contract"]) {
    assert.equal(normalizeArticle({ title, url: "https://example.com" })?.relevanceScore, 0, title);
  }
  assert.equal(contractorNewsSignals({ title: "Honda contract award", source: { name: "Aerospace News" } }).score, 0);
  assert.equal(normalizeArticle({ title: article.title, url: "javascript:alert(1)" }), null);
});

test("APITube credentials, API contract, aggregation, and provider failures", async t => {
  const keys = ["GNEWS_API_KEY", "GNEWS_MAX_ARTICLES", "APITUBE_NEWS_API_KEY", "APITUBE_NEWS_API_KEY_2", "APITUBE_NEWS_API_KEY_3", "APITUBE_NEWS_MAX_ARTICLES"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  function reset() {
    clock += 120_000;
    for (const key of keys) delete process.env[key];
    process.env.APITUBE_NEWS_API_KEY_2 = "test-first";
    process.env.APITUBE_NEWS_API_KEY_3 = "test-second";
  }
  const ok = (results: unknown[]) => Response.json({ status: "ok", results });

  await t.test("uses long Boolean queries, correct language filter, dates, and header auth", async () => {
    reset();
    const requests: URL[] = [];
    t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
      const url = new URL(input); requests.push(url);
      assert.equal(url.origin, "https://api.apitube.io");
      assert.equal(url.searchParams.get("language.code"), "en");
      assert.equal(url.searchParams.get("per_page"), "10");
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("sort.by"), "published_at");
      assert.equal(url.searchParams.get("sort.order"), "desc");
      assert.ok(Date.parse(url.searchParams.get("published_at.end")!) - Date.parse(url.searchParams.get("published_at.start")!) <= 31 * 86400_000);
      assert.equal(url.searchParams.has("api_key"), false);
      assert.equal(url.searchParams.has("title"), false);
      assert.equal(url.searchParams.has("organization.name"), false);
      assert.equal(new Headers(init.headers).get("X-API-Key"), "test-first");
      assert.equal(new Headers(init.headers).get("User-Agent"), "Insight-Hub/1.0");
      return ok([article]);
    });
    assert.equal((await fetchApitubeNews(null, 40, 1)).articles.length, 2);
    assert.equal(requests.length, 2);
    assert.match(requests[0]!.searchParams.get("query")!, /"V2X" OR/);
    assert.match(requests[1]!.searchParams.get("query")!, /"defense spending"/);
  });

  await t.test("supports either key and deduplicates identical credentials", () => {
    reset(); delete process.env.APITUBE_NEWS_API_KEY_2;
    assert.deepEqual(apitubeKeys(), ["test-second"]);
    process.env.APITUBE_NEWS_API_KEY_2 = "test-second";
    assert.deepEqual(apitubeKeys(), ["test-second"]);
  });

  await t.test("uses the second key only on authentication failure", async () => {
    reset();
    const used: string[] = [];
    t.mock.method(globalThis, "fetch", async (_input: URL, init: RequestInit) => {
      const key = new Headers(init.headers).get("X-API-Key")!; used.push(key);
      return key === "test-first" ? Response.json({ errors: [{ code: "ER0001" }] }, { status: 401 }) : ok([article]);
    });
    assert.equal((await fetchApitubeNews("Amentum", 40, 1)).articles.length, 1);
    assert.deepEqual(used, ["test-first", "test-second"]);
  });

  await t.test("quotes user search and returns merged, deduplicated provider results", async () => {
    reset(); process.env.GNEWS_API_KEY = "test-gnews";
    t.mock.method(globalThis, "fetch", async (input: URL) => {
      const url = new URL(input);
      if (url.hostname === "gnews.io") return Response.json({ articles: [{
        title: article.title, content: article.body, url: "https://publisher.example/story?utm_source=gnews#top",
        publishedAt: article.published_at, source: { name: "Publisher" },
      }, { title: "Honda awards vehicle contract", url: "https://publisher.example/private" }] });
      assert.equal(url.searchParams.get("query"), '"Amentum OR Boeing"');
      return ok([article]);
    });
    const result = await fetchRelevantNews("federal contract", 40, 1, "Amentum OR Boeing");
    assert.equal(result.source, "mixed");
    assert.deepEqual(result.sources, ["gnews", "apitube"]);
    assert.equal(result.articles.length, 1);
    assert.equal(result.filteredOut, 1);
    assert.equal(result.deduplicated, 1);
    assert.equal(result.warnings.length, 0);
  });

  await t.test("APITube works without a GNews credential", async () => {
    reset();
    t.mock.method(globalThis, "fetch", async () => ok([article]));
    const result = await fetchRelevantNews("federal contract", 40, 1, "Amentum");
    assert.equal(result.source, "apitube");
    assert.equal(result.articles.length, 1);
  });

  await t.test("GNews failure preserves APITube results", async () => {
    reset(); process.env.GNEWS_API_KEY = "test-gnews";
    t.mock.method(globalThis, "fetch", async (url: URL) => new URL(url).hostname === "gnews.io"
      ? Response.json({ error: "secret details" }, { status: 500 }) : ok([article]));
    const result = await fetchRelevantNews("federal contract", 40, 1, "Amentum");
    assert.equal(result.source, "apitube");
    assert.equal(result.articles.length, 1);
    assert.match(result.warnings[0]!, /GNews/);
    assert.equal(JSON.stringify(result).includes("secret details"), false);
  });

  await t.test("a malformed APITube response is an error, not an empty success", async () => {
    reset();
    t.mock.method(globalThis, "fetch", async () => Response.json({ status: "ok" }));
    await assert.rejects(fetchRelevantNews("federal contract", 40, 1, "Amentum"), /APITube is temporarily unavailable/);
  });

  await t.test("rate limit is shared across keys and preserves available GNews results", async () => {
    reset(); process.env.GNEWS_API_KEY = "test-gnews";
    let apitubeRequests = 0;
    t.mock.method(globalThis, "fetch", async (url: URL) => {
      if (new URL(url).hostname === "gnews.io") return Response.json({ articles: [{ title: article.title, content: article.body, url: article.href }] });
      apitubeRequests++;
      return Response.json({ errors: [{ code: "ER0203", message: "api_key=secret" }] }, { status: 429, headers: { "retry-after": "60" } });
    });
    const result = await fetchRelevantNews("federal contract", 40, 1, null);
    assert.equal(result.source, "gnews");
    assert.equal(result.articles.length, 1);
    assert.match(result.warnings[0]!, /APITube/);
    await assert.rejects(fetchApitubeNews("Boeing", 40, 1));
    assert.equal(apitubeRequests, 1);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  });

  await t.test("plan or quota rejection does not rotate credentials", async () => {
    reset(); let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ errors: [{ code: "ER0706" }] }, { status: 403 }); });
    await assert.rejects(fetchApitubeNews("Boeing", 40, 1), /HTTP 403/);
    assert.equal(requests, 1);
  });

  await t.test("one failed APITube query preserves the successful query", async () => {
    reset(); let requests = 0;
    t.mock.method(globalThis, "fetch", async () => ++requests === 1 ? ok([article]) : Response.json({}, { status: 500 }));
    const result = await fetchApitubeNews(null, 40, 1);
    assert.equal(result.articles.length, 1);
    assert.equal(result.warnings.length, 1);
  });
});
