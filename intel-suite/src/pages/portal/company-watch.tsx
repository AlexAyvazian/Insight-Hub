import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CircleAlert, Clock3, ExternalLink, Loader2, Plus, Search, X } from "lucide-react";

type Company = { name: string };
type Article = { id: string; title: string; url: string; snippet: string; publisher: string | null; publishedAt: string | null; provider: string; image?: string | null; companyNames?: string[] };
type ProviderResult = { name: string; status: string; count: number; error?: string | null };
type SearchResult = { articles: Article[]; updatedAt: string | null; warnings?: string[]; providers?: ProviderResult[] };
type CompanyCheck = { updatedAt: string | null; warnings: string[]; providers: ProviderResult[] };
const SEED=['Leidos','IAP Worldwide Services','MAG Aerospace','Camber Corporation','Trace Systems','KBR','BAE Systems','Weatherford International','Versar','Constellis','C3EL','Fluor Corporation','Clovehitch','V2X','Sierra Nevada Corporation','Valiant Integrated Services','AC Transit','Freeport-McMoRan','California Department of Corrections and Rehabilitation','Alutiiq','ManTech International','GDC','CACI International','IDS International','SOS International','ITC Defense','DataPath','SkyBridge Tactical','Amentum','American International Contractors','Anduril','APVI','ASRC Federal','Astrapi Advisors','Atlas Advisors','Bell Textron','BL Harbert International','CDAS','Dynamic Aviation','Fathom 4','GardaWorld','General Dynamics Information Technology','Group SSI','IAP','International SOS','Jacobs Technology','Leidos','Navmar Applied Science Corporation','Noblis','Olgoonik Solutions','Patriot Group International','Peraton','Platform Aerospace','Prüst Holding','S3 International','Strategic Solutions Unlimited','University of Maryland Global Campus','Vectrus','Versar Global Solutions','Westinghouse Electric Company'];
const COMPANY_DOMAINS: Record<string,string> = { Leidos:'leidos.com', 'IAP Worldwide Services':'iapws.com', 'MAG Aerospace':'magaero.com', 'Camber Corporation':'camber.com', 'Trace Systems':'tracesystems.com', KBR:'kbr.com', 'BAE Systems':'baesystems.com', 'Weatherford International':'weatherford.com', Versar:'versar.com', Constellis:'constellis.com', C3EL:'c3el.com', 'Fluor Corporation':'fluor.com', Clovehitch:'clovehitch.com', V2X:'v2x.com', 'Sierra Nevada Corporation':'sncorp.com', 'Valiant Integrated Services':'valiantintegrated.com', 'AC Transit':'actransit.org', 'Freeport-McMoRan':'fcx.com', Alutiiq:'alutiiq.com', 'ManTech International':'mantech.com', GDC:'gdc4s.com', 'CACI International':'caci.com', 'IDS International':'idsinternational.com', 'SOS International':'internationalsos.com', 'ITC Defense':'itcdefense.com', 'DataPath':'datapath.com', 'SkyBridge Tactical':'skybridgetactical.com', Amentum:'amentum.com', Anduril:'anduril.com', 'ASRC Federal':'asrcfederal.com', 'Bell Textron':'bellflight.com', 'Dynamic Aviation':'dynamicaviation.com', 'GardaWorld':'garda.com', 'General Dynamics Information Technology':'gdit.com', 'International SOS':'internationalsos.com', 'Jacobs Technology':'jacobs.com', Noblis:'noblis.org', Peraton:'peraton.com', Vectrus:'v2x.com', 'Westinghouse Electric Company':'westinghouse.com' };

const key = "insight-hub.company-watch.companies";
const timesKey = "insight-hub.company-watch.times";
const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function unique(names: string[]) {
  return [...new Map(names.map(name => [name.trim().toLowerCase(), name.trim()])).values()].filter(Boolean);
}
function ago(value: string | null) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}
type NewsSignal = "award" | "solicitation" | null;

/** Highlight only recent, explicit government procurement announcements in the existing feed.
 * This makes no API calls. An article mentioning a company is not proof it bid on a solicitation.
 */
function newsSignal(article: Article): NewsSignal {
  const date = article.publishedAt ? Date.parse(article.publishedAt) : NaN;
  if (!Number.isFinite(date) || date > Date.now() + 86400_000 || date < Date.now() - 7 * 86400_000) return null;
  const headline = article.title.toLowerCase();
  const full = (article.title + " " + article.snippet).toLowerCase();
  const government = /\b(?:federal|government|pentagon|department of defense|department of homeland security|dod|dhs|usaf|u\.?s\.?\s*(?:army|navy|air force|space force|marine corps|government)|military|defen[cs]e|sam\.gov|gsa|logcap|afcap|federal aviation administration|department of energy|department of state|department of veterans affairs|national aeronautics and space administration|nasa)\b/i.test(full);
  if (!government) return null;
  const denied = /\b(?:not awarded|fails? to win|lost (?:the |a )?(?:bid|contract)|protests? (?:an? )?award|award (?:protest|challenged|overturned))\b/i.test(full);
  // "awarded a $X contract" and "$X contract win" are both common headlines.
  // Require an actual contract/award context; generic corporate wins are not awards.
  if (!denied && /\b(?:awarded|wins?|won|secures?|receives?|lands?|selected for|award(?:ed|s)?|contract win|contractor selected)\b/i.test(headline)
    && /\b(?:contract|award|task order|delivery order|logcap|afcap)\b/i.test(full)) return "award";
  if (/\b(?:solicitation|request for proposals?|request for bids?|invitation to bid|rfp|recompete|re-competition|seeking bids|issues? (?:a |an )?(?:tender|solicitation))\b/i.test(headline)) return "solicitation";
  return null;
}

function CompanyImage({ name }: { name: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const domain = COMPANY_DOMAINS[name];
  return (
    <div className="relative flex aspect-[16/7] items-center justify-center overflow-hidden border-b border-white/15 bg-white">
      {!loaded && <span className="px-6 text-center text-4xl font-bold text-[#183a68]" aria-hidden="true">{name.split(/\s+/).slice(0, 2).map(part => part[0]).join("")}</span>}
      {domain && !failed && <img
        src={`${baseUrl}/api/company-watch/logo/${encodeURIComponent(domain)}?size=512`}
        alt={`${name} logo`}
        className={`absolute inset-0 h-full w-full object-contain p-7 ${loaded ? "opacity-100" : "opacity-0"}`}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />}
    </div>
  );
}

export default function CompanyWatchPage() {
  const [companies, setCompanies] = useState<Company[]>(() => {
    try {
      const saved = localStorage.getItem(key);
      const names: unknown = saved === null ? SEED : JSON.parse(saved);
      return unique(Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : SEED).map(name => ({ name }));
    } catch { return unique(SEED).map(name => ({ name })); }
  });
  const [add, setAdd] = useState("");
  const [selected, setSelected] = useState<Company | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [updated, setUpdated] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [times, setTimes] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(timesKey) || "null");
      return Array.isArray(saved) && saved.length === 2 && saved.every(time => typeof time === "string" && /^\d{2}:\d{2}$/.test(time)) ? saved : ["08:00", "16:00"];
    } catch { return ["08:00", "16:00"]; }
  });
  const [auto, setAuto] = useState(true);
  const [checks, setChecks] = useState<Record<string, CompanyCheck>>({});
  const [progress, setProgress] = useState<{ completed: number; total: number; company: string } | null>(null);
  const stopSearch = useRef(false);
  useEffect(() => () => { stopSearch.current = true; }, []);
  const lastAutomaticRun = useRef("");
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(companies.map(company => company.name))); } catch {} }, [companies]);
  useEffect(() => { try { localStorage.setItem(timesKey, JSON.stringify(times)); } catch {} }, [times]);

  const mutation = useMutation({
    mutationFn: async (names: string[]): Promise<void> => {
      stopSearch.current = false;
      setWarnings([]);
      let lastStarted = 0;
      for (let index = 0; index < names.length && !stopSearch.current; index++) {
        // Space starts to stay below TinyFish's default 30 requests/minute.
        const delay = 2_100 - (Date.now() - lastStarted);
        if (delay > 0) await new Promise(resolve => window.setTimeout(resolve, delay));
        if (stopSearch.current) break;
        const name = names[index];
        lastStarted = Date.now();
        setProgress({ completed: index, total: names.length, company: name });
        try {
          const response = await fetch(`${baseUrl}/api/company-watch/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ companies: [name] }),
            signal: AbortSignal.timeout(40_000),
          });
          const result: SearchResult & { error?: string } = await response.json();
          if (!response.ok) throw new Error(result.error || "Company news search failed");
          const providerResults = result.providers ?? [];
          const failed = providerResults.length > 0 && providerResults.every(provider => provider.status === "error");
          setChecks(previous => ({ ...previous, [name]: {
            updatedAt: failed ? previous[name]?.updatedAt ?? null : result.updatedAt,
            warnings: result.warnings ?? [], providers: providerResults,
          } }));
          setWarnings(previous => [...new Set([...previous, ...(result.warnings ?? [])])]);
          if (!failed) {
            setArticles(previous => {
              const merged = new Map<string, Article>();
              for (const article of previous) {
                const companyNames = (article.companyNames ?? []).filter(company => company !== name);
                if (companyNames.length) merged.set(article.url, { ...article, companyNames });
              }
              for (const article of result.articles) {
                const companyNames = [...new Set([...(merged.get(article.url)?.companyNames ?? []), name])];
                merged.set(article.url, { ...article, companyNames });
              }
              return [...merged.values()];
            });
            if (result.updatedAt) setUpdated(result.updatedAt);
          }
        } catch (error) {
          const message = error instanceof Error && error.name === "TimeoutError"
            ? "Search timed out. Try this company again." : error instanceof Error ? error.message : "Search failed.";
          setChecks(previous => ({ ...previous, [name]: { updatedAt: previous[name]?.updatedAt ?? null, warnings: [message], providers: ["tinyfish", "keenable", "gnews", "apitube"].map(name => ({ name, status: "error", count: 0, error: message })) } }));
          setWarnings(previous => [...new Set([...previous, `${name}: ${message}`])]);
        }
        setProgress({ completed: index + 1, total: names.length, company: name });
      }
      setProgress(null);
    },
  });
  useEffect(() => {
    if (!auto || !companies.length) return;
    const tick = () => {
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const slot = `${now.toDateString()} ${time}`;
      if (times.includes(time) && lastAutomaticRun.current !== slot && !mutation.isPending) {
        lastAutomaticRun.current = slot;
        mutation.mutate(companies.map(company => company.name));
      }
    };
    const interval = window.setInterval(tick, 10_000);
    return () => window.clearInterval(interval);
  }, [auto, times, companies.length, mutation]);
  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const addCompany = () => {
    if (add.trim()) setCompanies(unique([...companies.map(company => company.name), add]).map(name => ({ name })));
    setAdd("");
  };
  // Association is established by the per-company search response, not by
  // generic fragments such as "general", "systems", or "international".
  const matching = (name: string) =>
    articles.filter(article => article.companyNames?.includes(name));

  return (
    <div className="portal-readable space-y-7">
      <header>
        <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-primary">Company Intelligence</p>
        <h1 className="text-4xl font-bold tracking-tight text-white md:text-5xl">Company Watch</h1>
        <p className="mt-3 max-w-3xl text-lg leading-relaxed text-slate-200">Track contractor activity, awards, acquisitions, spending, facilities, and workforce news for the companies you choose.</p>
      </header>

      <section className="glass-card rounded-2xl border border-white/15 p-5">
        <div className="flex flex-col gap-3 lg:flex-row">
          <div className="flex min-w-0 flex-1 gap-2">
            <input aria-label="Add a company" value={add} onChange={event => setAdd(event.target.value)} onKeyDown={event => { if (event.key === "Enter") addCompany(); }} placeholder="Add a company to watch…" className="min-h-12 min-w-0 flex-1 rounded-xl border border-white/20 bg-black/20 px-4 text-base text-white outline-none focus:border-primary" />
            <button type="button" onClick={addCompany} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-primary px-4 text-base font-semibold text-[#09163a]"><Plus className="h-5 w-5" />Add</button>
          </div>
          <button type="button" onClick={() => mutation.mutate(companies.map(company => company.name))} disabled={mutation.isPending || !companies.length} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/15 px-5 text-base font-semibold text-white hover:bg-primary/25 disabled:opacity-50">
            {mutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Search className="h-5 w-5" />}{mutation.isPending ? "Searching…" : "Search Saved Companies"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/15 pt-4 text-base text-slate-200">
          <Clock3 className="h-5 w-5 text-primary" /><span>Automatic searches</span>
          {times.map((time, index) => <label key={index} className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2"><span className="sr-only">Search time {index + 1}</span><input type="time" value={time} onChange={event => setTimes(times.map((value, position) => position === index ? event.target.value : value))} className="bg-transparent text-white" /></label>)}
          <label className="ml-auto inline-flex items-center gap-2"><input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)} /> enabled</label>
        </div>
        <p className="mt-2 text-sm text-slate-300">Automatic searches run at these local times while this tab is open.</p>
      </section>

      <div className="flex flex-wrap items-center gap-3 text-base text-slate-200" aria-live="polite">
        <span className="font-semibold text-white">Search providers:</span>
        {["tinyfish", "keenable", "gnews", "apitube"].map(name => {
          const results = Object.values(checks).flatMap(check => check.providers).filter(provider => provider.name === name);
          const count = results.reduce((total, result) => total + result.count, 0);
          const failures = results.filter(result => result.status === "error").length;
          const disabled = results.length > 0 && results.every(result => result.status === "disabled");
          return <span key={name} className="rounded-full border border-white/20 bg-white/5 px-3 py-2">{name === "tinyfish" ? "TinyFish" : name === "keenable" ? "Keenable" : name === "gnews" ? "GNews" : "APITube"} · {disabled ? "Not configured" : results.length ? `${count} results${failures ? ` · ${failures} failed` : ""}` : "Ready"}</span>;
        })}
        {progress && <span role="status">{progress.completed}/{progress.total} checked · Searching {progress.company}…</span>}
        {mutation.isPending && <button type="button" onClick={() => { stopSearch.current = true; }} className="min-h-11 rounded-lg border border-white/20 px-3 text-white">Stop after this company</button>}
      </div>

      {mutation.isError && <div role="alert" className="flex gap-3 rounded-2xl border border-red-300/30 bg-red-950/60 p-5 text-base text-red-100"><CircleAlert className="h-5 w-5 shrink-0" /><span>{mutation.error instanceof Error ? mutation.error.message : "Company news search failed."}</span></div>}
      {warnings.length > 0 && <div role="status" className="rounded-2xl border border-amber-300/30 bg-amber-950/60 p-5 text-base text-amber-100">{warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}

      <div className="flex flex-wrap items-center justify-between gap-3 text-base text-slate-200" aria-live="polite">
        <span>{companies.length} companies watched{updated && ` · last search ${ago(updated)}`}</span>
        <button type="button" onClick={() => setCompanies([])} className="min-h-11 px-2 text-red-200 hover:text-white">Remove all</button>
      </div>

      <section aria-label="Watched companies" className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {companies.map(company => {
          const count = matching(company.name).length;
          const check = checks[company.name];
          const searching = mutation.isPending && progress?.company === company.name;
          return (
            <article key={company.name} className="glass-card relative min-w-0 overflow-hidden rounded-2xl border border-white/15 transition hover:border-primary/50">
              <button type="button" aria-label={`Remove ${company.name}`} onClick={() => setCompanies(companies.filter(item => item.name !== company.name))} className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-700 shadow hover:bg-red-50 hover:text-red-700"><X className="h-5 w-5" /></button>
              <button type="button" onClick={() => setSelected(company)} className="block w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                <CompanyImage name={company.name} />
                <div className="p-5">
                  <h2 className="ui-break-anywhere text-2xl font-semibold leading-snug text-white">{company.name}</h2>
                  <p className="mt-2 text-base text-slate-200">{check?.updatedAt ? "Last checked " + ago(check.updatedAt) : "Ready to search"}</p>
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/15 pt-4 text-base">
                    <span className="text-slate-200">{count ? `${count} relevant update${count === 1 ? "" : "s"}` : check?.warnings.length ? "Search needs retry" : check?.updatedAt ? "No news found in the past 7 days" : "Not searched yet"}</span>
                    <span className="font-semibold text-primary">View updates →</span>
                  </div>
                </div>
              </button>
              <div className="px-5 pb-5">
                <button type="button" aria-label={`Search news for ${company.name}`} onClick={() => mutation.mutate([company.name])} disabled={mutation.isPending} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/15 px-4 text-base font-semibold text-white hover:bg-primary/25 disabled:opacity-50">
                  {searching ? <Loader2 className="h-5 w-5 animate-spin" /> : <Search className="h-5 w-5" />}{searching ? "Searching…" : "Search this company"}
                </button>
              </div>
            </article>
          );
        })}
      </section>

      {selected && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="company-update-title" onClick={() => setSelected(null)}>
        <div className="max-h-[94dvh] w-full max-w-6xl overflow-y-auto rounded-3xl border border-white/20 bg-[#102447] p-6 shadow-2xl" onClick={event => event.stopPropagation()}>
          <div className="flex items-start justify-between gap-4">
            <div><h2 id="company-update-title" className="text-3xl font-bold text-white">{selected.name}</h2><p className="mt-2 text-base text-slate-200">{checks[selected.name]?.updatedAt ? `Last checked ${ago(checks[selected.name].updatedAt)}` : "Search this company to load current coverage."}</p></div>
            <button type="button" aria-label="Close company updates" onClick={() => setSelected(null)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/20 text-white hover:bg-white/10"><X className="h-5 w-5" /></button>
          </div>
          <button type="button" onClick={() => mutation.mutate([selected.name])} disabled={mutation.isPending} className="mt-4 inline-flex min-h-12 items-center gap-2 rounded-xl bg-primary px-5 text-base font-semibold text-[#09163a] disabled:opacity-50"><Search className="h-5 w-5" />{mutation.isPending ? "Searching…" : "Search this company"}</button>
          {checks[selected.name]?.warnings.map(warning => <p key={warning} role="status" className="mt-3 text-base text-amber-100">{warning}</p>)}
          {(["award", "solicitation"] as const).map(kind => {
            const relevant = matching(selected.name).filter(article => newsSignal(article) === kind);
            return (
              <section key={kind} aria-label={kind === "award" ? "New government contract award announcements" : "New government bidding announcements"} className="mt-6">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <h3 className="text-2xl font-bold text-white">{kind === "award" ? "New Contract Award Announcements" : "New Bidding & Solicitation Announcements"}</h3>
                  <span className="rounded-full border border-white/25 px-3 py-1 text-sm text-slate-200">{relevant.length} in the past 7 days</span>
                </div>
                <p className="mb-3 text-sm text-slate-300">{kind === "award"
                  ? "Recent news reporting government contract awards to this company. Awards may indicate future mobilization or hiring; the article is the source, not a verified procurement record."
                  : "Recent news mentioning solicitations related to this company. Appearance here does not establish that the company submitted a bid."}</p>
                {relevant.length ? <div className="grid gap-3 md:grid-cols-2">
                  {relevant.map(article => <article key={article.url} className="rounded-xl border border-primary/30 bg-[#183663] p-4">
                    <p className="text-sm text-slate-300">{article.publisher || "Source"} · {ago(article.publishedAt)}</p>
                    <h4 className="mt-2 text-lg font-semibold text-white">{article.title}</h4>
                    {article.snippet && <p className="mt-2 text-sm text-slate-200">{article.snippet}</p>}
                    <a href={article.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-2 text-primary">Read announcement <ExternalLink className="h-4 w-4" /></a>
                  </article>)}
                </div> : <p className="rounded-xl border border-dashed border-white/20 p-4 text-sm text-slate-300">No matching new announcements in the currently retrieved articles.</p>}
              </section>
            );
          })}
          <h3 className="mt-8 text-2xl font-bold text-white">All Company News</h3>
          <p className="mt-1 text-sm text-slate-300">The original four-provider news feed is preserved below, including articles highlighted above.</p>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            {matching(selected.name).map(article => <article key={article.id} className="overflow-hidden rounded-2xl border border-white/15 bg-[#152f59]">
              {article.image && <div className="aspect-[16/7] overflow-hidden bg-white/5"><img src={article.image} alt="" loading="lazy" className="h-full w-full object-cover" /></div>}
              <div className="p-5">
                <p className="text-sm text-slate-300">{article.publisher || "Source"} · {article.provider === "tinyfish" ? "TinyFish" : article.provider === "keenable" ? "Keenable" : article.provider === "gnews" ? "GNews" : "APITube"} · {ago(article.publishedAt)}</p>
                <h3 className="mt-3 text-xl font-semibold leading-snug text-white">{article.title}</h3>
                {article.snippet && <p className="mt-3 text-base leading-relaxed text-slate-200">{article.snippet}</p>}
                <a href={article.url} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-4 text-base font-semibold text-primary">Read source <ExternalLink className="h-4 w-4" /></a>
              </div>
            </article>)}
            {!matching(selected.name).length && <p className="rounded-2xl border border-dashed border-white/25 p-8 text-center text-base text-slate-200 md:col-span-2">No relevant updates loaded for this company yet.</p>}
          </div>
        </div>
      </div>}
    </div>
  );
}
