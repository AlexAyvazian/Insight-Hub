/**
 * Neon storage for Company Watch official awards (RFP database, the app's always-configured database).
 *
 *  company_watch_awards     one row per official award record, keyed by its stable award key; first_seen_at is set
 *                           once and never changed, so "newly detected" is a fact about when Insight Hub found it.
 *  company_watch_companies  the companies the Company Watch page asked about, and when each was last checked
 *                           against USAspending (the resumable cursor for the background pass).
 *  company_watch_sources    official announcement pages already processed (DoD daily contract pages).
 *
 * The SQL runner is injectable so tests exercise these statements without a database.
 */
import type { OfficialAward } from "./officialAward";

export type SqlRunner = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export const AWARD_STORE_DDL = [
  `CREATE TABLE IF NOT EXISTS company_watch_awards (
     award_key text PRIMARY KEY,
     source text NOT NULL,
     recipient_text text NOT NULL,
     recipient_uei text,
     awarding_agency text,
     amount numeric,
     contract_number text,
     modification boolean,
     action_date date,
     work_location text,
     pop_country text,
     description text NOT NULL DEFAULT '',
     source_url text,
     completion_date text,
     first_seen_at timestamptz NOT NULL DEFAULT now(),
     last_seen_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS company_watch_awards_recent_idx ON company_watch_awards (action_date DESC, first_seen_at DESC)`,
  `CREATE TABLE IF NOT EXISTS company_watch_companies (
     company_key text PRIMARY KEY,
     name text NOT NULL,
     last_requested_at timestamptz NOT NULL DEFAULT now(),
     last_award_check_at timestamptz,
     last_award_check_status text
   )`,
  `CREATE TABLE IF NOT EXISTS company_watch_sources (
     source_key text PRIMARY KEY,
     processed_at timestamptz NOT NULL DEFAULT now(),
     item_count integer NOT NULL DEFAULT 0,
     status text NOT NULL
   )`,
];

let ensured: Promise<void> | null = null;
export function ensureAwardStore(run: SqlRunner): Promise<void> {
  if (!ensured) {
    ensured = (async () => { for (const statement of AWARD_STORE_DDL) await run(statement); })().catch(error => {
      ensured = null;
      throw error;
    });
  }
  return ensured;
}

export const UPSERT_AWARD_SQL = `INSERT INTO company_watch_awards
  (award_key, source, recipient_text, recipient_uei, awarding_agency, amount, contract_number, modification, action_date,
   work_location, pop_country, description, source_url, completion_date)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14)
  ON CONFLICT (award_key) DO UPDATE SET last_seen_at = now(),
    recipient_uei = COALESCE(company_watch_awards.recipient_uei, EXCLUDED.recipient_uei)
  RETURNING (xmax = 0) AS inserted`;

/** Upserts; returns how many were new (first seen now). Existing rows keep their first_seen_at. */
export async function upsertAwards(run: SqlRunner, awards: OfficialAward[]): Promise<number> {
  let inserted = 0;
  for (const award of awards) {
    const rows = await run(UPSERT_AWARD_SQL, [
      award.awardKey, award.source, award.recipientText, award.recipientUei, award.awardingAgency, award.amount,
      award.contractNumber, award.modification, award.actionDate, award.workLocation, award.popCountry,
      award.description, award.sourceUrl, award.completionDate,
    ]);
    if (rows[0]?.inserted === true) inserted++;
  }
  return inserted;
}

export interface StoredAward extends OfficialAward {
  firstSeenAt: string;
}

/** Recent official awards: action date in the last `actionDays`, or first detected in the last `seenDays`. */
export const RECENT_AWARDS_SQL = `SELECT * FROM company_watch_awards
  WHERE action_date >= (now() - make_interval(days => $1))::date OR first_seen_at >= now() - make_interval(days => $2)
  ORDER BY COALESCE(action_date, first_seen_at::date) DESC, first_seen_at DESC LIMIT 5000`;

const text = (value: unknown): string | null => (value === null || value === undefined || value === "" ? null : String(value));
const isoDay = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return text(value)?.slice(0, 10) ?? null;
};

export function rowToAward(row: Record<string, unknown>): StoredAward {
  const amount = row.amount === null || row.amount === undefined ? null : Number(row.amount);
  return {
    awardKey: String(row.award_key),
    source: String(row.source) as OfficialAward["source"],
    recipientText: String(row.recipient_text ?? ""),
    recipientUei: text(row.recipient_uei),
    awardingAgency: text(row.awarding_agency),
    amount: amount !== null && Number.isFinite(amount) ? amount : null,
    contractNumber: text(row.contract_number),
    modification: typeof row.modification === "boolean" ? row.modification : null,
    actionDate: isoDay(row.action_date),
    workLocation: text(row.work_location),
    popCountry: text(row.pop_country),
    description: String(row.description ?? ""),
    sourceUrl: text(row.source_url),
    completionDate: text(row.completion_date),
    firstSeenAt: row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : String(row.first_seen_at ?? ""),
  };
}

export async function recentAwards(run: SqlRunner, actionDays = 30, seenDays = 14): Promise<StoredAward[]> {
  return (await run(RECENT_AWARDS_SQL, [actionDays, seenDays])).map(rowToAward);
}

export async function recordRequestedCompanies(run: SqlRunner, companies: Array<{ key: string; name: string }>): Promise<void> {
  if (!companies.length) return;
  await run(
    `INSERT INTO company_watch_companies (company_key, name, last_requested_at)
     SELECT * , now() FROM unnest($1::text[], $2::text[])
     ON CONFLICT (company_key) DO UPDATE SET name = EXCLUDED.name, last_requested_at = now()`,
    [companies.map(company => company.key), companies.map(company => company.name)],
  );
}

/** Companies due for a USAspending check: requested in the last 30 days, oldest check first (resumable). */
export async function companiesDueForCheck(run: SqlRunner, limit: number, minHoursBetweenChecks = 20): Promise<Array<{ key: string; name: string }>> {
  const rows = await run(
    `SELECT company_key, name FROM company_watch_companies
     WHERE last_requested_at >= now() - interval '30 days'
       AND (last_award_check_at IS NULL OR last_award_check_at < now() - make_interval(hours => $2))
     ORDER BY last_award_check_at ASC NULLS FIRST, company_key LIMIT $1`,
    [limit, minHoursBetweenChecks],
  );
  return rows.map(row => ({ key: String(row.company_key), name: String(row.name) }));
}

export async function markCompanyChecked(run: SqlRunner, key: string, status: string): Promise<void> {
  await run(`UPDATE company_watch_companies SET last_award_check_at = now(), last_award_check_status = $2 WHERE company_key = $1`, [key, status.slice(0, 300)]);
}

export async function processedSources(run: SqlRunner, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await run(`SELECT source_key FROM company_watch_sources WHERE source_key = ANY($1::text[]) AND status = 'ok'`, [keys]);
  return new Set(rows.map(row => String(row.source_key)));
}

export async function markSourceProcessed(run: SqlRunner, key: string, itemCount: number, status: string): Promise<void> {
  await run(
    `INSERT INTO company_watch_sources (source_key, item_count, status) VALUES ($1, $2, $3)
     ON CONFLICT (source_key) DO UPDATE SET processed_at = now(), item_count = EXCLUDED.item_count, status = EXCLUDED.status`,
    [key, itemCount, status.slice(0, 300)],
  );
}

export async function storeCounts(run: SqlRunner): Promise<Record<string, unknown>> {
  const [row] = await run(`SELECT
      (SELECT count(*) FROM company_watch_awards)::int AS awards,
      (SELECT count(*) FROM company_watch_awards WHERE source = 'dod_contract_announcement')::int AS dod_awards,
      (SELECT count(*) FROM company_watch_awards WHERE source = 'usaspending')::int AS usaspending_awards,
      (SELECT count(*) FROM company_watch_awards WHERE first_seen_at >= now() - interval '24 hours')::int AS first_seen_24h,
      (SELECT max(action_date) FROM company_watch_awards)::text AS latest_action_date,
      (SELECT count(*) FROM company_watch_companies)::int AS companies,
      (SELECT count(*) FROM company_watch_companies WHERE last_award_check_at IS NOT NULL)::int AS companies_checked,
      (SELECT count(*) FROM company_watch_sources WHERE status = 'ok')::int AS sources_processed`);
  return row ?? {};
}
