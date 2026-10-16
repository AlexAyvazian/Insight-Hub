/**
 * Quota-free read model for the Forecasts and Recompete Watch portals.
 * Uses the SAM.gov notices and verified government awards ALREADY imported into
 * Insight Hub's RFP Neon database. No SAM.gov, news, or commercial API requests.
 *
 * A SAM presolicitation / sources-sought notice is NOT an agency forecast.
 * An expiring official award is NOT proof of a forthcoming recompete.
 * Both labels are deliberately explicit to prevent false procurement claims.
 */
import type { SqlRunner } from "../companyWatch/awardStore";

type Row = Record<string, unknown>;
const DAY = 86_400_000;
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : v instanceof Date ? v.toISOString() : null;
const number = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const date = (v: unknown): string | null => {
  const value = text(v);
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};
const http = (v: unknown): string | null => {
  try { const url = new URL(text(v) ?? ""); return /^https?:$/.test(url.protocol) ? url.href : null; }
  catch { return null; }
};
const emptyContact = { name: null, email: null, phone: null } as const;

export const SAM_EARLY_NOTICE_SQL = `SELECT id, notice_id, title, agency, sub_agency, description, type, naics_code,
    set_aside, place_of_performance, posted_date, response_deadline, sam_url
  FROM opportunities
  WHERE (provider_key = 'samGov' OR provider_name ILIKE 'samGov%' OR source = 'sam_gov')
    AND status = 'active'
    AND (type ILIKE '%presolicitation%' OR type ILIKE '%sources sought%' OR type ILIKE '%source sought%')
    AND (response_deadline IS NULL OR response_deadline >= CURRENT_DATE)
    AND posted_date >= now() - interval '270 days'
  ORDER BY posted_date DESC LIMIT 400`;

export const EXPIRING_OFFICIAL_AWARDS_SQL = `SELECT award_key, source, recipient_text, awarding_agency, amount,
    contract_number, action_date, work_location, description, source_url, completion_date
  FROM company_watch_awards
  WHERE source IN ('usaspending', 'dod_contract_announcement')
    AND recipient_text <> '' AND completion_date IS NOT NULL
  ORDER BY last_seen_at DESC LIMIT 3000`;

export interface LocalOfficialSignals {
  records: Array<Record<string, unknown>>;
  errors: string[];
}

/** These records are early-market signals, never mislabeled as formal acquisition forecasts. */
export function normalizeSamEarlyNotice(row: Row, now = Date.now()): Record<string, unknown> | null {
  const title = text(row.title), id = text(row.id);
  if (!title || !id) return null;
  const deadline = date(row.response_deadline);
  if (deadline && Date.parse(deadline) + DAY <= now) return null;
  const noticeType = text(row.type) ?? "";
  if (!/presolicitation|sources? sought/i.test(noticeType)) return null;
  const description = text(row.description);
  return {
    id: "sam-early:" + id, source: "sam.gov early notice", sourceId: text(row.notice_id) ?? id,
    title, agency: text(row.agency) ?? "Federal agency", subAgency: text(row.sub_agency),
    description: "SAM.gov " + noticeType + " (early procurement signal; not a formal agency acquisition forecast)." +
      (description ? " " + description : ""),
    naics: text(row.naics_code), setAside: text(row.set_aside), state: null,
    placeOfPerformance: text(row.place_of_performance), valueRangeText: null,
    valueLow: null, valueHigh: null, estimatedSolicitationDate: null,
    estimatedAwardFiscalYear: null, estimatedAwardQuarter: null,
    status: "anticipated early notice", isRecompete: false, recompeteEvidence: "none",
    incumbentName: null, incumbentAward: null, pointOfContact: { ...emptyContact },
    sourceUrl: http(row.sam_url), lastUpdatedDate: date(row.posted_date),
  };
}

/** Recompete CANDIDATE only: a named official incumbent and a documented future contract end date. */
export function normalizeExpiringAward(row: Row, now = Date.now()): Record<string, unknown> | null {
  const name = text(row.recipient_text);
  const expiry = date(row.completion_date);
  const id = text(row.award_key);
  if (!name || !expiry || !id) return null;
  const ms = Date.parse(expiry);
  if (!Number.isFinite(ms) || ms < now - 30 * DAY || ms > now + 730 * DAY) return null;
  const agency = text(row.awarding_agency) ?? "Federal agency";
  const contract = text(row.contract_number);
  const description = text(row.description) ?? (contract ? "Contract " + contract : "Federal contract");
  const title = description.length > 150 ? description.slice(0, 147) + "..." : description;
  const source = text(row.source) === "usaspending" ? "USAspending" : "DoD official award";
  const amount = number(row.amount);
  return {
    id: "official-expiring:" + id, source, sourceId: contract ?? id,
    title, agency, subAgency: null,
    description: "Potential recompete signal: official record names " + name +
      " as incumbent and lists contract completion " + expiry +
      ". A rebid or solicitation has NOT been confirmed. " + description,
    naics: null, setAside: null, state: null, placeOfPerformance: text(row.work_location),
    valueRangeText: null, valueLow: amount, valueHigh: amount,
    estimatedSolicitationDate: null, estimatedAwardFiscalYear: null, estimatedAwardQuarter: null,
    status: "potential recompete", isRecompete: true, recompeteEvidence: "incumbent-award",
    incumbentName: name, incumbentAward: {
      recipientName: name, currentValue: amount, expires: expiry,
      awardingAgency: agency, latestActionDate: date(row.action_date),
    },
    pointOfContact: { ...emptyContact }, sourceUrl: http(row.source_url),
    lastUpdatedDate: date(row.action_date),
  };
}

export async function loadLocalOfficialSignals(
  mode: "forecast" | "recompete",
  runner?: SqlRunner,
  now = Date.now(),
): Promise<LocalOfficialSignals> {
  let run = runner;
  if (!run) {
    const { rfpPool } = await import("@workspace/db");
    run = async (sql, args = []) => (await rfpPool.query(sql, args)).rows as Row[];
  }
  try {
    const rows = await run(mode === "forecast" ? SAM_EARLY_NOTICE_SQL : EXPIRING_OFFICIAL_AWARDS_SQL);
    const records = rows.map(row => mode === "forecast" ? normalizeSamEarlyNotice(row, now) : normalizeExpiringAward(row, now))
      .filter((record): record is Record<string, unknown> => Boolean(record));
    return { records, errors: [] };
  } catch {
    // An uninitialized table should never take the other free/paid providers offline.
    return { records: [], errors: ["Local official " + (mode === "forecast" ? "SAM.gov notices" : "awards") + " not available in Neon"] };
  }
}
