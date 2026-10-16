import { Router } from "express";
import { logger } from "../lib/logger";
import {
  isGovConRecordSuppressed,
  loadGovConSuppressions,
} from "../lib/intelligence/govconFeedback";
import { rankGovConRecords } from "../lib/intelligence/govconIntelligence";
import { fetchAgencyForecastLeads } from "../lib/intelligence/agencyForecastDiscovery";
import { loadLocalOfficialSignals } from "../lib/intelligence/localOfficialSignals";
import { fetchTangoForecasts } from "../lib/intelligence/tangoForecastProvider";
import {
  providerBudgetAvailable,
  recordProviderFailure,
  recordProviderSuccess,
} from "../lib/providerBudget";

const router = Router();
const GOVCON_BASE_URL = "https://govconapi.com/api/v1";
const REQUEST_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 40;
const DAY_MS = 86_400_000;

type JsonRecord = Record<string, unknown>;
type ForecastRecord = ReturnType<typeof normalizeGovConForecast>;
type ForecastDataset = {
  records: any[];
  sourcePageRecords: number;
  deduplicatedRecords: number;
  semanticRejectedCount: number;
  suppressedCount: number;
  lowRelevanceCount: number;
  filtersApplied: Record<string, string | undefined>;
  semanticProvider: "gemini" | "deterministic";
  source: "govcon+official-fco+tango+sam-cache";
  sourceBreakdown: {
    govcon: number;
    tango: number;
    officialAgencyForecasts: number;
    samEarlyNotices: number;
    agencyDiscoveryProviders: string[];
    recoveredErrors: string[];
  };
  fetchedAt: string;
};

type ForecastPayload = Omit<ForecastDataset, "records"> & {
  records: any[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasNext: boolean;
  };
  cached: boolean;
};

const cache = new Map<
  string,
  { expiresAt: number; dataset: ForecastDataset }
>();
const inFlight = new Map<string, Promise<ForecastDataset>>();

function stringQuery(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.floor(parsed)))
    : fallback;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function firstString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === "string" && value.toLowerCase() === "true")
  );
}

function normalizeGovConForecast(rawValue: unknown) {
  const raw = asRecord(rawValue);
  const incumbentAward = asRecord(raw.incumbent_award);
  const title =
    firstString(raw, ["title", "requirement_title", "description"]) ??
    "Untitled forecast";
  const agency =
    firstString(raw, ["agency", "agency_name", "department_name"]) ??
    "Unknown agency";
  const source = firstString(raw, ["source", "source_name"]) ?? "govconapi";
  const sourceId = firstString(raw, ["source_id", "id", "forecast_id"]);
  const incumbentName =
    firstString(raw, ["incumbent_name", "current_incumbent"]) ??
    firstString(incumbentAward, ["recipient_name"]);
  return {
    id: sourceId ?? `govcon:${agency}:${title}`,
    source,
    sourceId,
    title,
    agency,
    subAgency: firstString(raw, [
      "subagency",
      "sub_agency",
      "office",
      "contracting_office",
    ]),
    description: firstString(raw, [
      "description",
      "requirement_description",
      "summary",
      "notes",
    ]),
    naics: firstString(raw, ["naics", "naics_code"]),
    setAside: firstString(raw, ["set_aside", "setaside"]),
    state: firstString(raw, ["state", "place_of_performance_state"]),
    valueRangeText: firstString(raw, [
      "value_range_text",
      "estimated_value",
      "amount_range",
    ]),
    valueLow: asNumber(
      raw.value_low ?? raw.amount_min ?? raw.estimated_value_low,
    ),
    valueHigh: asNumber(
      raw.value_high ?? raw.amount_max ?? raw.estimated_value_high,
    ),
    estimatedSolicitationDate: firstString(raw, [
      "est_solicitation_date",
      "estimated_solicitation_date",
      "solicitation_date",
    ]),
    estimatedAwardFiscalYear: asNumber(
      raw.est_award_fy ?? raw.estimated_award_fy,
    ),
    estimatedAwardQuarter: firstString(raw, [
      "est_award_quarter",
      "estimated_award_quarter",
    ]),
    status: firstString(raw, ["status", "lifecycle_status"]) ?? "forecast",
    isRecompete: asBoolean(raw.is_recompete),
    recompeteEvidence: "none" as const,
    incumbentName,
    incumbentAward: Object.keys(incumbentAward).length
      ? {
          recipientName: firstString(incumbentAward, ["recipient_name"]),
          currentValue: asNumber(incumbentAward.current_value),
          expires: firstString(incumbentAward, ["expires", "expiration_date"]),
          awardingAgency: firstString(incumbentAward, ["awarding_agency"]),
          latestActionDate: firstString(incumbentAward, ["latest_action_date"]),
        }
      : null,
    pointOfContact: {
      name: firstString(raw, [
        "poc_name",
        "point_of_contact_name",
        "requirement_owner",
      ]),
      email: firstString(raw, ["poc_email", "point_of_contact_email"]),
      phone: firstString(raw, ["poc_phone", "point_of_contact_phone"]),
    },
    sourceUrl: firstString(raw, ["source_url", "url", "forecast_url"]),
    lastUpdatedDate: firstString(raw, [
      "last_updated_date",
      "updated_at",
      "modified_date",
    ]),
  };
}

function startOfUtcDay(now: number): number {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function currentFederalFiscalYear(now: number): number {
  const date = new Date(now);
  return date.getUTCFullYear() + (date.getUTCMonth() >= 9 ? 1 : 0);
}

export function isForwardForecast(
  record: ForecastRecord,
  now = Date.now(),
): boolean {
  if (
    /closed|cancelled|canceled|complete|completed|awarded|archived|inactive/i.test(
      record.status,
    )
  ) {
    return false;
  }

  const solicitationMs = record.estimatedSolicitationDate
    ? Date.parse(record.estimatedSolicitationDate)
    : Number.NaN;
  const hasSolicitation = Number.isFinite(solicitationMs);
  const hasTiming = Boolean(
    hasSolicitation ||
      record.estimatedAwardFiscalYear != null ||
      record.estimatedAwardQuarter,
  );
  if (!hasTiming) {
    return /forecast|planned|planning|anticipated|active|open/i.test(
      record.status,
    );
  }

  const currentFy = currentFederalFiscalYear(now);
  const solicitationInWindow =
    hasSolicitation &&
    solicitationMs >= startOfUtcDay(now) &&
    solicitationMs <= now + 5 * 365 * DAY_MS;
  const awardFiscalYearInWindow =
    record.estimatedAwardFiscalYear != null &&
    record.estimatedAwardFiscalYear >= currentFy &&
    record.estimatedAwardFiscalYear <= currentFy + 5;
  return solicitationInWindow || awardFiscalYearInWindow;
}

function pruneCache(now = Date.now()): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function forecastKey(record: any): string {
  const sourceUrl = String(record.sourceUrl ?? "").trim();
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      url.hash = "";
      for (const key of [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
      ]) {
        url.searchParams.delete(key);
      }
      return `url:${url.toString().replace(/\/$/, "").toLowerCase()}`;
    } catch {
      return `url:${sourceUrl.replace(/\/$/, "").toLowerCase()}`;
    }
  }
  return `text:${normalizedText(record.agency)}:${normalizedText(record.title)}`;
}

function dedupeForecasts(records: any[]): any[] {
  const byKey = new Map<string, any>();
  for (const record of records) {
    const key = forecastKey(record);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, record);
      continue;
    }
    const existingTiming = Number(
      Boolean(
        existing.estimatedSolicitationDate ||
          existing.estimatedAwardFiscalYear ||
          existing.estimatedAwardQuarter,
      ),
    );
    const candidateTiming = Number(
      Boolean(
        record.estimatedSolicitationDate ||
          record.estimatedAwardFiscalYear ||
          record.estimatedAwardQuarter,
      ),
    );
    const existingRichness = String(existing.description ?? "").length;
    const candidateRichness = String(record.description ?? "").length;
    if (
      candidateTiming > existingTiming ||
      (candidateTiming === existingTiming && candidateRichness > existingRichness)
    ) {
      byKey.set(key, record);
    }
  }
  return [...byKey.values()];
}

async function fetchGovConForecastPool(
  focus?: string,
  filters: Record<string, string | undefined> = {},
): Promise<{
  records: ForecastRecord[];
  rawCount: number;
  error: string | null;
}> {
  const budgetName = "govcon:forecast";
  if (!(await providerBudgetAvailable(budgetName))) {
    return {
      records: [],
      rawCount: 0,
      error: "GovCon forecast budget is cooling down or exhausted.",
    };
  }
  const apiKey = process.env.GOVCON_API_KEY?.trim();
  if (!apiKey) {
    return {
      records: [],
      rawCount: 0,
      error: "GOVCON_API_KEY is not configured",
    };
  }

  const url = new URL(`${GOVCON_BASE_URL}/forecasts/search`);
  url.searchParams.set("limit", "100");
  url.searchParams.set("offset", "0");
  url.searchParams.set("active_only", "true");
  url.searchParams.set("sort_by", "est_award_fy");
  url.searchParams.set("sort_order", "asc");
  if (focus) url.searchParams.set("keywords", focus);
  for (const [key, value] of Object.entries(filters)) {
    if (value) url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const message = `GovCon API returned ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`;
      await recordProviderFailure(budgetName, message);
      return { records: [], rawCount: 0, error: message };
    }
    const payload = asRecord(await response.json());
    const raw = Array.isArray(payload.data) ? payload.data : [];
    const now = Date.now();
    const records = raw
      .map(normalizeGovConForecast)
      .filter((record) => isForwardForecast(record, now));
    await recordProviderSuccess(budgetName, records.length);
    return { records, rawCount: raw.length, error: null };
  } catch (error) {
    await recordProviderFailure(budgetName, error);
    return {
      records: [],
      rawCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function matchesFilters(
  record: any,
  filters: Record<string, string | undefined>,
): boolean {
  if (
    filters.agency &&
    !String(record.agency ?? "")
      .toLowerCase()
      .includes(filters.agency.toLowerCase())
  ) {
    return false;
  }
  if (
    filters.naics &&
    (!record.naics || !String(record.naics).startsWith(filters.naics))
  ) {
    return false;
  }
  if (
    filters.state &&
    (!record.state ||
      String(record.state).toLowerCase() !== filters.state.toLowerCase())
  ) {
    return false;
  }
  if (
    filters.source &&
    !String(record.source ?? "")
      .toLowerCase()
      .includes(filters.source.toLowerCase())
  ) {
    return false;
  }
  if (
    filters.set_aside &&
    !String(record.setAside ?? "")
      .toLowerCase()
      .includes(filters.set_aside.toLowerCase())
  ) {
    return false;
  }
  return true;
}

async function buildForecastDataset(
  fitOnly: boolean,
  focus: string | undefined,
  filters: Record<string, string | undefined>,
): Promise<ForecastDataset> {
  const [govcon, tango, agency, sam] = await Promise.all([
    fetchGovConForecastPool(focus, filters),
    fetchTangoForecasts(focus, {
      agency: filters.agency,
      naics: filters.naics,
      state: filters.state,
    }),
    fetchAgencyForecastLeads(focus),
    loadLocalOfficialSignals("forecast"),
  ]);
  const agencyFiltered = agency.records.filter((record) =>
    matchesFilters(record, filters),
  );
  const samFiltered = sam.records.filter(record => matchesFilters(record, filters));
  const beforeDedupe = [...govcon.records, ...tango.records, ...agencyFiltered, ...samFiltered];
  const combined = dedupeForecasts(beforeDedupe);

  if (combined.length === 0 && govcon.error && tango.error) {
    throw Object.assign(
      new Error("No forecast source could return usable records."),
      {
        statusCode: 502,
        diagnostics: [govcon.error, tango.error, ...agency.errors].slice(0, 6),
      },
    );
  }

  const suppressions = await loadGovConSuppressions("forecast").catch(() => ({
    recordIds: new Set<string>(),
    fingerprints: new Set<string>(),
  }));
  const unsuppressed = combined.filter(
    (record) => !isGovConRecordSuppressed(suppressions, record),
  );
  const ranked = await rankGovConRecords(unsuppressed, "forecast", focus);
  const records = fitOnly
    ? ranked.filter((record) => record.relevance.verdict !== "reject")
    : ranked;

  return {
    records,
    sourcePageRecords: beforeDedupe.length,
    deduplicatedRecords: Math.max(0, beforeDedupe.length - combined.length),
    semanticRejectedCount: Math.max(
      0,
      govcon.rawCount - govcon.records.length,
    ),
    suppressedCount: combined.length - unsuppressed.length,
    lowRelevanceCount: ranked.filter(
      (record) => record.relevance.verdict === "reject",
    ).length,
    filtersApplied: filters,
    semanticProvider: records.some(
      (record) => record.relevance.provider === "gemini",
    )
      ? "gemini"
      : "deterministic",
    source: "govcon+official-fco+tango+sam-cache",
    sourceBreakdown: {
      govcon: govcon.records.length,
      tango: tango.records.length,
      officialAgencyForecasts: agencyFiltered.length,
      samEarlyNotices: samFiltered.length,
      agencyDiscoveryProviders: agency.providers,
      recoveredErrors: [govcon.error, tango.error, ...agency.errors, ...sam.errors]
        .filter((value): value is string => Boolean(value)),
    },
    fetchedAt: new Date().toISOString(),
  };
}

function paginateForecastDataset(
  dataset: ForecastDataset,
  limit: number,
  offset: number,
  cached: boolean,
): ForecastPayload {
  return {
    ...dataset,
    records: dataset.records.slice(offset, offset + limit),
    pagination: {
      limit,
      offset,
      total: dataset.records.length,
      hasNext: offset + limit < dataset.records.length,
    },
    cached,
  };
}

router.get("/govcon/forecasts", async (req, res, next) => {
  if (req.query.recompete === "true") return next();

  const limit = boundedInteger(req.query.limit, 50, 1, 100);
  const offset = boundedInteger(req.query.offset, 0, 0, 100_000);
  const fitOnly = req.query.fitOnly !== "false";
  const focus = stringQuery(req.query.focus ?? req.query.keywords, 200);
  const filters = {
    agency: stringQuery(req.query.agency, 120),
    naics: stringQuery(req.query.naics, 6),
    source: stringQuery(req.query.source, 30),
    set_aside: stringQuery(req.query.setAside, 40),
    state: stringQuery(req.query.state, 2),
  };

  const cacheKey = JSON.stringify({ fitOnly, focus, filters });
  pruneCache();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(
      paginateForecastDataset(cached.dataset, limit, offset, true),
    );
  }

  try {
    let request = inFlight.get(cacheKey);
    if (!request) {
      request = buildForecastDataset(fitOnly, focus, filters);
      inFlight.set(cacheKey, request);
    }
    const dataset = await request;
    pruneCache();
    cache.set(cacheKey, {
      dataset,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return res.json(paginateForecastDataset(dataset, limit, offset, false));
  } catch (error) {
    logger.error({ err: error }, "Forecast ensemble failed");
    const statusCode =
      Number((error as { statusCode?: number }).statusCode) || 502;
    const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
    return res.status(statusCode).json({
      error:
        error instanceof Error ? error.message : "Forecast ensemble failed",
      ...(Array.isArray(diagnostics)
        ? { diagnostics: diagnostics.slice(0, 6) }
        : {}),
    });
  } finally {
    inFlight.delete(cacheKey);
  }
});

export default router;
