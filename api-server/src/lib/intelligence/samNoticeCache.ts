/**
 * Sidecar for the SAM.gov responses ALREADY fetched by the scheduled RFP provider.
 * Stores early notices and named award notices while keeping the main RFP
 * opportunity table bid-ready only. Zero additional SAM.gov HTTP requests.
 */
import type { SamOpportunity } from "../providers/samGovQuality";
import type { SqlRunner } from "../companyWatch/awardStore";

export const SAM_NOTICE_CACHE_DDL = `CREATE TABLE IF NOT EXISTS sam_gov_intelligence_notices (
  notice_id text PRIMARY KEY,
  notice_type text NOT NULL,
  title text NOT NULL,
  agency text NOT NULL,
  description text,
  naics_code text,
  set_aside text,
  work_location text,
  posted_date date,
  response_deadline date,
  awardee text,
  award_amount numeric,
  contract_number text,
  source_url text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
)`;

let ensured: Promise<void> | null = null;
export function ensureSamNoticeCache(run: SqlRunner): Promise<void> {
  if (!ensured) ensured = run(SAM_NOTICE_CACHE_DDL).then(() => undefined).catch(error => { ensured = null; throw error; });
  return ensured;
}

export function cacheableSamNotice(value: SamOpportunity): boolean {
  const type = (value.type ?? value.baseType ?? "").trim().toLowerCase();
  if (/presolicitation|sources? sought/.test(type)) return true;
  return /award/.test(type) && Boolean(value.award?.awardee?.name?.trim());
}

const safeDate = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};

/** Store a response's useful non-bid notices, in one DB call. Existing notices keep their first_seen_at. */
export async function saveSamIntelligenceNotices(
  run: SqlRunner, opportunities: SamOpportunity[],
): Promise<number> {
  const notices = new Map<string, SamOpportunity>();
  for (const item of opportunities) {
    const id = item.noticeId?.trim();
    if (id && cacheableSamNotice(item)) notices.set(id, item);
  }
  if (notices.size === 0) return 0;
  await ensureSamNoticeCache(run);
  const rows = [...notices.entries()];
  const values = rows.map(([id, item]) => {
    const location = item.placeOfPerformance;
    const place = [location?.city?.name, location?.state?.code].filter(Boolean).join(", ") || null;
    const agency = item.fullParentPathName?.split(".")[0]?.trim() || "Federal agency";
    return [
      id, item.type ?? item.baseType ?? "Unknown", item.title ?? "Untitled",
      agency, item.description ?? null, item.naicsCode ?? null,
      item.typeOfSetAsideDescription ?? item.typeOfSetAside ?? null, place,
      safeDate(item.postedDate), safeDate(item.responseDeadLine),
      item.award?.awardee?.name ?? null, item.award?.amount ?? null,
      item.solicitationNumber ?? null, "https://sam.gov/opp/" + encodeURIComponent(id) + "/view",
    ];
  });
  const params: unknown[] = [];
  const cells = values.map((row, rowIndex) =>
    "(" + row.map((value, colIndex) => { params.push(value); return "$" + (rowIndex * 14 + colIndex + 1); }).join(",") + ")"
  ).join(",");
  await run(`INSERT INTO sam_gov_intelligence_notices (
    notice_id, notice_type, title, agency, description, naics_code, set_aside, work_location,
    posted_date, response_deadline, awardee, award_amount, contract_number, source_url)
    VALUES ${cells}
    ON CONFLICT (notice_id) DO UPDATE SET
      notice_type = EXCLUDED.notice_type, title = EXCLUDED.title, agency = EXCLUDED.agency,
      description = EXCLUDED.description, naics_code = EXCLUDED.naics_code,
      set_aside = EXCLUDED.set_aside, work_location = EXCLUDED.work_location,
      posted_date = EXCLUDED.posted_date, response_deadline = EXCLUDED.response_deadline,
      awardee = EXCLUDED.awardee, award_amount = EXCLUDED.award_amount,
      contract_number = EXCLUDED.contract_number, source_url = EXCLUDED.source_url,
      last_seen_at = now()`, params);
  return rows.length;
}
