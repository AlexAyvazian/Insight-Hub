/**
 * Background official-award collection for Company Watch. No paid news APIs are called here.
 *
 * Pass (every PASS_INTERVAL while the service is awake, also kicked by page requests when stale):
 *  1. DoD daily contract announcements: read the RSS feed, process each announcement page once (resumable via
 *     company_watch_sources), store every parsed award paragraph (company matching happens at read time, so a
 *     company added later still gets its recent awards).
 *  2. USAspending: for up to USASPENDING_BATCH watched companies whose last check is oldest, fetch newly signed
 *     contracts and keep only rows whose recipient is verifiably that company (resumable via company_watch_companies).
 * Each pass logs one `company_watch_award_pass` line with measured counts.
 */
import { companyKey } from "./companyIdentity";
import {
  companiesDueForCheck, ensureAwardStore, markCompanyChecked, markSourceProcessed, processedSources,
  recentAwards, recordRequestedCompanies, storeCounts, upsertAwards, type SqlRunner, type StoredAward,
} from "./awardStore";
import { buildCompanyLeads, type AwardLead } from "./awardLeads";
import { DOD_CONTRACTS_RSS, announcementDate, fetchText, parseAnnouncement, parseContractsRss } from "./dodContracts";
import { fetchUsaSpendingAwards } from "./usaSpendingAwards";

export const DEFAULT_COMPANY_WATCH_NAMES = [
  "Leidos",
  "IAP Worldwide Services",
  "MAG Aerospace",
  "Camber Corporation",
  "Trace Systems",
  "KBR",
  "BAE Systems",
  "Weatherford International",
  "Versar",
  "Constellis",
  "C3EL",
  "Fluor Corporation",
  "Clovehitch",
  "V2X",
  "Sierra Nevada Corporation",
  "Valiant Integrated Services",
  "AC Transit",
  "Freeport-McMoRan",
  "California Department of Corrections and Rehabilitation",
  "Alutiiq",
  "ManTech International",
  "GDC",
  "CACI International",
  "IDS International",
  "SOS International",
  "ITC Defense",
  "DataPath",
  "SkyBridge Tactical",
  "Amentum",
  "American International Contractors",
  "Anduril",
  "APVI",
  "ASRC Federal",
  "Astrapi Advisors",
  "Atlas Advisors",
  "Bell Textron",
  "BL Harbert International",
  "CDAS",
  "Dynamic Aviation",
  "Fathom 4",
  "GardaWorld",
  "General Dynamics Information Technology",
  "Group SSI",
  "IAP",
  "International SOS",
  "Jacobs Technology",
  "Navmar Applied Science Corporation",
  "Noblis",
  "Olgoonik Solutions",
  "Patriot Group International",
  "Peraton",
  "Platform Aerospace",
  "Prüst Holding",
  "S3 International",
  "Strategic Solutions Unlimited",
  "University of Maryland Global Campus",
  "Vectrus",
  "Versar Global Solutions",
  "Westinghouse Electric Company",
] as const;

/** Register the default UI roster on the server if no browser has registered any companies yet.
 * This is deliberately one-time: later page edits and custom watched companies take precedence.
 */
export async function bootstrapDefaultCompanyWatch(run: SqlRunner): Promise<number> {
  const rows = await run("SELECT count(*)::int AS registered FROM company_watch_companies");
  if (rows.length !== 1 || Number(rows[0]?.registered) !== 0) return 0;
  const unique = [...new Map(DEFAULT_COMPANY_WATCH_NAMES.map(name => [companyKey(name), name])).entries()]
    .map(([key, name]) => ({ key, name }));
  await recordRequestedCompanies(run, unique);
  return unique.length;
}

const PASS_INTERVAL_MS = 3 * 3_600_000;
const FIRST_PASS_DELAY_MS = 4 * 60_000;
const USASPENDING_BATCH = 15;
const USASPENDING_SPACING_MS = 1_500;

export interface AwardPassSummary {
  startedAt: string;
  finishedAt: string | null;
  bootstrappedCompanies?: number;
  dod: { status: string; feedItems: number; pagesProcessed: number; pagesSkipped: number; awardsParsed: number; newAwards: number; errors: string[] };
  usaspending: { companies: number; rows: number; matched: number; newAwards: number; rejectedRecipients: number; errors: string[] };
}

let lastPass: AwardPassSummary | null = null;
let running: Promise<AwardPassSummary> | null = null;
let timer: NodeJS.Timeout | null = null;

async function defaultRunner(): Promise<SqlRunner> {
  const { rfpPool } = await import("@workspace/db");
  return async (text, params = []) => (await rfpPool.query(text, params)).rows as Array<Record<string, unknown>>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export async function runDodPass(run: SqlRunner, summary: AwardPassSummary, fetchImpl: typeof fetch = fetch): Promise<void> {
  const feed = await fetchText(DOD_CONTRACTS_RSS, 25_000, fetchImpl);
  if (!feed.ok) { summary.dod.status = `feed HTTP ${feed.status}`; return; }
  const items = parseContractsRss(feed.text);
  summary.dod.feedItems = items.length;
  summary.dod.status = items.length ? "ok" : "feed returned no items";
  const done = await processedSources(run, items.map(item => item.link));
  for (const item of items) {
    if (done.has(item.link)) { summary.dod.pagesSkipped++; continue; }
    const date = announcementDate(item.title, item.pubDate);
    try {
      let awards = parseAnnouncement(item.description, item.link, date);
      if (!awards.length) {
        const page = await fetchText(item.link, 25_000, fetchImpl);
        if (!page.ok) {
          summary.dod.errors.push(`${item.link}: HTTP ${page.status}`);
          await markSourceProcessed(run, item.link, 0, `HTTP ${page.status}`);
          // A global WAF block or rate limit affects every article, not just this one.
          // Do not hammer remaining links or report a falsely healthy source.
          if (page.status === 403 || page.status === 429) {
            summary.dod.status = `blocked: HTTP ${page.status}`;
            break;
          }
          continue;
        }
        awards = parseAnnouncement(page.text, item.link, date);
      }
      summary.dod.awardsParsed += awards.length;
      summary.dod.newAwards += await upsertAwards(run, awards);
      summary.dod.pagesProcessed++;
      // A page with no parseable paragraph is recorded but retried next pass (status is not "ok").
      await markSourceProcessed(run, item.link, awards.length, awards.length ? "ok" : "no award paragraphs parsed");
    } catch (error) {
      summary.dod.errors.push(`${item.link}: ${errorText(error)}`);
    }
  }
}

export async function runUsaSpendingPass(run: SqlRunner, summary: AwardPassSummary, fetchImpl: typeof fetch = fetch, spacingMs = USASPENDING_SPACING_MS): Promise<void> {
  const due = await companiesDueForCheck(run, USASPENDING_BATCH);
  for (const [index, company] of due.entries()) {
    if (index > 0) await sleep(spacingMs);
    try {
      const result = await fetchUsaSpendingAwards(company.name, new Date(), fetchImpl);
      summary.usaspending.companies++;
      summary.usaspending.rows += result.rows;
      summary.usaspending.matched += result.awards.length;
      summary.usaspending.rejectedRecipients += result.rejectedRecipients.length;
      summary.usaspending.newAwards += await upsertAwards(run, result.awards);
      await markCompanyChecked(run, company.key, `${result.status}; ${result.rows} rows, ${result.awards.length} verified`);
    } catch (error) {
      summary.usaspending.errors.push(`${company.name}: ${errorText(error)}`);
      await markCompanyChecked(run, company.key, `error: ${errorText(error)}`).catch(() => undefined);
    }
  }
}

export async function runAwardPass(runner?: SqlRunner, fetchImpl: typeof fetch = fetch): Promise<AwardPassSummary> {
  if (running) return running;
  running = (async () => {
    const summary: AwardPassSummary = {
      startedAt: new Date().toISOString(), finishedAt: null,
      dod: { status: "not run", feedItems: 0, pagesProcessed: 0, pagesSkipped: 0, awardsParsed: 0, newAwards: 0, errors: [] },
      usaspending: { companies: 0, rows: 0, matched: 0, newAwards: 0, rejectedRecipients: 0, errors: [] },
    };
    try {
      const run = runner ?? await defaultRunner();
      await ensureAwardStore(run);
      summary.bootstrappedCompanies = await bootstrapDefaultCompanyWatch(run).catch(error => {
        summary.usaspending.errors.push(`watchlist bootstrap: ${errorText(error)}`);
        return 0;
      });
      await runDodPass(run, summary, fetchImpl).catch(error => { summary.dod.status = `error: ${errorText(error)}`; });
      await runUsaSpendingPass(run, summary, fetchImpl).catch(error => { summary.usaspending.errors.push(errorText(error)); });
    } catch (error) {
      summary.dod.errors.push(`store: ${errorText(error)}`);
    }
    summary.finishedAt = new Date().toISOString();
    lastPass = summary;
    console.log(JSON.stringify({ event: "company_watch_award_pass", ...summary, dod: { ...summary.dod, errors: summary.dod.errors.slice(0, 5) }, usaspending: { ...summary.usaspending, errors: summary.usaspending.errors.slice(0, 5) } }));
    return summary;
  })().finally(() => { running = null; });
  return running;
}

/** Kicks a pass in the background when the last one is older than the interval (page loads after the app wakes). */
export function kickAwardPassIfStale(): void {
  const last = lastPass ? Date.parse(lastPass.startedAt) : 0;
  if (!running && Date.now() - last > PASS_INTERVAL_MS) void runAwardPass();
}

export function startCompanyAwardWatcher(): void {
  if (timer || process.env.COMPANY_WATCH_AWARDS_DISABLED === "true") return;
  setTimeout(() => void runAwardPass(), FIRST_PASS_DELAY_MS).unref();
  timer = setInterval(() => void runAwardPass(), PASS_INTERVAL_MS);
  timer.unref();
}

export function lastAwardPass(): AwardPassSummary | null {
  return lastPass;
}

/** Official awards already in Insight Hub's opportunities table (SAM.gov / USAspending rows that name an awardee). */
export async function opportunityAwards(run: SqlRunner, days = 30): Promise<StoredAward[]> {
  const rows = await run(
    `SELECT id, title, agency, sub_agency, awardee, award_amount, posted_date, sam_url, place_of_performance,
            provider_name, solicitation_number, notice_id, first_seen_at
       FROM opportunities
      WHERE awardee IS NOT NULL AND btrim(awardee) <> '' AND posted_date >= now() - make_interval(days => $1)
      ORDER BY posted_date DESC LIMIT 2000`,
    [days],
  );
  return rows.map(row => {
    const amount = row.award_amount === null || row.award_amount === undefined ? null : Number(row.award_amount);
    const posted = row.posted_date instanceof Date ? row.posted_date.toISOString() : String(row.posted_date ?? "");
    return {
      awardKey: `opportunity:${String(row.id)}`,
      source: "insight_hub_opportunity" as const,
      recipientText: String(row.awardee),
      recipientUei: null,
      awardingAgency: [row.agency, row.sub_agency].filter(Boolean).map(String).join(" — ") || null,
      amount: amount !== null && Number.isFinite(amount) ? amount : null,
      contractNumber: row.solicitation_number ? String(row.solicitation_number) : null,
      modification: null,
      actionDate: posted.slice(0, 10) || null,
      workLocation: row.place_of_performance ? String(row.place_of_performance) : null,
      popCountry: null,
      description: String(row.title ?? ""),
      sourceUrl: row.sam_url ? String(row.sam_url) : null,
      completionDate: null,
      firstSeenAt: row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : String(row.first_seen_at ?? posted),
    };
  });
}

export interface CompanyAwardsResponse {
  companies: Record<string, AwardLead[]>;
  totals: { companies: number; leads: number; newlyDetected: number; confirmed: number; incumbent: number; possible: number };
  lastPass: AwardPassSummary | null;
  warnings: string[];
  generatedAt: string;
}

export async function companyAwards(names: string[], runner?: SqlRunner): Promise<CompanyAwardsResponse> {
  const warnings: string[] = [];
  const run = runner ?? await defaultRunner();
  await ensureAwardStore(run);
  const unique = [...new Map(names.map((name): [string, string] => [companyKey(name), name.trim()])).entries()].map(([key, name]) => ({ key, name }));
  await recordRequestedCompanies(run, unique);
  const stored = await recentAwards(run);
  const fromOpportunities = await opportunityAwards(run).catch(error => {
    warnings.push(`Insight Hub opportunity awards unavailable: ${errorText(error)}`);
    return [] as StoredAward[];
  });
  const all = [...stored, ...fromOpportunities];
  const companies: Record<string, AwardLead[]> = {};
  for (const { name } of unique) companies[name] = buildCompanyLeads(name, all);
  const leads = Object.values(companies).flat();
  return {
    companies,
    totals: {
      companies: unique.length,
      leads: leads.length,
      newlyDetected: leads.filter(lead => lead.newlyDetected).length,
      confirmed: leads.filter(lead => lead.attribution === "confirmed_awardee").length,
      incumbent: leads.filter(lead => lead.attribution === "documented_incumbent").length,
      possible: leads.filter(lead => lead.attribution === "possible_match").length,
    },
    lastPass,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

export async function awardStatus(runner?: SqlRunner): Promise<{ store: Record<string, unknown>; lastPass: AwardPassSummary | null; running: boolean }> {
  const run = runner ?? await defaultRunner();
  await ensureAwardStore(run);
  return { store: await storeCounts(run), lastPass, running: Boolean(running) };
}
