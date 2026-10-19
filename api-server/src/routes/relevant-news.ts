import { workspaceResult } from "../lib/intelligence/workspaceResults";
import { Router, type IRouter } from "express";
import { resolveCredential } from "../lib/config/providerConfig";
import { keenableProvider } from "../lib/providers/keenable";
import { logger } from "../lib/logger";
import { apitubeKeys, contractorNewsSignals, fetchApitubeNews, httpUrl } from "../lib/news/apitube";
import { publisherImage } from "../lib/news/articleImages";
import { getSupplementalNewsPool, SUPPLEMENTAL_PROVIDERS, type SupplementalProviderName } from "../lib/news/supplementalNews";

const router: IRouter = Router();

// Load missing publication photos separately so metadata never delays the news feed.
router.get("/news/article-image", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url.slice(0, 4096) : "";
  const image = await publisherImage(url);
  res.setHeader("Cache-Control", image ? "public, max-age=86400" : "public, max-age=900");
  if (!image) return res.status(404).end();
  return res.redirect(image);
});

const GNEWS_SEARCH_URL = "https://gnews.io/api/v4/search";
const REQUEST_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 15 * 60 * 1000;

// Keep the upstream query broad enough to return useful reporting, then apply
// Occu-Med-specific relevance scoring locally. GNews treats publisher country as
// the source location, not the subject of the article, so no country filter is used.
const BASE_QUERY =
  '("federal contract" OR "defense contract" OR "contract award" OR recompete)';
const FALLBACK_QUERY =
  '("contract award" OR "federal contract" OR "government procurement" OR recompete)';

type JsonRecord = Record<string, unknown>;

type NewsArticle = {
  id: string;
  title: string;
  description: string | null;
  content: string | null;
  url: string;
  image: string | null;
  publishedAt: string | null;
  source: {
    name: string;
    url: string | null;
    country: string | null;
  };
  relevanceScore: number;
  provider: "gnews" | "apitube" | "tinyfish" | "keenable" | SupplementalProviderName;
  companies: string[];
  signals: string[];
};

type NewsPayload = {
  articles: NewsArticle[];
  totalArticles: number;
  upstreamArticles: number;
  filteredOut: number;
  query: string;
  source: "gnews" | "apitube" | "tinyfish" | "keenable" | SupplementalProviderName | "mixed";
  sources: Array<"gnews" | "apitube" | "tinyfish" | "keenable" | SupplementalProviderName>;
  warnings: string[];
  deduplicated: number;
  fetchedAt: string;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function sanitizedSearch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[()]/g, " ")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 45) : null;
}

const FEDERAL_CONTEXT_PATTERNS = [
  /\bu\.?s\.?\s+(?:federal\s+)?government\b/i,
  /\bunited states\s+(?:federal\s+)?government\b/i,
  /\bdepartment of defense\b/i,
  /\bdefense department\b/i,
  /\bpentagon\b/i,
  /\bu\.?s\.?\s+army\b/i,
  /\bunited states army\b/i,
  /\bu\.?s\.?\s+navy\b/i,
  /\bunited states navy\b/i,
  /\bu\.?s\.?\s+air force\b/i,
  /\bunited states air force\b/i,
  /\bu\.?s\.?\s+space force\b/i,
  /\bunited states space force\b/i,
  /\bu\.?s\.?\s+marine corps\b/i,
  /\bunited states marine corps\b/i,
  /\bdepartment of homeland security\b/i,
  /\bhomeland security\b/i,
  /\bcustoms and border protection\b/i,
  /\bborder patrol\b/i,
  /\bdepartment of veterans affairs\b/i,
  /\bgeneral services administration\b/i,
  /\bdepartment of health and human services\b/i,
  /\bdepartment of energy\b/i,
  /\bdepartment of labor\b/i,
  /\bdod\b/i,
  /\bdhs\b/i,
  /\bgsa\b/i,
  /\bhhs\b/i,
  /\bcbp\b/i,
  /\bfema\b/i,
  /\btsa\b/i,
  /\bnih\b/i,
  /\bcdc\b/i,
];

const PROCUREMENT_CONTEXT_PATTERNS = [
  /\bcontracts?\b/i,
  /\bawards?\b/i,
  /\bprocure(?:ment|ments|s|d|ing)?\b/i,
  /\bacquisition(?:s)?\b/i,
  /\bsolicit(?:ation|ations|s|ed|ing)?\b/i,
  /\brecompete(?:s|d|ing)?\b/i,
  /\brequest for proposals?\b/i,
  /\brfps?\b/i,
  /\bbids?\b/i,
];

function matchesAny(haystack: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(haystack));
}

export function relevantNewsScore(article: JsonRecord): number {
  const haystack = [article.title, article.description, article.content]
    .map((value) => asString(value) ?? "")
    .join(" ")
    .toLowerCase();

  if (/\bworkers?[’']?\s+comp(?:ensation)?\b/i.test(haystack)) return 0;

  // Generic corporate stories about a "contract award" are not federal
  // contractor intelligence. Require both explicit U.S.-federal context and a
  // procurement/contract signal from the article text itself. Publisher names
  // never satisfy the federal-context gate.
  if (
    !matchesAny(haystack, FEDERAL_CONTEXT_PATTERNS) ||
    !matchesAny(haystack, PROCUREMENT_CONTEXT_PATTERNS)
  ) {
    return 0;
  }

  const weightedTerms: Array<[RegExp, number]> = [
    [/\bfederal contractors?\b/i, 10],
    [/\bgovernment contractors?\b/i, 10],
    [/\bdefense contractors?\b/i, 9],
    [/\bfederal contracts?\b/i, 8],
    [/\bgovernment contracts?\b/i, 8],
    [/\bcontract awards?\b/i, 8],
    [/\brecompete(?:s|d|ing)?\b/i, 8],
    [/\bfederal procurement\b/i, 7],
    [/\bgovernment procurement\b/i, 7],
    [/\bfederal acquisitions?\b/i, 6],
    [/\bgovernment acquisitions?\b/i, 6],
    [/\bsolicit(?:ation|ations|s|ed|ing)?\b/i, 5],
    [/\bdepartment of defense\b/i, 4],
    [/\bhomeland security\b/i, 4],
    [/\bgeneral services administration\b/i, 4],
    [/\bveterans affairs\b/i, 4],
    [/\bdod\b/i, 3],
    [/\bdhs\b/i, 3],
    [/\bgsa\b/i, 3],
    [/\bhhs\b/i, 3],
    [/\bcontracting\b/i, 2],
    [/\bawards?\b/i, 2],
    [/\bcontractors?\b/i, 2],
    [/\bcontracts?\b/i, 3],
    [/\bu\.?s\.?\s+army\b/i, 4],
    [/\bunited states army\b/i, 4],
    [/\bu\.?s\.?\s+navy\b/i, 4],
    [/\bunited states navy\b/i, 4],
    [/\bu\.?s\.?\s+air force\b/i, 4],
    [/\bunited states air force\b/i, 4],
    [/\bu\.?s\.?\s+space force\b/i, 4],
    [/\bunited states space force\b/i, 4],
    [/\bu\.?s\.?\s+marine corps\b/i, 4],
    [/\bunited states marine corps\b/i, 4],
    [/\bpentagon\b/i, 4],
  ];

  return weightedTerms.reduce(
    (score, [pattern, weight]) => score + (pattern.test(haystack) ? weight : 0),
    0,
  );
}

export function normalizeArticle(rawValue: unknown): NewsArticle | null {
  const raw = asRecord(rawValue);
  const source = asRecord(raw.source);
  const title = asString(raw.title);
  const url = httpUrl(raw.url);
  const contractorSignals = contractorNewsSignals(raw);
  if (!title || !url) return null;

  return {
    id: asString(raw.id) ?? url,
    title,
    description: asString(raw.description),
    content: asString(raw.content),
    url,
    image: httpUrl(raw.image),
    publishedAt: asString(raw.publishedAt),
    source: {
      name: asString(source.name) ?? "Unknown source",
      url: httpUrl(source.url),
      country: asString(source.country),
    },
    relevanceScore: Math.max(relevantNewsScore(raw), contractorSignals.score),
    provider: raw.provider === "keenable" ? "keenable" : raw.provider === "tinyfish" ? "tinyfish" : raw.provider === "apitube" ? "apitube" : SUPPLEMENTAL_PROVIDERS.includes(raw.provider as SupplementalProviderName) ? raw.provider as SupplementalProviderName : "gnews",
    companies: contractorSignals.companies,
    signals: contractorSignals.signals,
  };
}

async function requestGNews(query: string, max: number, page: number, apiKey: string): Promise<JsonRecord> {
  const upstreamUrl = new URL(GNEWS_SEARCH_URL);
  if (query.length > 200) throw new Error("News search query exceeds the GNews limit");
  upstreamUrl.searchParams.set("q", query);
  upstreamUrl.searchParams.set("lang", "en");
  upstreamUrl.searchParams.set("max", String(max));
  upstreamUrl.searchParams.set("page", String(page));
  upstreamUrl.searchParams.set("sortby", "publishedAt");
  upstreamUrl.searchParams.set("in", "title,description");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        "X-Api-Key": apiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const statusCode = response.status === 429 ? 429 : response.status === 401 ? 401 : 502;
      throw Object.assign(
        new Error(`GNews API returned HTTP ${response.status}`),
        { statusCode },
      );
    }

    return asRecord(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGNewsFeed(query: string, max: number, page: number, allowFallback: boolean): Promise<unknown[]> {
  const apiKey = process.env.GNEWS_API_KEY?.trim();
  if (!apiKey) throw Object.assign(new Error("GNEWS_API_KEY is not configured"), { statusCode: 503 });
  const limit = Math.min(max, boundedInteger(process.env.GNEWS_MAX_ARTICLES, 10, 1, 100));
  let upstream = await requestGNews(query, limit, page, apiKey);
  if (!Array.isArray(upstream.articles)) throw new Error("GNews returned an invalid news response");
  if (allowFallback && upstream.articles.length === 0) {
    upstream = await requestGNews(FALLBACK_QUERY, limit, page, apiKey);
    if (!Array.isArray(upstream.articles)) throw new Error("GNews returned an invalid news response");
  }
  return upstream.articles;
}

function canonicalArticleUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href.replace(/\/$/, "");
}


async function fetchTinyfishNews(query: string, max: number, sourceDomains: string[], apiKey: string): Promise<unknown[]> {
  const url = new URL("https://api.search.tinyfish.ai");
  url.searchParams.set("query", query);
  url.searchParams.set("domain_type", "news");
  url.searchParams.set("language", "en");
  url.searchParams.set("location", "US");
  url.searchParams.set("recency_minutes", "10080");
  url.searchParams.set("include_thumbnail", "true");
  if (sourceDomains.length) url.searchParams.set("include_domains", sourceDomains.join(","));
  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error("TinyFish news request failed"), { statusCode: response.status });
  const data = asRecord(await response.json());
  if (!Array.isArray(data.results)) throw new Error("TinyFish returned an invalid news response");
  return data.results.slice(0, max).map(value => {
    const row = asRecord(value);
    const articleUrl = httpUrl(row.url);
    let domain = "";
    if (articleUrl) domain = new URL(articleUrl).hostname;
    return {
      title: row.title, url: articleUrl, description: row.snippet,
      image: row.thumbnail_url ?? row.image, publishedAt: row.date ?? row.publishedAt,
      source: { name: asString(row.publisher) ?? domain, url: domain ? `https://${domain}` : null },
      provider: "tinyfish",
    };
  });
}


async function fetchKeenablePublicationNews(query: string, max: number, domains: string[]): Promise<{ articles: unknown[]; warnings: string[] }> {
  const results = await Promise.allSettled(domains.map(domain => keenableProvider.search(query, {
    site: domain,
    publishedAfter: new Date(Date.now() - 7 * 86400000).toISOString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })));
  const articles: unknown[] = [];
  const warnings: string[] = [];
  let succeeded = false;
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      warnings.push(`Keenable coverage for ${domains[index]} is temporarily unavailable.`);
      return;
    }
    succeeded = true;
    articles.push(...result.value.map(row => ({
      title: row.title, url: row.url, description: row.snippet || row.description,
      publishedAt: row.publishedAt, image: null,
      source: { name: domains[index], url: `https://${domains[index]}` },
      provider: "keenable",
    })));
  });
  if (!succeeded) throw Object.assign(new Error("Keenable publication news unavailable"), { statusCode: 502 });
  return { articles: articles.slice(0, max), warnings };
}

function matchesSource(article: NewsArticle, domains: string[]): boolean {
  if (!domains.length) return true;
  const hostname = new URL(article.url).hostname.toLowerCase();
  return domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

export async function fetchRelevantNews(query: string, max: number, page: number, search: string | null, sourceDomains: string[] = [], includeSupplemental = true): Promise<NewsPayload> {
  const jobs: Array<{ provider: "gnews" | "apitube" | "tinyfish" | "keenable"; run: () => Promise<{ articles: unknown[]; warnings: string[] }> }> = [];
  // GNews and APITube keep their full news coverage.
  // TinyFish and Keenable target only the monitored publications.
  // News uses only the primary key; the secondary key belongs to intelligence.
  const tinyfishKey = await resolveCredential("tinyfishApiKey", "TINYFISH_API_KEY");
  if (tinyfishKey && sourceDomains.length) jobs.push({ provider: "tinyfish", run: async () => ({ articles: await fetchTinyfishNews(query, max, sourceDomains, tinyfishKey), warnings: [] }) });
  if (sourceDomains.length) jobs.push({ provider: "keenable", run: () => fetchKeenablePublicationNews(query, max, sourceDomains) });
  if (process.env.GNEWS_API_KEY?.trim()) jobs.push({
    provider: "gnews",
    run: async () => ({ articles: await fetchGNewsFeed(query, max, page, !search && page === 1), warnings: [] }),
  });
  if (apitubeKeys().length) jobs.push({ provider: "apitube", run: () => fetchApitubeNews(search, max, page) });
  const [results, supplemental] = await Promise.all([
    Promise.allSettled(jobs.map(job => job.run())),
    includeSupplemental ? getSupplementalNewsPool() : Promise.resolve(null),
  ]);
  const sources: NewsPayload["sources"] = [];
  const warnings: string[] = [];
  const rawArticles: unknown[] = [];
  let failureStatus = 502;
  for (const [index, result] of results.entries()) {
    const provider = jobs[index]!.provider;
    if (result.status === "fulfilled") {
      sources.push(provider);
      rawArticles.push(...result.value.articles);
      warnings.push(...result.value.warnings);
    } else {
      failureStatus = Number(result.reason?.statusCode) || 502;
      // Sanitized provider errors only; never forward arbitrary fetch errors.
      warnings.push(`${provider === "keenable" ? "Keenable news" : provider === "tinyfish" ? "TinyFish news" : provider === "gnews" ? "GNews" : "APITube"} is temporarily unavailable (HTTP ${failureStatus}).`);
      logger.warn({ provider, statusCode: failureStatus }, "Relevant news provider unavailable");
    }
  }
  for (const name of includeSupplemental ? SUPPLEMENTAL_PROVIDERS : []) {
    const feed = supplemental![name];
    if (feed.status === "disabled") continue;
    if (feed.status === "ok") {
      sources.push(name);
      rawArticles.push(...feed.articles);
    } else {
      warnings.push(name + " is temporarily unavailable (" + (feed.error ?? "invalid response") + ").");
    }
  }
  if (!sources.length) throw Object.assign(new Error(warnings.length ? warnings.join(" ") : "No news providers configured or available"), { statusCode: failureStatus });
  const relevant = rawArticles.map(normalizeArticle)
    .filter((article): article is NewsArticle => article !== null && article.relevanceScore >= 6 && ((article.provider !== "tinyfish" && article.provider !== "keenable") || matchesSource(article, sourceDomains)));
  const unique = new Map<string, NewsArticle>();
  for (const article of relevant) {
    const key = canonicalArticleUrl(article.url);
    const existing = unique.get(key);
    if (!existing || article.relevanceScore > existing.relevanceScore) unique.set(key, article);
  }
  const articles = [...unique.values()].sort((left, right) => {
    const dateDifference = (Date.parse(right.publishedAt ?? "") || 0) - (Date.parse(left.publishedAt ?? "") || 0);
    return dateDifference || right.relevanceScore - left.relevanceScore;
  });
  return {
    articles: articles.slice(0, max), totalArticles: articles.length,
    upstreamArticles: rawArticles.length,
    filteredOut: rawArticles.length - relevant.length,
    deduplicated: relevant.length - articles.length,
    query, source: sources.length > 1 ? "mixed" : sources[0]!, sources, warnings,
    fetchedAt: new Date().toISOString(),
  };
}

router.get("/relevant-news", async (req, res) => {
  const userSearch = sanitizedSearch(req.query.search);
  const sourceDomains = typeof req.query.sources === "string" ? req.query.sources.split(",").map(value => value.trim().toLowerCase().replace(/^www\./, "")).filter(value => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)).slice(0, 20) : [];
  const query = (userSearch ? `(${BASE_QUERY}) AND "${userSearch}"` : BASE_QUERY);
  const max = boundedInteger(req.query.max, 40, 1, 100);
  const page = boundedInteger(req.query.page, 1, 1, 100);
  const newsKeyConfigured = Boolean(await resolveCredential("tinyfishApiKey", "TINYFISH_API_KEY"));
  const cacheKey = `${newsKeyConfigured}|${sourceDomains.join(",")}|${query}|${max}|${page}|${Boolean(process.env.GNEWS_API_KEY?.trim())}|${apitubeKeys().length}|${process.env.GNEWS_MAX_ARTICLES}|${process.env.APITUBE_NEWS_MAX_ARTICLES}|${Boolean(process.env.THENEWSAPI_API_TOKEN)}|${Boolean(process.env.CURRENTS_API_KEY)}|${Boolean(process.env.NEWSDATA_IO_API_KEY)}|${Boolean(process.env.NEWSDATA_IO_API_KEY_2)}`;

  try {
    const payload = await workspaceResult<NewsPayload>("relevant-news-v1", cacheKey, {
      ttlMs: CACHE_TTL_MS,
      refresh: req.query.refresh === "true",
      load: () => fetchRelevantNews(query, max, page, userSearch, sourceDomains),
      usable: value => value.articles.length > 0 || value.warnings.length === 0,
    });
    return res.json({ ...payload, cached: Boolean(payload.savedResult) });
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number }).statusCode) || 502;
    const message = error instanceof Error ? error.message : "Failed to retrieve relevant news";
    logger.error({ statusCode, query }, "Relevant news request failed");
    return res.status(statusCode).json({ error: message });
  }
});

export default router;
