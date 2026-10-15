import { Router, type IRouter } from "express";
import { resolveCredential } from "../lib/config/providerConfig";
import { keenableProvider } from "../lib/providers/keenable";
import { apitubeKeys, fetchApitubeNews } from "../lib/news/apitube";
import { fetchGNewsFeed } from "./relevant-news";
const router: IRouter = Router();
router.get("/company-watch/logo/:domain", async (req, res) => {
  const domain = String(req.params.domain ?? "").toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return res.status(400).end();
  const token = await resolveCredential("logoDevToken", "LOGO_DEV_TOKEN");
  if (!token) return res.status(404).end();
  try {
    const endpoint = new URL(`https://img.logo.dev/${domain}`);
    endpoint.searchParams.set("token", token);
    endpoint.searchParams.set("size", req.query.size === "512" ? "512" : "128");
    endpoint.searchParams.set("format", "png");
    const upstream = await fetch(endpoint);
    if (!upstream.ok || !upstream.body) return res.status(404).end();
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    const bytes = await upstream.arrayBuffer();
    return res.send(Buffer.from(bytes));
  } catch { return res.status(404).end(); }
});
type Source={name:string;url:string;domain:string}; type Article={id:string;title:string;url:string;snippet:string;publisher:string|null;publishedAt:string|null;provider:"tinyfish"|"keenable"|"gnews"|"apitube";sourceUrl?:string;image?:string|null};
function validUrl(value: unknown): string|null { try { const u=new URL(String(value)); return /^https?:$/.test(u.protocol)?u.href:null; } catch{return null;} }
function normalize(value:unknown,provider:Article["provider"],source?:Source):Article|null { const r=(value&&typeof value==='object'?value:{}) as Record<string,unknown>; const url=validUrl(r.url); const title=typeof r.title==='string'?r.title.trim():''; if(!url||!title)return null; let publisher=typeof r.publisher==='string'?r.publisher:(typeof r.site_name==='string'?r.site_name:null); if(!publisher)try{publisher=new URL(url).hostname.replace(/^www\./,'')}catch{} return {id:`${provider}:${url}`,title,url,snippet:typeof r.snippet==='string'?r.snippet:(typeof r.description==='string'?r.description:''),publisher,publishedAt:typeof r.date==='string'?r.date:(typeof r.publishedAt==='string'?r.publishedAt:null),provider,sourceUrl:source?.url,image:validUrl(r.thumbnail_url??r.image)}; }
function cleanSources(value:unknown):Source[]{ if(!Array.isArray(value))return []; return value.flatMap(v=>{const r=(v&&typeof v==='object'?v:{}) as Record<string,unknown>; const url=validUrl(r.url); const name=typeof r.name==='string'?r.name.trim():''; if(!url||!name)return []; try{return [{name,url,domain:new URL(url).hostname.replace(/^www\./,'')}]}catch{return []} }).slice(0,20); }
async function tinyfish(query:string,sources:Source[]):Promise<Article[]> { const key=await resolveCredential('tinyfishApiKey','TINYFISH_API_KEY'); if(!key)throw new Error('TinyFish news key (TINYFISH_API_KEY) is not configured'); const u=new URL('https://api.search.tinyfish.ai'); u.searchParams.set('query',query); // The primary TinyFish key is reserved for news. Intelligence uses TINYFISH_API_KEY_2.
 u.searchParams.set('domain_type','news'); u.searchParams.set('include_thumbnail','true'); u.searchParams.set('language','en'); u.searchParams.set('location','US'); u.searchParams.set('recency_minutes','10080'); if(sources.length)u.searchParams.set('include_domains',sources.map(s=>s.domain).join(',')); const response=await fetch(u,{headers:{'X-API-Key':key,'Accept':'application/json'},signal:AbortSignal.timeout(25000)}); if(!response.ok)throw new Error(`TinyFish returned HTTP ${response.status}`); const data=await response.json() as {results?:unknown[]}; return (data.results??[]).map(v=>normalize(v,'tinyfish',sources.find(s=>{try{return new URL(String((v as Record<string,unknown>).url)).hostname.includes(s.domain)}catch{return false}}))).filter((v):v is Article=>Boolean(v)); }
async function keen(query:string,sources:Source[]):Promise<Article[]> { const targets=sources.length?sources:[{name:'Open web',url:'https://www.google.com',domain:''}]; const rows=(await Promise.all(targets.map(s=>keenableProvider.search(`${query} latest news contracts spending acquisition workforce`,{publishedAfter:new Date(Date.now()-7*86400000).toISOString(),...(s.domain?{site:s.domain}:{})})))).flat(); return rows.map(v=>normalize(v,'keenable',sources.find(s=>s.domain&&v.url.includes(s.domain)))).filter((v):v is Article=>Boolean(v)); }
function providerError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/not configured/i.test(message)) return 'TINYFISH_API_KEY is not configured';
  if (/timeout|timed out|abort/i.test(message)) return 'request timed out';
  const status = message.match(/(?:HTTP |error )(\d{3})/i)?.[1];
  if (status === '401') return 'authentication rejected (HTTP 401)';
  if (status === '402') return 'Search API access required (HTTP 402)';
  if (status === '429') return 'rate limit reached (HTTP 429); try again shortly';
  return status ? `request failed (HTTP ${status})` : 'request failed; try again shortly';
}
type CompanySearchResult = {
  articles: Article[];
  companies: string[];
  sources: Source[];
  providers: Array<{ name: string; status: string; count: number; error: string | null }>;
  updatedAt: string | null;
  warnings: string[];
};

type SharedArticle = { article: Article; text: string };
type SharedProvider = { status: "ok" | "error" | "disabled"; entries: SharedArticle[]; warnings: string[]; error: string | null };
type SharedPool = { gnews: SharedProvider; apitube: SharedProvider };

// Company Watch searches one company per request. Fetch broad news ONCE per
// refresh window across all watched companies, not once per company. This keeps
// GNews daily usage and APITube's shared account request window bounded.
const NEWS_POOL_TTL_MS = 15 * 60_000;
const PARTIAL_CACHE_TTL_MS = 60_000;
const MAX_SEARCH_CACHE_ENTRIES = 150;
const searchCache = new Map<string, { expiresAt: number; result: CompanySearchResult }>();
const inFlightSearches = new Map<string, Promise<CompanySearchResult>>();
let newsPoolCache: { expiresAt: number; value: SharedPool } | null = null;
let newsPoolInFlight: Promise<SharedPool> | null = null;

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Convert both news services to the existing Company Watch article contract. */
export function normalizeCompanyNews(value: unknown, provider: "gnews" | "apitube"): SharedArticle | null {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const source = (raw.source && typeof raw.source === "object" ? raw.source : {}) as Record<string, unknown>;
  const url = validUrl(raw.url);
  const title = nonEmpty(raw.title);
  if (!url || !title) return null;
  const snippet = nonEmpty(raw.description) || nonEmpty(raw.snippet) || nonEmpty(raw.content).slice(0, 400);
  const text = [title, nonEmpty(raw.description), nonEmpty(raw.content)].join(" ");
  const article: Article = {
    id: provider + ":" + url,
    title,
    url,
    snippet,
    publisher: nonEmpty(source.name) || nonEmpty(source.domain) || new URL(url).hostname,
    publishedAt: nonEmpty(raw.publishedAt) || null,
    provider,
    image: validUrl(raw.image),
  };
  return { article, text };
}

/** Exact-name and established abbreviation matching; no loose substring matches. */
export function matchesCompanyNews(text: string, company: string): boolean {
  const aliases: Record<string, string[]> = {
    "general dynamics information technology": ["GDIT"],
    "sierra nevada corporation": ["Sierra Nevada", "SNC"],
    "fluor corporation": ["Fluor"],
    "caci international": ["CACI"],
    "v2x": ["Vectrus"],
    "mantech international": ["ManTech"],
    "jacobs technology": ["Jacobs"],
    "american bureau of shipping": ["ABS"],
    "i ap worldwide services": ["IAP Worldwide Services"],
  };
  const normalized = company.toLowerCase().trim();
  const shortName = company.replace(/\s+(?:corporation|corp\.?|inc\.?|llc|ltd\.?|company)$/i, "").trim();
  const variants = [...new Set([company, shortName, ...(aliases[normalized] ?? [])])].filter(value => value.length >= 3);
  return variants.some(value => {
    const escaped = value.replace(/[.*+?^$()|{}\[\]\\]/g, "\\$&");
    return new RegExp("(^|[^\\p{L}\\p{N}])" + escaped + "(?=$|[^\\p{L}\\p{N}])", "iu").test(text);
  });
}

function disabled(): SharedProvider {
  return { status: "disabled", entries: [], warnings: [], error: null };
}

async function gnewsPool(): Promise<SharedProvider> {
  if (!process.env.GNEWS_API_KEY?.trim()) return disabled();
  try {
    const raw = await fetchGNewsFeed(
      '("defense contractor" OR "aerospace" OR "government contract" OR "federal contract" OR "business acquisition")',
      100, 1, false,
    );
    return { status: "ok", entries: raw.map(value => normalizeCompanyNews(value, "gnews")).filter((v): v is SharedArticle => v !== null), warnings: [], error: null };
  } catch (error) {
    return { status: "error", entries: [], warnings: ["GNews: " + providerError(error) + "."], error: providerError(error) };
  }
}

async function apitubePool(): Promise<SharedProvider> {
  if (!apitubeKeys().length) return disabled();
  try {
    const result = await fetchApitubeNews(null, 100, 1);
    return { status: "ok", entries: result.articles.map(value => normalizeCompanyNews(value, "apitube")).filter((v): v is SharedArticle => v !== null),
      warnings: result.warnings.map(() => "APITube returned a partial result; some queries were unavailable."), error: null };
  } catch (error) {
    return { status: "error", entries: [], warnings: ["APITube: " + providerError(error) + "."], error: providerError(error) };
  }
}

async function sharedNewsPool(): Promise<SharedPool> {
  if (newsPoolCache && newsPoolCache.expiresAt > Date.now()) return newsPoolCache.value;
  if (!newsPoolInFlight) {
    newsPoolInFlight = Promise.all([gnewsPool(), apitubePool()]).then(([gnews, apitube]) => {
      const value = { gnews, apitube };
      const partiallyUnavailable = [gnews, apitube].some(p => p.status === "error" || p.warnings.length > 0);
      const rateLimited = [gnews, apitube].some(p => p.error?.includes("429"));
      const ttl = partiallyUnavailable && !rateLimited ? PARTIAL_CACHE_TTL_MS : NEWS_POOL_TTL_MS;
      newsPoolCache = { expiresAt: Date.now() + ttl, value };
      return value;
    }).finally(() => { newsPoolInFlight = null; });
  }
  return newsPoolInFlight;
}

// Reuse the existing short-lived exact-search cache and coalesce concurrent requests.
async function searchCompanies(companies: string[], sources: Source[]): Promise<CompanySearchResult> {
  const query = companies.map(name => '"' + name.replace(/"/g, "") + '"').join(" OR ")
    + " (contract OR award OR spending OR acquisition OR expansion OR workforce OR facility OR aerospace OR defense)";
  const settled = await Promise.allSettled([tinyfish(query, sources), keen(query, sources), sharedNewsPool()]);
  const providerNames = ["tinyfish", "keenable"] as const;
  const providers: CompanySearchResult["providers"] = [];
  const articles: Article[] = [];
  const warnings: string[] = [];
  providerNames.forEach((name, index) => {
    const result = settled[index] as PromiseSettledResult<Article[]>;
    if (result.status === "fulfilled") {
      articles.push(...result.value);
      providers.push({ name, status: "ok", count: result.value.length, error: null });
    } else {
      const error = providerError(result.reason);
      providers.push({ name, status: "error", count: 0, error });
      warnings.push((name === "tinyfish" ? "TinyFish news" : "Keenable news") + ": " + error + ".");
    }
  });
  const newsResult = settled[2];
  const pool: SharedPool = newsResult.status === "fulfilled"
    ? newsResult.value : { gnews: { status: "error", entries: [], warnings: ["GNews news pool unavailable."], error: "request failed" },
      apitube: { status: "error", entries: [], warnings: ["APITube news pool unavailable."], error: "request failed" } };
  for (const name of ["gnews", "apitube"] as const) {
    const upstream = pool[name];
    const matches = upstream.entries.filter(entry => companies.some(company => matchesCompanyNews(entry.text, company))).map(entry => entry.article);
    articles.push(...matches);
    providers.push({ name, status: upstream.status, count: matches.length, error: upstream.error });
    warnings.push(...upstream.warnings);
  }
  const unique = [...new Map(articles.map(article => [article.url, article])).values()]
    .sort((a, b) => (Date.parse(b.publishedAt ?? "") || 0) - (Date.parse(a.publishedAt ?? "") || 0));
  return { articles: unique.slice(0, 100), companies, sources, providers,
    updatedAt: providers.some(provider => provider.status === "ok") ? new Date().toISOString() : null,
    warnings: [...new Set(warnings)] };
}

router.post('/company-watch/search', async (req, res) => {
  const companies: string[] = Array.isArray(req.body?.companies)
    ? req.body.companies.filter((value: unknown) => typeof value === 'string')
      .map((value: string) => value.trim()).filter(Boolean).slice(0, 100) : [];
  const sources = cleanSources(req.body?.sources);
  if (!companies.length) return res.status(400).json({ error: 'Add at least one company.' });

  const cacheKey = JSON.stringify([companies.map(name => name.toLowerCase()), sources.map(source => source.url)]);
  const now = Date.now();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return res.json({ ...cached.result, cached: true });
  if (cached) searchCache.delete(cacheKey);

  let pending = inFlightSearches.get(cacheKey);
  if (!pending) {
    pending = searchCompanies(companies, sources);
    inFlightSearches.set(cacheKey, pending);
  }
  try {
    const result = await pending;
    const ttl = result.warnings.length ? PARTIAL_CACHE_TTL_MS : SEARCH_CACHE_TTL_MS;
    searchCache.set(cacheKey, { expiresAt: Date.now() + ttl, result });
    for (const [key, entry] of searchCache) {
      if (entry.expiresAt <= Date.now()) searchCache.delete(key);
    }
    while (searchCache.size > MAX_SEARCH_CACHE_ENTRIES) {
      const oldest = searchCache.keys().next().value;
      if (oldest === undefined) break;
      searchCache.delete(oldest);
    }
    return res.json({ ...result, cached: false });
  } finally {
    if (inFlightSearches.get(cacheKey) === pending) inFlightSearches.delete(cacheKey);
  }
});
export default router;
