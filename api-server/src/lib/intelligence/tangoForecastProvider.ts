/**
 * Tango Forecast Provider
 *
 * Fetches procurement forecasts from Tango by MakeGov's /api/forecasts/ endpoint
 * and normalises them into the same shape used by govcon.ts and
 * govcon-forecast-ensemble.ts so they participate in the unified ranking,
 * deduplication, and suppression pipeline.
 *
 * API reference: https://docs.makegov.com/api-reference/forecasts/
 */

import { forecastAgencyCodes } from "../search/agencyPriority";
import {
  providerBudgetAvailable,
  recordProviderFailure,
  recordProviderSuccess,
} from "../providerBudget";
import { resolveCredential } from "../config/providerConfig";
import { profileNaicsCodes } from "../providers/profileQueryTerms";

const TANGO_BASE_URL = "https://tango.makegov.com";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 3; // up to 300 forecast records per call

// ---------------------------------------------------------------------------
// Raw API shape (minimal — only what we use)
// ---------------------------------------------------------------------------

interface TangoForecastContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

interface TangoForecastOrg {
  name?: string | null;
  abbreviation?: string | null;
}

interface TangoForecastPlace {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

interface TangoForecastPeriod {
  base_years?: number | null;
  option_years?: number | null;
}

interface TangoForecastRaw {
  id: string | number;
  source_system?: string | null;
  external_id?: string | null;
  agency?: string | null;
  title?: string | null;
  description?: string | null;
  anticipated_award_date?: string | null;
  fiscal_year?: number | null;
  naics_code?: string | null;
  is_active?: boolean | null;
  status?: string | null;
  primary_contact?: TangoForecastContact | null;
  // Tango's data dictionary documents these four as display strings; older payloads used objects, so both are read.
  place_of_performance?: TangoForecastPlace | string | null;
  estimated_period?: TangoForecastPeriod | string | null;
  set_aside?: string | null;
  contract_vehicle?: string | null;
  organization?: TangoForecastOrg | null;
}

interface TangoForecastListResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: TangoForecastRaw[];
}

// ---------------------------------------------------------------------------
// Normalised output — matches the ForecastRecord shape in govcon.ts /
// govcon-forecast-ensemble.ts so the two routes can merge results uniformly.
// ---------------------------------------------------------------------------

export interface TangoForecastRecord {
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
  valueLow: null;
  valueHigh: null;
  estimatedSolicitationDate: string | null;
  estimatedAwardFiscalYear: number | null;
  estimatedAwardQuarter: string | null;
  status: string;
  isRecompete: false;
  recompeteEvidence: "none";
  incumbentName: null;
  incumbentAward: null;
  pointOfContact: {
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  sourceUrl: string | null;
  lastUpdatedDate: string | null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const US_STATE_SUFFIX = /(?:,|\s)\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/;

/** Place of performance as one display string, from either the documented string or an object payload. */
export function tangoPlaceText(value: unknown): string | null {
  if (typeof value === "string") return asString(value);
  if (value && typeof value === "object") {
    const place = value as TangoForecastPlace;
    const parts = [asString(place.city), asString(place.state), asString(place.country)].filter(
      (part): part is string => part !== null,
    );
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

/** Two-letter state: from an object payload, or from a trailing ", ST" in a display string. */
export function tangoPlaceState(value: unknown): string | null {
  if (value && typeof value === "object") return asString((value as TangoForecastPlace).state);
  if (typeof value === "string") {
    const match = US_STATE_SUFFIX.exec(value.trim());
    return match?.[1] ?? null;
  }
  return null;
}

function tangoPeriodText(value: unknown): string | null {
  if (typeof value === "string") return asString(value);
  if (value && typeof value === "object") {
    const period = value as TangoForecastPeriod;
    const base = asNumber(period.base_years);
    const option = asNumber(period.option_years);
    const parts: string[] = [];
    if (base !== null && period.base_years != null) parts.push(`${base} base year${base === 1 ? "" : "s"}`);
    if (option !== null && period.option_years != null) parts.push(`${option} option year${option === 1 ? "" : "s"}`);
    return parts.length > 0 ? parts.join(" + ") : null;
  }
  return null;
}

export function normalizeTangoForecast(raw: TangoForecastRaw): TangoForecastRecord {
  const rawId = String(raw.id ?? "");
  const source = asString(raw.source_system) ?? "tango";
  const externalId = asString(raw.external_id) ?? rawId;
  const title = asString(raw.title) ?? "Untitled forecast";
  const agency =
    asString(raw.organization?.name) ??
    asString(raw.agency) ??
    "Unknown agency";
  const subAgency =
    raw.organization?.name && raw.agency && raw.organization.name !== raw.agency
      ? asString(raw.agency)
      : null;
  const state = tangoPlaceState(raw.place_of_performance);
  const status = raw.is_active === false ? "archived" : (asString(raw.status) ?? "forecast");
  const awardDate = asString(raw.anticipated_award_date);

  return {
    id: `tango:${source}:${externalId}`,
    source: "tango",
    sourceId: externalId,
    title,
    agency,
    subAgency,
    description: asString(raw.description),
    naics: asString(raw.naics_code),
    setAside: asString(raw.set_aside),
    state,
    placeOfPerformance: tangoPlaceText(raw.place_of_performance),
    estimatedPeriod: tangoPeriodText(raw.estimated_period),
    contractVehicle: asString(raw.contract_vehicle),
    valueRangeText: null,
    valueLow: null,
    valueHigh: null,
    estimatedSolicitationDate: null,
    estimatedAwardFiscalYear: asNumber(raw.fiscal_year),
    estimatedAwardQuarter: null,
    status,
    isRecompete: false,
    recompeteEvidence: "none",
    incumbentName: null,
    incumbentAward: null,
    pointOfContact: {
      name: asString(raw.primary_contact?.name),
      email: asString(raw.primary_contact?.email),
      phone: asString(raw.primary_contact?.phone),
    },
    sourceUrl: null,
    lastUpdatedDate: awardDate,
  };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function getApiKey(): Promise<string | null> {
  return resolveCredential("tangoApiKey", "TANGO_API_KEY");
}

async function fetchPage(
  url: URL,
  apiKey: string,
): Promise<TangoForecastListResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: {
        "X-API-KEY": apiKey,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Tango forecast API ${response.status}: ${body.slice(0, 200)}`);
    }
    const payload = (await response.json()) as TangoForecastListResponse;
    return {
      count: Number.isFinite(payload.count) ? payload.count : 0,
      next: typeof payload.next === "string" ? payload.next : null,
      previous: typeof payload.previous === "string" ? payload.previous : null,
      results: Array.isArray(payload.results) ? payload.results : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TangoForecastPoolResult {
  records: TangoForecastRecord[];
  rawCount: number;
  error: string | null;
}

export async function fetchTangoForecasts(
  focus?: string,
  filters: {
    agency?: string;
    naics?: string;
    state?: string;
    fiscalYear?: number;
  } = {},
): Promise<TangoForecastPoolResult> {
  const budgetName = "tango:forecast";

  if (!(await providerBudgetAvailable(budgetName))) {
    return {
      records: [],
      rawCount: 0,
      error: "Tango forecast budget is in cooldown.",
    };
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    return {
      records: [],
      rawCount: 0,
      error: "TANGO_API_KEY is not configured",
    };
  }

  const endpoint = new URL(`${TANGO_BASE_URL}/api/forecasts/`);
  endpoint.searchParams.set("limit", String(MAX_PAGE_SIZE));
  endpoint.searchParams.set("is_active", "true");
  endpoint.searchParams.set("ordering", "anticipated_award_date");

  // Agency request filter: an explicit filter wins, otherwise the Neon search-priority agency codes (not relevance;
  // empty = unfiltered).
  const priorityAgencies = forecastAgencyCodes();
  if (filters.agency) {
    endpoint.searchParams.set("agency", filters.agency.toUpperCase());
  } else if (priorityAgencies.length > 0) {
    endpoint.searchParams.set("agency", priorityAgencies.join("|"));
  }

  if (filters.naics) {
    // Use prefix matching when it's a partial code, exact when 6 digits
    if (filters.naics.length < 6) {
      endpoint.searchParams.set("naics_starts_with", filters.naics);
    } else {
      endpoint.searchParams.set("naics_code", filters.naics);
    }
  } else {
    // Default: the Occu-Med NAICS codes from the relevance profile (Tango accepts "|" for OR). With no profile
    // codes the request stays unfiltered by NAICS and the relevance gate decides.
    const profileCodes = await profileNaicsCodes(12);
    if (profileCodes.length > 0) endpoint.searchParams.set("naics_code", profileCodes.join("|"));
  }

  if (filters.fiscalYear) {
    endpoint.searchParams.set("fiscal_year_gte", String(filters.fiscalYear));
  } else {
    const currentFy =
      new Date().getUTCMonth() >= 9
        ? new Date().getUTCFullYear() + 1
        : new Date().getUTCFullYear();
    endpoint.searchParams.set("fiscal_year_gte", String(currentFy));
  }

  if (focus?.trim()) {
    endpoint.searchParams.set("search", focus.trim().slice(0, 200));
  }

  const records: TangoForecastRecord[] = [];
  const seen = new Set<string>();
  let currentUrl: URL | null = endpoint;
  let pageCount = 0;
  let rawCount = 0;

  try {
    while (currentUrl && pageCount < MAX_PAGES) {
      pageCount++;
      const page = await fetchPage(currentUrl, apiKey);
      rawCount = Math.max(rawCount, page.count);

      for (const raw of page.results) {
        if (!raw?.id) continue;
        const record = normalizeTangoForecast(raw);
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
      }

      currentUrl = page.next ? new URL(page.next) : null;
    }

    await recordProviderSuccess(budgetName, records.length);
    return { records, rawCount: rawCount || records.length, error: null };
  } catch (error) {
    await recordProviderFailure(budgetName, error);
    return {
      records,
      rawCount: rawCount || records.length,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
