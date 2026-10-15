import { Router, type IRouter } from "express";
import { resolveCredential } from "../lib/config/providerConfig";
import { keenableProvider } from "../lib/providers/keenable";
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
type Source={name:string;url:string;domain:string}; type Article={id:string;title:string;url:string;snippet:string;publisher:string|null;publishedAt:string|null;provider:"tinyfish"|"keenable";sourceUrl?:string;image?:string|null};
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

// Avoid spending provider quota on the same search repeatedly (or concurrently).
// Partial/outage results get only a brief cache; full results retain the news feed TTL.
const SEARCH_CACHE_TTL_MS = 15 * 60_000;
const PARTIAL_CACHE_TTL_MS = 60_000;
const MAX_SEARCH_CACHE_ENTRIES = 150;
const searchCache = new Map<string, { expiresAt: number; result: CompanySearchResult }>();
const inFlightSearches = new Map<string, Promise<CompanySearchResult>>();

async function searchCompanies(companies: string[], sources: Source[]): Promise<CompanySearchResult> {
  const query = companies.map(name => `"${name.replace(/"/g, '')}"`).join(' OR ')
    + ' (contract OR award OR spending OR acquisition OR expansion OR workforce OR facility OR aerospace OR defense)';
  const settled = await Promise.allSettled([tinyfish(query, sources), keen(query, sources)]);
  const providers = settled.map((result, index) => ({
    name: index === 0 ? 'tinyfish' : 'keenable',
    status: result.status === 'fulfilled' ? 'ok' : 'error',
    count: result.status === 'fulfilled' ? result.value.length : 0,
    error: result.status === 'rejected' ? providerError(result.reason) : null,
  }));
  const articles = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const warnings = providers.filter(provider => provider.status === 'error')
    .map(provider => `${provider.name === 'tinyfish' ? 'TinyFish news' : 'Keenable news'}: ${provider.error}.`);
  const unique = [...new Map(articles.map(article => [article.url, article])).values()]
    .sort((a, b) => (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0));
  return { articles: unique.slice(0, 100), companies, sources, providers,
    updatedAt: providers.some(provider => provider.status === 'ok') ? new Date().toISOString() : null, warnings };
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
