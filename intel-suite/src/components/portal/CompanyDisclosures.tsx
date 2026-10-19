import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCcw } from "lucide-react";

type Source = { status: string; message: string; fetchedAt?: string; stale?: boolean; savedAt?: string; refreshWarning?: string; persistenceWarning?: string };
type Sec = Source & { issuer?: { cik: string; name: string; ticker: string } | null;
  filings?: Array<{ form: string; filedAt: string; reportDate: string | null; items: string | null; url: string }> };
type Fec = Source & { committees?: Array<{ id: string; name: string; affiliatedOrganization: string | null; type: string | null;
  match: string; url: string; totalsWarning?: string; totals: Array<{ cycle: number; receipts: number | null; disbursements: number | null;
    cashOnHand: number | null; coverageStart: string | null; coverageEnd: string | null }> }> };
type Result = { company: string; sec: Sec; fec: Fec };
const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const formLabel: Record<string, string> = { "10-K": "Annual report", "10-Q": "Quarterly report", "8-K": "Current report", "20-F": "Foreign issuer annual report", "6-K": "Foreign issuer report", "40-F": "Annual report" };
const date = (value?: string | null) => value ? value.slice(0, 10) : "Not reported";
const money = (value: number | null) => value === null ? "Not reported" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);

function SourceNotice({ source }: { source: Source }) {
  return <>
    <p className={`mt-2 text-sm ${source.status === "error" || source.status === "not_configured" ? "text-amber-100" : "text-slate-300"}`}>{source.message}</p>
    {source.fetchedAt && <p className="mt-1 text-xs text-slate-400">Last checked {new Date(source.fetchedAt).toLocaleString()}</p>}
    {(source.refreshWarning || source.persistenceWarning) && <p role="status" className="mt-2 text-sm text-amber-100">{source.refreshWarning} {source.persistenceWarning}</p>}
  </>;
}

export function CompanyDisclosures({ company }: { company: string }) {
  const forceRefresh = useRef(false);
  const query = useQuery({
    queryKey: ["company-disclosures", company],
    queryFn: async ({ signal }): Promise<Result> => {
      const params = new URLSearchParams({ company });
      if (forceRefresh.current) params.set("refresh", "true");
      const response = await fetch(`${baseUrl}/api/company-watch/disclosures?${params}`, { signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Official company records could not be loaded.");
      return payload;
    },
    staleTime: 6 * 60 * 60_000,
    // Previous-company placeholder data must never be presented as this company's official records.
    placeholderData: undefined,
    retry: 1,
  });
  const refresh = async () => {
    forceRefresh.current = true;
    try { await query.refetch(); } finally { forceRefresh.current = false; }
  };
  const { sec, fec } = query.data ?? {};
  return <section aria-label="Official SEC and FEC records" className="mt-6 border-t border-white/15 pt-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-2xl font-bold text-white">Company Filings &amp; Committee Records</h3>
      <button type="button" onClick={() => void refresh()} disabled={query.isFetching} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-white/20 px-3 text-sm text-white disabled:opacity-50">
        <RefreshCcw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />Refresh official records
      </button>
    </div>
    <p className="mt-2 text-sm text-slate-300">Official company context from SEC EDGAR and FEC. These records do not establish a contract award or demand for Occu-Med services.</p>
    {query.isLoading && <p role="status" className="mt-4 flex items-center gap-2 text-slate-200"><Loader2 className="h-4 w-4 animate-spin" />Loading official records…</p>}
    {query.isError && <p role="alert" className="mt-4 text-amber-100">{query.error instanceof Error ? query.error.message : "Official records are temporarily unavailable."}</p>}
    {sec && <section aria-label="SEC company filings" className="mt-4 rounded-xl border border-white/15 bg-black/15 p-4">
      <h4 className="text-xl font-semibold text-white">SEC EDGAR Filings</h4>
      <p className="mt-1 text-sm text-slate-400">Up to 12 recent annual, quarterly and current reports.</p>
      <SourceNotice source={sec} />
      {sec.issuer && <p className="mt-3 font-semibold text-slate-100">{sec.issuer.name} · {sec.issuer.ticker} · CIK {sec.issuer.cik}</p>}
      {sec.filings?.length ? <ul className="mt-3 divide-y divide-white/10">
        {sec.filings.map(filing => <li key={filing.url} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><p className="font-semibold text-white">{filing.form} · {formLabel[filing.form.replace(/\/A$/, "")] ?? "Company filing"}</p>
            <p className="mt-1 text-sm text-slate-300">Filed {date(filing.filedAt)}{filing.reportDate ? ` · Report date ${date(filing.reportDate)}` : ""}{filing.items ? ` · Items ${filing.items}` : ""}</p></div>
          <a href={filing.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 text-primary">Read filing <ExternalLink className="h-4 w-4" /></a>
        </li>)}
      </ul> : sec.status === "ok" && <p className="mt-3 text-slate-300">No annual, quarterly or current reports in the returned recent filing history.</p>}
    </section>}
    {fec && <section aria-label="FEC committee records" className="mt-4 rounded-xl border border-white/15 bg-black/15 p-4">
      <h4 className="text-xl font-semibold text-white">FEC Committee Financial Summaries</h4>
      <SourceNotice source={fec} />
      {fec.committees?.map(committee => <article key={committee.id} className="mt-4 rounded-xl border border-white/15 p-4">
        <h5 className="text-lg font-semibold text-white">{committee.name}</h5>
        <p className="mt-1 text-sm text-slate-300">{committee.id}{committee.type ? ` · ${committee.type}` : ""}</p>
        <p className={`mt-2 text-sm ${committee.match === "documented_affiliation" ? "text-emerald-200" : "text-amber-100"}`}>{committee.match === "documented_affiliation"
          ? `FEC lists the affiliated organization as ${committee.affiliatedOrganization}.`
          : "Name match only. Corporate affiliation has not been confirmed by the returned FEC record."}</p>
        {committee.totalsWarning && <p className="mt-2 text-sm text-amber-100">{committee.totalsWarning}</p>}
        {committee.totals.map(totals => <div key={totals.cycle} className="mt-3 border-t border-white/10 pt-3">
          <p className="font-semibold text-slate-100">{totals.cycle} election cycle</p>
          <p className="mt-1 text-sm text-slate-400">Reporting coverage: {date(totals.coverageStart)} to {date(totals.coverageEnd)}</p>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
            <div><dt className="text-slate-400">Committee receipts</dt><dd className="font-semibold text-white">{money(totals.receipts)}</dd></div>
            <div><dt className="text-slate-400">Committee disbursements</dt><dd className="font-semibold text-white">{money(totals.disbursements)}</dd></div>
            <div><dt className="text-slate-400">Cash on hand</dt><dd className="font-semibold text-white">{money(totals.cashOnHand)}</dd></div>
          </dl>
        </div>)}
        {!committee.totals.length && !committee.totalsWarning && <p className="mt-3 text-sm text-slate-300">No financial summary returned for this committee.</p>}
        <a href={committee.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-2 text-primary">View FEC record <ExternalLink className="h-4 w-4" /></a>
      </article>)}
    </section>}
  </section>;
}
