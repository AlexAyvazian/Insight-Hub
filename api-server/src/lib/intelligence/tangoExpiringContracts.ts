/**
 * Recompete Watch source: real federal contracts that are about to end, with the incumbent named.
 *
 * Tango's /api/contracts/ (FPDS + USAspending) supports an `expiring_gte` / `expiring_lte` window on the ultimate
 * completion date, so a recompete candidate is a contract that actually expires soon and has a known recipient —
 * not a forecast row relabelled. Tango forecasts carry no incumbent, which is why the old Recompete Watch page
 * showed the same Tango forecast cards as the Forecasts page.
 *
 * API reference: https://docs.makegov.com/api-reference/contracts/
 */

import {
  providerBudgetAvailable,
  recordProviderFailure,
  recordProviderSuccess,
} from "../providerBudget";
import { resolveCredential } from "../config/providerConfig";
import { profileCodesFor, profileNaicsCodes } from "../providers/profileQueryTerms";

const TANGO_BASE_URL = "https://tango.makegov.com";
const REQUEST_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 2;
const WINDOW_MONTHS = 24;
const BUDGET_NAME = "tango:contracts";

/** Expansions requested with ?shape=. Names come from the Tango contracts data dictionary. */
const CONTRACT_SHAPE = [
  "key",
  "piid",
  "description",
  "award_date",
  "fiscal_year",
  "total_contract_value",
  "obligated",
  "naics(code,description)",
  "psc(code,description)",
  "recipient(display_name,legal_business_name,uei)",
  "place_of_performance(city_name,state_code)",
  "period_of_performance(start_date,current_end_date,ultimate_completion_date)",
  "awarding_office(office_name,agency_name,department_name)",
  "set_aside(description)",
].join(",");

type JsonRecord = Record<string, unknown>;

export interface TangoExpiringContractRecord {
  id: string;
  source: "tango";
  sourceId: string | null;
  title: string;
  agency: string;
  subAgency: string | null;
  description: string | null;
  naics: string | null;
  setAside: string | null;
  state: string | null;
  placeOfPerformance: string | null;
  estimatedPeriod: string | null;
  contractVehicle: string | null;
  valueRangeText: string | null;
  valueLow: number | null;
  valueHigh: number | null;
  estimatedSolicitationDate: string | null;
  estimatedAwardFiscalYear: number | null;
  estimatedAwardQuarter: string | null;
  status: string;
  isRecompete: true;
  recompeteEvidence: "incumbent-award";
  incumbentName: string;
  incumbentAward: {
    recipientName: string | null;
    currentValue: number | null;
    expires: string | null;
    awardingAgency: string | null;
    latestActionDate: string | null;
  };
  pointOfContact: { name: string | null; email: string | null; phone: string | null };
  sourceUrl: string | null;
  lastUpdatedDate: string | null;
}

export interface TangoExpiringPoolResult {
  records: TangoExpiringContractRecord[];
  rawCount: number;
  error: string | null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A nested object's field, or the value itself when the API returned a plain string for that key. */
function nested(raw: JsonRecord, key: string, field: string): string | null {
  const value = raw[key];
  if (typeof value === "string") return asString(value);
  return asString(asRecord(value)[field]);
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function federalFiscalYear(date: Date): number {
  return date.getUTCFullYear() + (date.getUTCMonth() >= 9 ? 1 : 0);
}

/** FPDS descriptions are often upper case and padded; keep the words, tidy the case for a card title. */
function tidyTitle(description: string | null, fallback: string): string {
  if (!description) return fallback;
  const collapsed = description.replace(/\s+/g, " ").trim();
  const letters = collapsed.replace(/[^A-Za-z]/g, "");
  const upperRatio = letters.length > 0 ? letters.replace(/[^A-Z]/g, "").length / letters.length : 0;
  const text = upperRatio > 0.8 ? collapsed.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase()) : collapsed;
  return text.length > 140 ? `${text.slice(0, 137).trimEnd()}...` : text;
}

/** USAspending award page, only when Tango's canonical key is the USAspending award identifier. */
function awardUrl(key: string | null): string | null {
  if (key && /^CONT_(?:AWD|IDV)_/i.test(key)) {
    return `https://www.usaspending.gov/award/${encodeURIComponent(key)}`;
  }
  return null;
}

/**
 * One Tango contract -> one Recompete Watch record. A contract with no named recipient or no end date is not a
 * recompete signal, so it maps to null instead of an empty card.
 */
export function tangoContractToRecompete(rawValue: unknown): TangoExpiringContractRecord | null {
  const raw = asRecord(rawValue);
  const key = asString(raw.key);
  const piid = asString(raw.piid);
  const identifier = key ?? piid;
  if (!identifier) return null;

  const recipientName =
    nested(raw, "recipient", "display_name") ?? nested(raw, "recipient", "legal_business_name");
  const period = asRecord(raw.period_of_performance);
  const expires =
    asString(period.ultimate_completion_date) ??
    asString(period.current_end_date) ??
    asString(raw.expiring) ??
    asString(raw.pop_end_date);
  if (!recipientName || !expires) return null;

  const expiresMs = Date.parse(expires);
  const description = asString(raw.description);
  const total = asNumber(raw.total_contract_value);
  const obligated = asNumber(raw.obligated);
  const currentValue = total ?? asNumber(raw.base_and_exercised_options_value) ?? obligated;

  const office = asRecord(raw.awarding_office);
  const department = asString(office.department_name);
  const agencyName = asString(office.agency_name);
  const officeName = asString(office.office_name);
  const agency = department ?? agencyName ?? "Federal agency";
  const subAgency = agencyName && agencyName !== agency ? agencyName : officeName && officeName !== agency ? officeName : null;

  const place = asRecord(raw.place_of_performance);
  const city = asString(place.city_name);
  const state = asString(place.state_code);
  const placeText = [city, state].filter((part): part is string => part !== null).join(", ") || null;

  const naicsObject = asRecord(raw.naics);
  const naicsCode = asString(naicsObject.code) ?? (typeof raw.naics === "string" ? asString(raw.naics) : null) ?? asString(raw.naics_code);
  const setAside = nested(raw, "set_aside", "description");
  const startDate = asString(period.start_date);
  const estimatedPeriod = startDate ? `${startDate.slice(0, 10)} to ${expires.slice(0, 10)}` : null;

  return {
    id: `tango-contract:${identifier}`,
    source: "tango",
    sourceId: piid ?? identifier,
    title: tidyTitle(description, piid ? `Contract ${piid}` : "Federal contract"),
    agency,
    subAgency,
    description,
    naics: naicsCode,
    setAside,
    state,
    placeOfPerformance: placeText,
    estimatedPeriod,
    contractVehicle: null,
    valueRangeText: null,
    valueLow: null,
    valueHigh: currentValue,
    estimatedSolicitationDate: null,
    estimatedAwardFiscalYear: Number.isFinite(expiresMs) ? federalFiscalYear(new Date(expiresMs)) : null,
    estimatedAwardQuarter: null,
    status: "active",
    isRecompete: true,
    recompeteEvidence: "incumbent-award",
    incumbentName: recipientName,
    incumbentAward: {
      recipientName,
      currentValue,
      expires,
      awardingAgency: agency,
      latestActionDate: asString(raw.award_date),
    },
    pointOfContact: { name: null, email: null, phone: null },
    sourceUrl: awardUrl(key),
    lastUpdatedDate: asString(raw.award_date),
  };
}

interface ContractsPage {
  count: number;
  next: string | null;
  results: unknown[];
}

class TangoHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function fetchPage(url: URL, apiKey: string): Promise<ContractsPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { "X-API-KEY": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new TangoHttpError(response.status, `Tango contracts API ${response.status}: ${body.slice(0, 200)}`);
    }
    const payload = asRecord(await response.json());
    return {
      count: asNumber(payload.count) ?? 0,
      next: typeof payload.next === "string" ? payload.next : null,
      results: Array.isArray(payload.results) ? payload.results : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * NAICS codes to query: the Occu-Med profile's exact codes, narrowed to the analyst's prefix when one is chosen.
 * A six-digit filter is used as given. Returns null when the chosen prefix matches none of the profile's codes.
 */
export function recompeteNaicsCodes(profileCodes: string[], requested?: string): string[] | null {
  const prefix = requested?.trim();
  if (!prefix) return profileCodes;
  if (/^\d{6}$/.test(prefix)) return [prefix];
  const matching = profileCodes.filter((code) => code.startsWith(prefix));
  return matching.length > 0 ? matching : null;
}

export async function fetchTangoExpiringContracts(
  focus?: string,
  filters: { agency?: string; naics?: string } = {},
  now: Date = new Date(),
): Promise<TangoExpiringPoolResult> {
  if (!(await providerBudgetAvailable(BUDGET_NAME))) {
    return { records: [], rawCount: 0, error: "Tango contracts budget is in cooldown." };
  }
  const apiKey = await resolveCredential("tangoApiKey", "TANGO_API_KEY");
  if (!apiKey) return { records: [], rawCount: 0, error: "TANGO_API_KEY is not configured" };

  const naicsCodes = recompeteNaicsCodes(await profileNaicsCodes(12), filters.naics);
  // A prefix that no Occu-Med code starts with is a valid empty answer, not a failure.
  if (naicsCodes === null) return { records: [], rawCount: 0, error: null };

  // Two axes, merged: contracts classified by Occu-Med NAICS codes, and contracts classified by the profile's PSC
  // codes. Medical services are often coded by PSC under an unrelated NAICS, so NAICS alone misses real recompetes.
  // An analyst-chosen industry narrows to the NAICS axis only.
  const axes: Array<{ param: "naics" | "psc"; values: string[] }> = [];
  if (naicsCodes.length > 0) axes.push({ param: "naics", values: naicsCodes });
  const pscCodes = filters.naics?.trim() ? [] : profileCodesFor("PSC").slice(0, 12);
  if (pscCodes.length > 0) axes.push({ param: "psc", values: pscCodes });
  if (axes.length === 0) axes.push({ param: "naics", values: [] });

  const windowEnd = new Date(now);
  windowEnd.setUTCMonth(windowEnd.getUTCMonth() + WINDOW_MONTHS);

  const buildUrl = (axis: { param: "naics" | "psc"; values: string[] }, withShape: boolean): URL => {
    const url = new URL(`${TANGO_BASE_URL}/api/contracts/`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("expiring_gte", dateOnly(now));
    url.searchParams.set("expiring_lte", dateOnly(windowEnd));
    url.searchParams.set("ordering", "-total_contract_value");
    if (axis.values.length > 0) url.searchParams.set(axis.param, axis.values.join("|"));
    if (filters.agency?.trim()) url.searchParams.set("awarding_agency", filters.agency.trim());
    if (focus?.trim()) url.searchParams.set("search", focus.trim().slice(0, 200));
    if (withShape) url.searchParams.set("shape", CONTRACT_SHAPE);
    return url;
  };

  const records: TangoExpiringContractRecord[] = [];
  const seen = new Set<string>();
  let rawCount = 0;
  let withShape = true;
  const axisErrors: string[] = [];

  try {
    for (const axis of axes) {
      try {
        let currentUrl: URL | null = buildUrl(axis, withShape);
        let pageCount = 0;
        while (currentUrl && pageCount < MAX_PAGES) {
          pageCount += 1;
          let page: ContractsPage;
          try {
            page = await fetchPage(currentUrl, apiKey);
          } catch (error) {
            // A rejected ?shape= must not blank the page: retry once with Tango's default fields.
            if (withShape && pageCount === 1 && error instanceof TangoHttpError && error.status === 400) {
              withShape = false;
              currentUrl = buildUrl(axis, false);
              page = await fetchPage(currentUrl, apiKey);
            } else {
              throw error;
            }
          }
          rawCount += page.count;
          for (const raw of page.results) {
            const record = tangoContractToRecompete(raw);
            if (!record || seen.has(record.id)) continue;
            seen.add(record.id);
            records.push(record);
          }
          currentUrl = page.next ? new URL(page.next) : null;
        }
      } catch (error) {
        // One axis failing must not hide what the other returned; it is reported if nothing came back at all.
        axisErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (records.length === 0 && axisErrors.length === axes.length) throw new Error(axisErrors[0]);
    await recordProviderSuccess(BUDGET_NAME, records.length);
    return { records, rawCount: rawCount || records.length, error: null };
  } catch (error) {
    await recordProviderFailure(BUDGET_NAME, error);
    return {
      records,
      rawCount: rawCount || records.length,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
