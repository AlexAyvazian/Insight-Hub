import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { keenableProvider } from "../../lib/providers/keenable";
import router, { matchesCompanyNews, normalizeCompanyNews } from "../company-watch";

test("GNews and APITube articles retain original source, image, and provider attribution", () => {
  const gnews = normalizeCompanyNews({
    title: "Amentum expands defense workforce",
    description: "Government contractor expansion",
    content: "Amentum is expanding its defense workforce",
    url: "https://news.example/amentum",
    publishedAt: "2026-10-14T09:00:00Z",
    source: { name: "Public News" },
    image: "https://news.example/image.jpg",
  }, "gnews");
  assert.equal(gnews?.article.provider, "gnews");
  assert.equal(gnews?.article.publisher, "Public News");
  assert.equal(gnews?.article.image, "https://news.example/image.jpg");
  assert.ok(matchesCompanyNews(gnews!.text, "Amentum"));

  const apitube = normalizeCompanyNews({
    title: "V2X wins new contract",
    url: "https://publisher.example/v2x",
    publishedAt: "2026-10-14T10:00:00Z",
    source: { name: "GovCon Press" },
  }, "apitube");
  assert.equal(apitube?.article.provider, "apitube");
  assert.equal(apitube?.article.publisher, "GovCon Press");
  assert.equal(apitube?.article.url, "https://publisher.example/v2x");
  assert.equal(normalizeCompanyNews({ title: "Invalid", url: "javascript:alert(1)" }, "gnews"), null);
});

test("name matcher accepts established aliases but not unrelated substrings", () => {
  assert.ok(matchesCompanyNews("GDIT expands hiring in Europe", "General Dynamics Information Technology"));
  assert.ok(matchesCompanyNews("Sierra Nevada wins an aerospace award", "Sierra Nevada Corporation"));
  assert.ok(matchesCompanyNews("Fluor wins new contract", "Fluor Corporation"));
  assert.ok(matchesCompanyNews("Vectrus expands after merger", "V2X"));
  assert.ok(!matchesCompanyNews("This image was updated", "MAG"));
  assert.ok(!matchesCompanyNews("V2Xtra services", "V2X"));
  assert.ok(!matchesCompanyNews("An unrelated company expands", "Amentum"));
});

test("Company Watch reuses shared GNews and APITube calls across multiple watched companies", async t => {
  const keys = ["GNEWS_API_KEY", "APITUBE_NEWS_API_KEY", "APITUBE_NEWS_API_KEY_2", "APITUBE_NEWS_API_KEY_3", "TINYFISH_API_KEY"];
  const originals = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { GNEWS_API_KEY: "gnews-test", APITUBE_NEWS_API_KEY: "apitube-test", TINYFISH_API_KEY: "tinyfish-test" });
  t.after(() => {
    for (const key of keys) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  });

  const calls = { gnews: 0, apitube: 0, tinyfish: 0, keen: 0 };
  const realFetch = globalThis.fetch;
  t.mock.method(keenableProvider, "search", async () => { calls.keen++; return []; });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "gnews.io") {
      calls.gnews++;
      return Response.json({ articles: [{
        title: "Amentum expands defense hiring",
        description: "Amentum will expand its contract workforce",
        url: "https://news.example/gnews-amentum",
        publishedAt: "2026-10-14T09:00:00Z",
        source: { name: "News Test" },
      }] });
    }
    if (url.hostname === "api.apitube.io") {
      calls.apitube++;
      return Response.json({ status: "ok", results: [{
        id: "test-1", title: "V2X announces aerospace contract",
        href: "https://news.example/apitube-v2x", published_at: "2026-10-14T09:30:00Z",
        source: { domain: "Publisher Test" },
      }] });
    }
    if (url.hostname === "api.search.tinyfish.ai") {
      calls.tinyfish++;
      return Response.json({ results: [] });
    }
    throw new Error("Unexpected provider URL: " + url.hostname);
  });

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = app.listen(0);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = "http://127.0.0.1:" + address.port + "/api/company-watch/search";
  const search = async (company: string) => {
    const response = await realFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companies: [company] }),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{
      articles: Array<{ title: string; provider: string }>;
      providers: Array<{ name: string; status: string; count: number }>;
      cached: boolean;
    }>;
  };

  const amentum = await search("Amentum");
  assert.ok(amentum.articles.some(article => article.provider === "gnews"));
  assert.ok(!amentum.articles.some(article => article.provider === "apitube"));
  assert.equal(amentum.providers.find(p => p.name === "gnews")?.status, "ok");

  const v2x = await search("V2X");
  assert.ok(v2x.articles.some(article => article.provider === "apitube"));
  assert.ok(!v2x.articles.some(article => article.provider === "gnews"));
  assert.equal(v2x.providers.find(p => p.name === "apitube")?.status, "ok");

  const again = await search("Amentum");
  assert.equal(again.cached, true);
  assert.equal(calls.gnews, 1, "GNews must not be billed separately for each company");
  assert.equal(calls.apitube, 2, "APITube's two shared sector queries must run only once");
  assert.equal(calls.tinyfish, 2);
  assert.equal(calls.keen, 2);
});
