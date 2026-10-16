import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchSupplementalProvider,
  getSupplementalNewsPool,
  normalizeSupplementalArticle,
  resetSupplementalNewsCacheForTests,
} from "../../lib/news/supplementalNews";

test("normalize four providers into the same source-aware article shape", () => {
  const fixtures = [
    ["thenewsapi", { uuid: "n-1", title: "Amentum wins defense contract", url: "https://a.example/news", published_at: "2026-10-15T11:00:00Z", source: "A Newswire", image_url: "https://a.example/img.png" }],
    ["currents", { id: "n-2", title: "V2X expands military facilities", url: "https://b.example/news", published: "2026-10-15 11:05:00", image: "https://b.example/img.png" }],
    ["gdelt", { title: "Leidos announces new Pentagon award", url: "https://c.example/news", seendate: "20261015T110600Z", domain: "c.example", socialimage: "https://c.example/img.png" }],
    ["newsdata", { article_id: "n-4", title: "KBR government contracts", link: "https://d.example/news", pubDate: "2026-10-15 11:07:00", source_id: "NewsData" }],
  ] as const;
  for (const [name, raw] of fixtures) {
    const result = normalizeSupplementalArticle(raw, name);
    assert.equal(result?.provider, name);
    assert.equal(result?.url, (raw as { url?: string; link?: string }).url ?? (raw as { link?: string }).link);
    assert.ok(result?.publishedAt?.startsWith("2026-10-15"));
  }
  assert.equal(normalizeSupplementalArticle({ title: "bad", url: "javascript:alert(1)" }, "gdelt"), null);
});

test("fetch provider endpoints and map their response article arrays", async t => {
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (target: string | URL | Request, options?: RequestInit) => {
    const uri = new URL(String(target));
    seen.push(uri.hostname);
    if (uri.hostname === "api.thenewsapi.com") {
      assert.equal(uri.searchParams.get("limit"), "3");
      assert.equal(uri.searchParams.get("api_token"), "token");
      return Response.json({ data: [{ title: "Defense federal contract", url: "https://news.example/a" }] });
    }
    if (uri.hostname === "api.currentsapi.services") {
      assert.equal((options?.headers as Record<string, string>)?.Authorization, "Bearer token");
      return Response.json({ status: "ok", news: [{ title: "Navy contract", url: "https://news.example/b" }] });
    }
    if (uri.hostname === "api.gdeltproject.org") {
      assert.equal(uri.searchParams.get("mode"), "artlist");
      return Response.json({ articles: [{ title: "Military procurement", url: "https://news.example/c" }] });
    }
    if (uri.hostname === "newsdata.io") {
      assert.equal((options?.headers as Record<string, string>)?.["X-ACCESS-KEY"], "token");
      return Response.json({ status: "success", results: [{ title: "Government contract", link: "https://news.example/d" }] });
    }
    throw new Error("unexpected fetch host");
  });
  for (const name of ["thenewsapi", "currents", "gdelt", "newsdata"] as const) {
    const results = await fetchSupplementalProvider(name, "token");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.provider, name);
  }
  assert.equal(seen.length, 4);
});

test("NewsData secondary key is used ONLY after invalid primary credentials", async t => {
  const tried: string[] = [];
  t.mock.method(globalThis, "fetch", async (_target: string | URL | Request, options?: RequestInit) => {
    const auth = (options?.headers as Record<string, string>)?.["X-ACCESS-KEY"];
    tried.push(auth);
    return auth === "primary" ? Response.json({}, { status: 403 })
      : Response.json({ status: "success", results: [{ title: "Amentum wins award", link: "https://news.example/e" }] });
  });
  const result = await fetchSupplementalProvider("newsdata", "primary", "secondary");
  assert.equal(result.length, 1);
  assert.deepEqual(tried, ["primary", "secondary"]);
});

test("NewsData secondary key is NOT used to bypass rate limits", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({}, { status: 429 });
  });
  await assert.rejects(fetchSupplementalProvider("newsdata", "primary", "secondary"), /HTTP 429/);
  assert.equal(requests, 1);
});

test("unconfigured paid feeds are disabled and GDELT remains keyless with coalesced caching", async t => {
  resetSupplementalNewsCacheForTests();
  const vars = ["THENEWSAPI_API_TOKEN", "CURRENTS_API_KEY", "NEWSDATA_IO_API_KEY", "NEWSDATA_IO_API_KEY_2"];
  const originals = Object.fromEntries(vars.map(name => [name, process.env[name]]));
  for (const name of vars) delete process.env[name];
  t.after(() => {
    for (const name of vars) {
      if (originals[name] !== undefined) process.env[name] = originals[name];
      else delete process.env[name];
    }
    resetSupplementalNewsCacheForTests();
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (target: string | URL | Request) => {
    const uri = new URL(String(target));
    assert.equal(uri.hostname, "api.gdeltproject.org");
    calls++;
    return Response.json({ articles: [{ title: "Army defense contract awarded", url: "https://news.example/f", seendate: "20261015T110000Z" }] });
  });
  const [a, b] = await Promise.all([getSupplementalNewsPool(), getSupplementalNewsPool()]);
  assert.equal(a.gdelt.status, "ok");
  assert.equal(b.gdelt.articles.length, 1);
  assert.equal(calls, 1);
  assert.equal(a.thenewsapi.status, "disabled");
  assert.equal(a.currents.status, "disabled");
  assert.equal(a.newsdata.status, "disabled");
});
