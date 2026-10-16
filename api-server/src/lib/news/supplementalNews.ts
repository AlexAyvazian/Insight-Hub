/**
 * Supplemental news feeds shared across Company Watch and Relevant News.
 * One upstream request per provider per hour per process, including failures.
 * Never log provider URLs: The News API authenticates via query parameter.
 */
import { resolveCredential } from "../config/providerConfig";
import { httpUrl } from "./apitube";

export const SUPPLEMENTAL_PROVIDERS = ["thenewsapi", "currents", "gdelt", "newsdata"] as const;
export type SupplementalProviderName = (typeof SUPPLEMENTAL_PROVIDERS)[number];
export type SupplementalNewsArticle = {
  id: string; title: string; description: string | null; content: string | null;
  url: string; image: string | null; publishedAt: string | null;
  source: { name: string; url: string | null; country: string | null };
  provider: SupplementalProviderName;
};
export type SupplementalFeed = {
  status: "ok" | "error" | "disabled"; articles: SupplementalNewsArticle[];
  error: string | null;
};
export type SupplementalNewsPool = Record<SupplementalProviderName, SupplementalFeed>;

const HOUR_MS = 60 * 60_000;
const TIMEOUT_MS = 12_000;
const QUERY = '("defense contract" OR "government contract" OR "aerospace contract" OR "contract award")';
const ready = (articles: SupplementalNewsArticle[]): SupplementalFeed => ({ status: "ok", articles, error: null });
const unavailable = (error: string): SupplementalFeed => ({ status: "error", articles: [], error });
const disabled = (): SupplementalFeed => ({ status: "disabled", articles: [], error: null });
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

function date(value: unknown): string | null {
  const v = string(value);
  if (!v) return null;
  const gdelt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  const normalized = gdelt
    ? [gdelt[1], "-", gdelt[2], "-", gdelt[3], "T", gdelt[4], ":", gdelt[5], ":", gdelt[6], "Z"].join("")
    : /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?: \+0000)?$/.test(v)
      ? v.replace(" ", "T").replace(/ \+0000$/, "Z").replace(/(\d\d:\d\d:\d\d)$/, "$1Z")
      : v;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeSupplementalArticle(value: unknown, provider: SupplementalProviderName): SupplementalNewsArticle | null {
  const raw = object(value);
  const url = httpUrl(raw.url ?? raw.link);
  const title = string(raw.title);
  if (!url || !title) return null;
  const source = object(raw.source);
  const domain = new URL(url).hostname.replace(/^www\./, "");
  return {
    id: provider + ":" + (string(raw.uuid ?? raw.article_id ?? raw.id) ?? url),
    title,
    description: string(raw.description ?? raw.snippet),
    content: string(raw.content),
    url,
    image: httpUrl(raw.image_url ?? raw.image ?? raw.socialimage),
    publishedAt: date(raw.published_at ?? raw.publishedAt ?? raw.published ?? raw.pubDate ?? raw.seendate),
    source: {
      name: string(source.name ?? raw.source ?? raw.domain) ?? domain,
      url: httpUrl(source.url),
      country: string(raw.sourcecountry ?? raw.country),
    },
    provider,
  };
}

async function jsonRequest(url: URL, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid JSON object");
  return object(data);
}

export async function fetchSupplementalProvider(name: SupplementalProviderName, apiKey?: string): Promise<SupplementalNewsArticle[]> {
  let url: URL;
  let headers: Record<string, string> = {};
  switch (name) {
    case "thenewsapi":
      if (!apiKey) throw new Error("not configured");
      url = new URL("https://api.thenewsapi.com/v1/news/all");
      url.searchParams.set("api_token", apiKey);
      url.searchParams.set("search", '"defense contract" | "government contract" | "aerospace contract" | "contract award"');
      url.searchParams.set("language", "en");
      url.searchParams.set("published_after", new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19));
      url.searchParams.set("limit", "3"); // Free plan: three articles per call.
      break;
    case "currents":
      if (!apiKey) throw new Error("not configured");
      url = new URL("https://api.currentsapi.services/v1/search");
      url.searchParams.set("query", QUERY);
      url.searchParams.set("language", "en");
      url.searchParams.set("page_size", "20");
      url.searchParams.set("start_date", new Date(Date.now() - 7 * 86400000).toISOString());
      url.searchParams.set("end_date", new Date().toISOString());
      headers = { Authorization: "Bearer " + apiKey };
      break;
    case "gdelt":
      url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
      url.searchParams.set("query", QUERY);
      url.searchParams.set("mode", "artlist");
      url.searchParams.set("format", "json");
      url.searchParams.set("maxrecords", "100");
      url.searchParams.set("timespan", "7d");
      url.searchParams.set("sort", "datedesc");
      break;
    case "newsdata":
      if (!apiKey) throw new Error("not configured");
      url = new URL("https://newsdata.io/api/1/latest");
      url.searchParams.set("q", "(defense AND contract) OR (government AND contract) OR (aerospace AND contract)");
      url.searchParams.set("language", "en");
      url.searchParams.set("size", "10");
      headers = { "X-ACCESS-KEY": apiKey };
      break;
  }
  const data = await jsonRequest(url, headers);
  let items: unknown;
  switch (name) {
    case "thenewsapi": items = data.data; break;
    case "currents": if (data.status !== "ok") throw new Error("invalid response status"); items = data.news; break;
    case "gdelt": items = data.articles; break;
    case "newsdata": if (data.status !== "success") throw new Error("invalid response status"); items = data.results; break;
  }
  if (!Array.isArray(items)) throw new Error("invalid article collection");
  return items.map(item => normalizeSupplementalArticle(item, name))
    .filter((article): article is SupplementalNewsArticle => article !== null);
}

const cache = new Map<SupplementalProviderName, { until: number; feed: SupplementalFeed; configured: boolean }>();
const pending = new Map<SupplementalProviderName, Promise<SupplementalFeed>>();

async function getFeed(name: SupplementalProviderName): Promise<SupplementalFeed> {
  const env: Record<Exclude<SupplementalProviderName, "gdelt">, [string, string]> = {
    thenewsapi: ["thenewsApiToken", "THENEWSAPI_API_TOKEN"],
    currents: ["currentsApiKey", "CURRENTS_API_KEY"],
    newsdata: ["newsDataApiKey", "NEWSDATA_API_KEY"],
  };
  const credential = name === "gdelt" ? null : await resolveCredential(...env[name]);
  const configured = name === "gdelt" || Boolean(credential);
  const existing = cache.get(name);
  if (existing && existing.until > Date.now() && existing.configured === configured) return existing.feed;
  if (!configured) {
    const feed = disabled();
    cache.set(name, { until: Date.now() + HOUR_MS, feed, configured: false });
    return feed;
  }
  let request = pending.get(name);
  if (!request) {
    request = fetchSupplementalProvider(name, credential ?? undefined)
      .then(articles => ready(articles))
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : "";
        const status = /^HTTP \d{3}$/.test(message) ? message : /timeout|abort/i.test(message) ? "timeout" : "invalid response";
        return unavailable(status);
      })
      .then(feed => {
        cache.set(name, { until: Date.now() + HOUR_MS, feed, configured: true });
        return feed;
      }).finally(() => { pending.delete(name); });
    pending.set(name, request);
  }
  return request;
}

export async function getSupplementalNewsPool(): Promise<SupplementalNewsPool> {
  const results = await Promise.all(SUPPLEMENTAL_PROVIDERS.map(getFeed));
  return Object.fromEntries(SUPPLEMENTAL_PROVIDERS.map((name, index) => [name, results[index]])) as SupplementalNewsPool;
}

/** For isolated regression tests only. */
export function resetSupplementalNewsCacheForTests(): void {
  cache.clear();
  pending.clear();
}
