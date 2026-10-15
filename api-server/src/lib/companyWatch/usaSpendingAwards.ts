/**
 * Newly signed federal contracts for one watched company, from USAspending.gov (official, free, no key).
 *
 * The query asks for contracts (award types A-D) whose recipient matches the company and that were SIGNED inside the
 * look-back window. USAspending's recipient search is fuzzy, so every returned row is re-checked with
 * `matchesAwardee` before it is kept: a row whose recipient does not start with the company's name or a documented
 * alias is discarded and never attributed to the company. DoD rows reach USAspending about 90 days after signature;
 * the daily DoD announcement feed covers those sooner.
 */
import { matchesAwardee } from "./companyIdentity";
import { locationCountry, type OfficialAward } from "./officialAward";

const ENDPOINT = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
export const USASPENDING_LOOKBACK_DAYS = 120;

const FULL_FIELDS = [
  "Award ID", "Recipient Name", "Recipient UEI", "Award Amount", "Description", "Start Date", "End Date",
  "Awarding Agency", "Awarding Sub Agency", "Place of Performance Country Code", "Place of Performance State Code",
  "Place of Performance City Code", "generated_internal_id",
];
/** Fields the existing USAspending provider already requests; used if the full list is rejected. */
const SAFE_FIELDS = ["Award ID", "Recipient Name", "Award Amount", "Description", "Start Date", "End Date", "Awarding Agency", "Awarding Sub Agency", "generated_internal_id"];

const day = (date: Date) => date.toISOString().slice(0, 10);

export function usaSpendingRequestBody(company: string, now: Date, fields = FULL_FIELDS, dateType: string | null = "date_signed"): Record<string, unknown> {
  const start = new Date(now.getTime() - USASPENDING_LOOKBACK_DAYS * 86_400_000);
  return {
    filters: {
      award_type_codes: ["A", "B", "C", "D"],
      recipient_search_text: [company],
      time_period: [{ start_date: day(start), end_date: day(now), ...(dateType ? { date_type: dateType } : {}) }],
    },
    fields,
    sort: "Award Amount",
    order: "desc",
    limit: 60,
    page: 1,
  };
}

type Row = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null);

export function normalizeUsaSpendingRow(row: Row): OfficialAward | null {
  const id = str(row.generated_internal_id) ?? str(row["Award ID"]);
  const recipient = str(row["Recipient Name"]);
  if (!id || !recipient) return null;
  const amount = Number(row["Award Amount"]);
  const country = str(row["Place of Performance Country Code"]);
  const location = [str(row["Place of Performance City Code"]), str(row["Place of Performance State Code"]), country].filter(Boolean).join(", ") || null;
  return {
    awardKey: `usaspending:${id}`,
    source: "usaspending",
    recipientText: recipient,
    recipientUei: str(row["Recipient UEI"]),
    awardingAgency: [str(row["Awarding Agency"]), str(row["Awarding Sub Agency"])].filter(Boolean).join(" — ") || null,
    amount: Number.isFinite(amount) ? amount : null,
    contractNumber: str(row["Award ID"]),
    modification: false,
    actionDate: str(row["Start Date"])?.slice(0, 10) ?? null,
    workLocation: location,
    popCountry: country ? (/^(USA|US|UNITED STATES)$/i.test(country) ? "USA" : country) : locationCountry(location),
    description: str(row.Description) ?? "",
    sourceUrl: str(row.generated_internal_id) ? `https://www.usaspending.gov/award/${encodeURIComponent(String(row.generated_internal_id))}` : null,
    completionDate: str(row["End Date"])?.slice(0, 10) ?? null,
  };
}

export interface UsaSpendingCompanyResult {
  rows: number;
  awards: OfficialAward[];
  rejectedRecipients: string[];
  status: string;
}

/** Query, then keep only rows whose recipient is verifiably the company. Falls back to the safe field list on 4xx. */
export async function fetchUsaSpendingAwards(company: string, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<UsaSpendingCompanyResult> {
  const attempts: Array<[string[], string | null]> = [[FULL_FIELDS, "date_signed"], [SAFE_FIELDS, "date_signed"], [SAFE_FIELDS, null]];
  let lastStatus = "not attempted";
  for (const [fields, dateType] of attempts) {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(usaSpendingRequestBody(company, now, fields, dateType)),
      signal: AbortSignal.timeout(30_000),
    });
    lastStatus = `HTTP ${response.status}`;
    if (response.status >= 400 && response.status < 500) continue;
    if (!response.ok) break;
    const json = (await response.json().catch(() => ({}))) as { results?: Row[] };
    const results = Array.isArray(json.results) ? json.results : [];
    const awards: OfficialAward[] = [];
    const rejected = new Set<string>();
    const cutoff = now.getTime() - USASPENDING_LOOKBACK_DAYS * 86_400_000;
    for (const row of results) {
      const award = normalizeUsaSpendingRow(row);
      if (!award) continue;
      if (!matchesAwardee(award.recipientText, company)) { rejected.add(award.recipientText); continue; }
      // Without the date_signed filter the window is by action date; keep only awards that started in the window.
      if (dateType === null && award.actionDate && Date.parse(award.actionDate) < cutoff) continue;
      awards.push(award);
    }
    return { rows: results.length, awards, rejectedRecipients: [...rejected].slice(0, 10), status: `${lastStatus}${dateType ? "" : " (action-date window)"}${fields === SAFE_FIELDS ? " (basic fields)" : ""}` };
  }
  return { rows: 0, awards: [], rejectedRecipients: [], status: lastStatus };
}
