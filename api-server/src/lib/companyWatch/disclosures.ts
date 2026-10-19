import { coreCompanyName, newsVariants } from "./companyIdentity";
import { workspaceResult } from "../intelligence/workspaceResults";

type Row = Record<string, unknown>;
export type SourceStatus = "ok" | "no_match" | "ambiguous" | "not_configured" | "error";
export interface Issuer { cik: string; name: string; ticker: string }
export interface SecFiling { form: string; filedAt: string; reportDate: string | null; items: string | null; url: string }
export interface SecResult {
  status: SourceStatus; message: string; issuer: Issuer | null; filings: SecFiling[]; fetchedAt: string;
}
export interface FecTotals {
  cycle: number; receipts: number | null; disbursements: number | null; cashOnHand: number | null;
  coverageStart: string | null; coverageEnd: string | null;
}
export interface FecCommittee {
  id: string; name: string; affiliatedOrganization: string | null; type: string | null;
  match: "documented_affiliation" | "name_only"; url: string; totals: FecTotals[]; totalsWarning?: string;
}
export interface FecResult {
  status: SourceStatus; message: string; committees: FecCommittee[]; fetchedAt: string;
}

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const amount = (value: unknown): number | null => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = () => new Date().toISOString();

/** Exact legal-name equality only; no parent/subsidiary or short-acronym guesses. */
export function legalName(value: string): string {
  return value.replace(/\s*\/[A-Z]{2}\/$/i, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/(?:\s+(?:incorporated|inc|corporation|corp|llc|ltd|limited|plc|holdings|holding|group|company|co))+$/, "").trim();
}
function identityNames(company: string): Set<string> {
  return new Set(newsVariants(company).map(legalName));
}

export function parseIssuers(value: unknown): Issuer[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SEC returned an invalid issuer index");
  const issuers = Object.values(value).flatMap(value => {
    const item = row(value);
    const cik = String(item.cik_str ?? "");
    return /^\d{1,10}$/.test(cik) && text(item.title) && text(item.ticker)
      ? [{ cik: cik.padStart(10, "0"), name: text(item.title), ticker: text(item.ticker) }] : [];
  });
  if (!issuers.length) throw new Error("SEC returned an empty or invalid issuer index");
  return issuers;
}

export function matchIssuers(company: string, issuers: Issuer[]): Issuer[] {
  const names = identityNames(company);
  return [...new Map(issuers.filter(issuer => names.has(legalName(issuer.name))).map(issuer => [issuer.cik, issuer])).values()];
}

export function parseSecFilings(value: unknown, issuer: Issuer): SecResult {
  const data = row(value);
  const cik = String(data.cik ?? "").padStart(10, "0");
  if (cik !== issuer.cik || legalName(text(data.name)) !== legalName(issuer.name)) throw new Error("SEC issuer identity did not match the requested company");
  const recent = row(row(data.filings).recent);
  if (!Array.isArray(recent.form) || !Array.isArray(recent.accessionNumber) || !Array.isArray(recent.filingDate)) throw new Error("SEC returned invalid filing metadata");
  const forms = new Set(["10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "8-K/A", "20-F", "20-F/A", "6-K", "40-F"]);
  const filings = recent.form.flatMap((form, index): SecFiling[] => {
    if (!forms.has(String(form))) return [];
    const accession = text((recent.accessionNumber as unknown[])[index]);
    const document = text((Array.isArray(recent.primaryDocument) ? recent.primaryDocument : [])[index]);
    const filedAt = text((recent.filingDate as unknown[])[index]);
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession) || !/^\d{4}-\d{2}-\d{2}$/.test(filedAt)) return [];
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(issuer.cik)}/${accession.replace(/-/g, "")}/`;
    const url = document && /^[a-zA-Z0-9_.-]+$/.test(document) ? base + document : base + accession + "-index.html";
    return [{ form: String(form), filedAt, reportDate: text((Array.isArray(recent.reportDate) ? recent.reportDate : [])[index]) || null,
      items: text((Array.isArray(recent.items) ? recent.items : [])[index]) || null, url }];
  }).sort((a, b) => b.filedAt.localeCompare(a.filedAt)).slice(0, 12);
  return { status: "ok", message: "Exact issuer-name match in the SEC index; filing identity checked against its CIK.", issuer, filings, fetchedAt: timestamp() };
}

export function parseFecCommittees(value: unknown, company: string): FecCommittee[] {
  const data = row(value);
  if (!Array.isArray(data.results)) throw new Error("FEC returned invalid committee data");
  const names = identityNames(company);
  return data.results.flatMap((value): FecCommittee[] => {
    const item = row(value);
    const id = text(item.committee_id);
    const name = text(item.name);
    const affiliatedOrganization = text(item.affiliated_committee_name) || text(item.connected_organization_name) || null;
    const documented = affiliatedOrganization !== null && names.has(legalName(affiliatedOrganization));
    const stem = name.replace(/\s+(?:political action committee|political action fund|employee(?:s)? political action committee|PAC)\b.*$/i, "");
    const nameOnly = names.has(legalName(stem));
    if (!/^C\d{8}$/.test(id) || !name || (!documented && !nameOnly)) return [];
    return [{ id, name, affiliatedOrganization, type: text(item.committee_type_full) || null,
      match: documented ? "documented_affiliation" : "name_only", url: `https://www.fec.gov/data/committee/${id}/`, totals: [] }];
  }).slice(0, 3);
}

export function parseFecTotals(value: unknown): FecTotals[] {
  const data = row(value);
  if (!Array.isArray(data.results)) throw new Error("FEC returned invalid financial summaries");
  return data.results.flatMap(value => {
    const item = row(value);
    const cycle = Number(item.cycle);
    return Number.isInteger(cycle) && cycle >= 1976 ? [{ cycle, receipts: amount(item.receipts), disbursements: amount(item.disbursements),
      cashOnHand: amount(item.last_cash_on_hand_end_period ?? item.cash_on_hand_end_period),
      coverageStart: text(item.coverage_start_date) || null, coverageEnd: text(item.coverage_end_date) || null }] : [];
  }).sort((a, b) => b.cycle - a.cycle).slice(0, 2);
}

const TTL = 6 * 60 * 60_000;
let secNextStart = 0;
let fecNextStart = 0;
const cooldownUntil = { SEC: 0, FEC: 0 };
async function officialJson(url: URL, source: "SEC" | "FEC", headers: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
  if (Date.now() < cooldownUntil[source]) throw new Error(`${source} is cooling down after an upstream rate or access rejection`);
  // One shared queue per provider, below SEC's 10 requests/sec and OpenFEC's standard hourly allowance.
  const next = source === "SEC" ? secNextStart : fecNextStart;
  const start = Math.max(Date.now(), next);
  if (source === "SEC") secNextStart = start + 300; else fecNextStart = start + 4000;
  if (start > Date.now()) await new Promise(resolve => setTimeout(resolve, start - Date.now()));
  if (Date.now() < cooldownUntil[source]) throw new Error(`${source} is in cooldown`);
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) {
    if ([403, 429].includes(response.status)) cooldownUntil[source] = Date.now() + 10 * 60_000;
    throw new Error(`${source} returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchSecCompany(company: string, userAgent: string, refresh = false, fetchImpl: typeof fetch = fetch) {
  return workspaceResult<SecResult>("company-sec-v1", legalName(company), { ttlMs: TTL, refresh, load: async () => {
    const headers = { "User-Agent": userAgent, Accept: "application/json" };
    const index = await workspaceResult<{ issuers: Issuer[] }>("sec-issuer-index-v1", "listed-issuers", { ttlMs: 24 * 60 * 60_000,
      load: async () => ({ issuers: parseIssuers(await officialJson(new URL("https://www.sec.gov/files/company_tickers.json"), "SEC", headers, fetchImpl)) }) });
    const matches = matchIssuers(company, index.issuers);
    if (matches.length !== 1) return { status: matches.length ? "ambiguous" : "no_match", issuer: null, filings: [], fetchedAt: timestamp(),
      message: matches.length ? "Several SEC issuers match this name; no filings linked without a unique identity." : "No exact issuer-name match in the SEC listed-company index. Private companies and subsidiaries may not have a separate listed issuer." };
    const issuer = matches[0]!;
    return parseSecFilings(await officialJson(new URL(`https://data.sec.gov/submissions/CIK${issuer.cik}.json`), "SEC", headers, fetchImpl), issuer);
  } });
}

export async function fetchFecCompany(company: string, apiKey: string, refresh = false, fetchImpl: typeof fetch = fetch) {
  return workspaceResult<FecResult>("company-fec-v1", legalName(company), { ttlMs: TTL, refresh,
    usable: value => value.committees.every(committee => !committee.totalsWarning), load: async () => {
    const endpoint = (path: string, params: Record<string, string>) => {
      const url = new URL(path, "https://api.open.fec.gov/v1/");
      url.searchParams.set("api_key", apiKey);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url;
    };
    const data = await officialJson(endpoint("committees/", { q: coreCompanyName(company), per_page: "20", sort: "-last_file_date" }), "FEC", { Accept: "application/json" }, fetchImpl);
    const committees = parseFecCommittees(data, company);
    for (const committee of committees) {
      try { committee.totals = parseFecTotals(await officialJson(endpoint(`committee/${committee.id}/totals/`, { per_page: "2", sort: "-cycle" }), "FEC", { Accept: "application/json" }, fetchImpl)); }
      catch { committee.totalsWarning = "Committee identified, but financial summaries are temporarily unavailable."; }
    }
    return { status: committees.length ? "ok" : "no_match", committees, fetchedAt: timestamp(),
      message: committees.length ? "Showing up to three matching committees from the first 20 search results. These are committee finances, not direct corporate giving. Name-only matches are unconfirmed affiliations." : "No matching corporate committee found in the first 20 FEC search results; this does not establish that the company has no political activity." };
  } });
}
