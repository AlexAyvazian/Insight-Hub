import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import {
  isGovConRecordSuppressed,
  loadGovConSuppressions,
  restoreGovConFeedback,
  saveGovConNotRelevant,
  type GovConFeedbackMode,
} from "../lib/intelligence/govconFeedback";
import {
  rankGovConRecords,
  type GovConRelevance,
} from "../lib/intelligence/govconIntelligence";
import { verifyRecompete } from "../lib/intelligence/recompeteVerification";
import {
  fetchTangoForecasts,
  type TangoForecastRecord,
} from "../lib/intelligence/tangoForecastProvider";
import {
  fetchTangoExpiringContracts,
  type TangoExpiringContractRecord,
} from "../lib/intelligence/tangoExpiringContracts";
import { indexVectorDocuments } from "../lib/search/vectorIndex";
import {
  providerBudgetAvailable,
  recordProviderFailure,
  recordProviderSuccess,
} from "../lib/providerBudget";

const router: IRouter = Router();

const GOVCON_BASE_URL = "https://govconapi.com/api/v1";
const REQUEST_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 40;
const DAY_MS = 86_400_000;

type JsonRecord = Record<string, unknown>;
type NormalizedForecast = ReturnType<typeof normalizeForecast>;
type RankedForecast = NormalizedForecast & { relevance: GovConRelevance };

type ForecastPayload = {
  records: RankedForecast[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasNext: boolean;
  };
  sourcePageRecords: number;
  semanticRejectedCount: number;
  suppressedCount: number;
  lowRelevanceCount: number;
  filtersApplied: JsonRecord;
  semanticProvider: "gemini" | "deterministic";
  source: "govconapi";
  fetchedAt: string;
};

type CacheEntry = {
  expiresAt: number;
  payload: ForecastPayload;
};

const responseCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ForecastPayload>>();
const indexedAt = new Map<string, number>();

function stringQuery(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
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
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function firstString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function dateMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeForecast(rawValue: unknown) {
  const raw = asRecord(rawValue);
  const incumbentAward = asRecord(raw.incumbent_award);
  const source = firstString(raw, ["source", "source_name"]);
  const sourceId = firstString(raw, ["source_id", "id", "forecast_id"]);
  const title = firstString(raw, ["title", "requirement_title", "description"]) ?? "Untitled forecast";
  const agency = firstString(raw, ["agency", "agency_name", "department_name"]) ?? "Unknown agency";
  const incumbentName =
    firstString(raw, ["incumbent_name", "current_incumbent"]) ??
    firstString(incumbentAward, ["recipient_name"]);
  const explicitRecompete = asBoolean(raw.is_recompete);
  const hasIncumbentAward = Object.keys(incumbentAward).length > 0;
  const recompeteEvidence = explicitRecompete
    ? "explicit"
    : hasIncumbentAward
      ? "incumbent-award"
      : incumbentName
        ? "incumbent-name"
        : "none";

  return {
    id: sourceId ?? `${source ?? "govcon"}:${agency}:${title}`,
    source,
    sourceId,
    title,
    agency,
    subAgency: firstString(raw, ["subagency", "sub_agency", "office", "contracting_office"]),
    description: firstString(raw, ["description", "requirement_description", "summary", "notes"]),
    naics: firstString(raw, ["naics", "naics_code"]),
    setAside: firstString(raw, ["set_aside", "setaside"]),
    state: firstString(raw, ["state", "place_of_performance_state"]),
    valueRangeText: firstString(raw, ["value_range_text", "estimated_value", "amount_range"]),
    valueLow: asNumber(raw.value_low ?? raw.amount_min ?? raw.estimated_value_low),
    valueHigh: asNumber(raw.value_high ?? raw.amount_max ?? raw.estimated_value_high),
    estimatedSolicitationDate: firstString(raw, ["est_solicitation_date", "estimated_solicitation_date", "solicitation_date"]),
    estimatedAwardFiscalYear: asNumber(raw.est_award_fy ?? raw.estimated_award_fy),
    estimatedAwardQuarter: firstString(raw, ["est_award_quarter", "estimated_award_quarter"]),
    status: firstString(raw, ["status", "lifecycle_status"]),
    isRecompete: explicitRecompete || Boolean(incumbentName) || hasIncumbentAward,
    recompeteEvidence,
    incumbentName,
    incumbentAward: hasIncumbentAward
      ? {
          recipientName: firstString(incumbentAward, ["recipient_name"]),
          currentValue: asNumber(incumbentAward.current_value),
          expires: firstString(incumbentAward, ["expires", "expiration_date"]),
          awardingAgency: firstString(incumbentAward, ["awarding_agency"]),
          latestActionDate: firstString(incumbentAward, ["latest_action_date"]),
        }
      : null,
    pointOfContact: {
      name: firstString(raw, ["poc_name", "point_of_contact_name", "requirement_owner"]),
      email: firstString(raw, ["poc_email", "point_of_contact_email"]),
      phone: firstString(raw, ["poc_phone", "point_of_contact_phone"]),
    },
    sourceUrl: firstString(raw, ["source_url", "url", "forecast_url"]),
    lastUpdatedDate: firstString(raw, ["last_updated_date", "updated_at", "modified_date"]),
  };
}

function statusIsClosed(status: string | null): boolean {
  if (!status) return false;
  return /closed|cancelled|canceled|complete|completed|awarded|archived|inactive/i.test(status);
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

/**
 * Forecast mode keeps genuinely forward-looking forecast records. Recompete
 * mode additionally requires incumbent/award evidence and sensible timing so a
 * normal active solicitation cannot be mislabeled as a recompete merely because
 * its proposal deadline is close.
 */
export function isGovConSemanticCandidate(
  record: NormalizedForecast,
  mode: GovConFeedbackMode,
  now = Date.now(),
): boolean {
  if (statusIsClosed(record.status)) return false;

  const solicitationMs = dateMs(record.estimatedSolicitationDate);
  const expirationMs = dateMs(record.incumbentAward?.expires ?? null);
  const hasForecastTiming = Boolean(
    solicitationMs != null ||
      record.estimatedAwardFiscalYear != null ||
      record.estimatedAwardQuarter,
  );

  if (mode === "forecast") {
    const currentFy = currentFederalFiscalYear(now);
    const solicitationInWindow =
      solicitationMs != null &&
      solicitationMs >= startOfUtcDay(now) &&
      solicitationMs <= now + 5 * 365 * DAY_MS;
    const awardFiscalYearInWindow =
      record.estimatedAwardFiscalYear != null &&
      record.estimatedAwardFiscalYear >= currentFy &&
      record.estimatedAwardFiscalYear <= currentFy + 5;

    // If the source supplied forecast timing, require that timing itself to be
    // current/future. A stale date must not be rescued by a generic "planned"
    // or "active" status label. Status is only a fallback when timing is absent.
    if (hasForecastTiming) {
      return solicitationInWindow || awardFiscalYearInWindow;
    }
    return /forecast|planned|planning|active|open|anticipated/i.test(record.status ?? "");
  }

  if (!record.isRecompete || record.recompeteEvidence === "none") return false;

  const solicitationInWindow =
    solicitationMs != null &&
    solicitationMs >= now - 120 * DAY_MS &&
    solicitationMs <= now + 3 * 365 * DAY_MS;
  const expiryInWindow =
    expirationMs != null &&
    expirationMs >= now - 180 * DAY_MS &&
    expirationMs <= now + 3 * 365 * DAY_MS;

  // Explicit GovCon recompete flags with incumbent evidence remain useful when
  // a source omits timing fields; otherwise require a real forecast/expiry signal.
  return (
    solicitationInWindow ||
    expiryInWindow ||
    (record.recompeteEvidence === "explicit" && Boolean(record.incumbentName || record.incumbentAward))
  );
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(key);
  }
  for (const [key, timestamp] of indexedAt) {
    if (timestamp + INDEX_TTL_MS <= now) indexedAt.delete(key);
  }
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    responseCache.delete(oldestKey);
  }
}

function scheduleVectorIndex(cacheKey: string, mode: GovConFeedbackMode, records: RankedForecast[]): void {
  if (records.length === 0 || indexedAt.has(cacheKey)) return;
  indexedAt.set(cacheKey, Date.now());
  queueMicrotask(() => {
    void indexVectorDocuments(
      records.slice(0, 50).map((record) => ({
        id: `govcon:${mode}:${record.id}`,
        text: [
          record.title,
          record.agency,
          record.subAgency,
          record.description,
          record.naics,
          record.setAside,
          record.incumbentName,
        ]
          .filter(Boolean)
          .join("\n"),
        payload: {
          documentType: mode === "recompete" ? "recompete" : "forecast",
          recordId: record.id,
          title: record.title,
          agency: record.agency,
          naics: record.naics,
          source: record.source ?? "govconapi",
          sourceUrl: record.sourceUrl,
          relevanceScore: record.relevance.score,
          incumbentName: record.incumbentName,
          recompeteEvidence: record.recompeteEvidence,
        },
      })),
      { batchSize: 20 },
    )
      .then((stats) => {
        logger.info({ mode, ...stats }, "GovCon intelligence vector indexing completed");
      })
      .catch((error) => {
        indexedAt.delete(cacheKey);
        logger.warn({ err: error, mode }, "GovCon intelligence vector indexing failed");
      });
  });
}

async function fetchForecasts(
  searchParams: URLSearchParams,
  mode: GovConFeedbackMode,
  fitOnly: boolean,
  focus?: string,
): Promise<ForecastPayload> {
  const budgetName = `govcon:${mode}`;

  // Resolve filters for Tango parallel fetch
  const tangoFilters = {
    agency: searchParams.get("agency") ?? undefined,
    naics: searchParams.get("naics") ?? undefined,
  };

  // Fetch GovCon and Tango in parallel; GovCon failure does not block Tango
  const [govconResult, tangoResult] = await Promise.all([
    (async (): Promise<{ data: unknown[]; pagination: Record<string, unknown>; error: string | null }> => {
      if (!(await providerBudgetAvailable(budgetName))) {
        return { data: [], pagination: {}, error: `GovCon ${mode} requests are temporarily cooling down after an upstream quota or reliability failure.` };
      }
      const apiKey = process.env.GOVCON_API_KEY?.trim();
      if (!apiKey) {
        return { data: [], pagination: {}, error: "GOVCON_API_KEY is not configured" };
      }
      const upstreamUrl = new URL(`${GOVCON_BASE_URL}/forecasts/search`);
      searchParams.forEach((value, key) => upstreamUrl.searchParams.set(key, value));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(upstreamUrl, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          const details = (await response.text().catch(() => "")).slice(0, 300);
          const msg = `GovCon API returned ${response.status}${details ? `: ${details}` : ""}`;
          await recordProviderFailure(budgetName, new Error(msg));
          return { data: [], pagination: {}, error: msg };
        }
        const upstream = asRecord(await response.json());
        await recordProviderSuccess(budgetName, Array.isArray(upstream.data) ? (upstream.data as unknown[]).length : 0);
        return {
          data: Array.isArray(upstream.data) ? upstream.data as unknown[] : [],
          pagination: asRecord(upstream.pagination),
          error: null,
        };
      } catch (err) {
        await recordProviderFailure(budgetName, err);
        return { data: [], pagination: {}, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    })(),
    // Recompete Watch needs an incumbent: Tango forecasts never carry one, so recompete mode reads Tango's
    // expiring contracts instead of relabelling the same forecast list the Forecasts page shows.
    mode === "recompete"
      ? fetchTangoExpiringContracts(focus, tangoFilters)
      : fetchTangoForecasts(focus, tangoFilters),
  ]);
  const tangoRecords: Array<TangoForecastRecord | TangoExpiringContractRecord> = tangoResult.records;

  // If both sources failed, throw so the caller gets a proper error
  if (govconResult.error && tangoResult.error && govconResult.data.length === 0 && tangoResult.records.length === 0) {
    throw Object.assign(
      new Error(govconResult.error),
      { statusCode: govconResult.error.includes("cooling down") ? 429 : govconResult.error.includes("not configured") ? 503 : 502 },
    );
  }

  const data = govconResult.data;
  const pagination = govconResult.pagination;
  const normalized = data.map(normalizeForecast);
  const semantic = normalized.filter((record) => isGovConSemanticCandidate(record, mode));

  // Tango records pass the same forward-looking / recompete gate as GovCon records before suppression and ranking.
  const tangoCandidates = tangoRecords.filter((record) => isGovConSemanticCandidate(record, mode));
  const allCandidates = [...semantic, ...tangoCandidates];

  const suppressions = await loadGovConSuppressions(mode).catch((error) => {
    logger.warn({ err: error, mode }, "GovCon feedback could not be loaded; continuing without persistent suppression");
    return { recordIds: new Set<string>(), fingerprints: new Set<string>() };
  });
  const unsuppressed = allCandidates.filter((record) => !isGovConRecordSuppressed(suppressions, record));
  const ranked = await rankGovConRecords(unsuppressed, mode, focus);
  const lowRelevanceCount = ranked.filter((record) => record.relevance.verdict === "reject").length;
  const records = fitOnly
    ? ranked.filter((record) => record.relevance.verdict !== "reject")
    : ranked;

  return {
    records,
    pagination: {
      limit: asNumber(pagination.limit) ?? boundedInteger(searchParams.get("limit"), 50, 1, 100),
      offset: asNumber(pagination.offset) ?? boundedInteger(searchParams.get("offset"), 0, 0, 100_000),
      total: asNumber(pagination.total) ?? (data.length + tangoRecords.length),
      hasNext: asBoolean(pagination.has_next),
    },
    sourcePageRecords: normalized.length + tangoResult.rawCount,
    semanticRejectedCount: normalized.length - semantic.length,
    suppressedCount: allCandidates.length - unsuppressed.length,
    lowRelevanceCount,
    filtersApplied: asRecord(govconResult.pagination),
    semanticProvider: records.some((record) => record.relevance.provider === "gemini") ? "gemini" : "deterministic",
    source: "govconapi",
    fetchedAt: new Date().toISOString(),
  };
}

router.get("/govcon/forecasts", async (req, res) => {
  const params = new URLSearchParams();
  const limit = boundedInteger(req.query.limit, 50, 1, 100);
  const offset = boundedInteger(req.query.offset, 0, 0, 100_000);
  const mode: GovConFeedbackMode = req.query.recompete === "true" ? "recompete" : "forecast";
  const fitOnly = req.query.fitOnly !== "false";
  const focus = stringQuery(req.query.focus ?? req.query.keywords, 200);

  params.set("limit", String(limit));
  params.set("offset", String(offset));
  params.set("active_only", "true");
  params.set("sort_by", stringQuery(req.query.sortBy, 40) ?? "est_award_fy");
  params.set("sort_order", stringQuery(req.query.sortOrder, 8) === "desc" ? "desc" : "asc");

  const optionalFilters: Array<[string, unknown, number]> = [
    ["keywords", req.query.keywords, 120],
    ["agency", req.query.agency, 120],
    ["naics", req.query.naics, 6],
    ["source", req.query.source, 20],
    ["set_aside", req.query.setAside, 40],
    ["state", req.query.state, 2],
  ];

  for (const [key, value, maxLength] of optionalFilters) {
    const parsed = stringQuery(value, maxLength);
    if (parsed) params.set(key, parsed);
  }

  if (mode === "recompete") params.set("is_recompete", "true");

  const cacheKey = `${mode}|fit:${fitOnly}|focus:${focus ?? ""}|${params.toString()}`;
  pruneCache();
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    scheduleVectorIndex(cacheKey, mode, cached.payload.records);
    return res.json({ ...cached.payload, cached: true });
  }

  try {
    let request = inFlight.get(cacheKey);
    if (!request) {
      request = fetchForecasts(params, mode, fitOnly, focus);
      inFlight.set(cacheKey, request);
    }

    const payload = await request;
    responseCache.set(cacheKey, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
    scheduleVectorIndex(cacheKey, mode, payload.records);
    return res.json({ ...payload, cached: false });
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number }).statusCode) || 502;
    const message = error instanceof Error ? error.message : "Failed to retrieve GovCon forecasts";
    logger.error({ err: error, filters: Object.fromEntries(params) }, "GovCon forecast request failed");
    return res.status(statusCode).json({ error: message });
  } finally {
    inFlight.delete(cacheKey);
  }
});

router.post("/govcon/feedback", async (req, res) => {
  const mode: GovConFeedbackMode = req.body?.mode === "recompete" ? "recompete" : "forecast";
  const action = req.body?.action === "restore_all" ? "restore_all" : "not_relevant";
  try {
    if (action === "restore_all") {
      const restored = await restoreGovConFeedback(mode);
      responseCache.clear();
      return res.json({ ok: true, restored });
    }

    const recordId = stringQuery(req.body?.recordId, 500);
    const title = stringQuery(req.body?.title, 500);
    const agency = stringQuery(req.body?.agency, 300);
    if (!recordId || !title || !agency) {
      return res.status(400).json({ error: "recordId, title, and agency are required" });
    }
    await saveGovConNotRelevant({ mode, recordId, title, agency });
    responseCache.clear();
    return res.json({ ok: true });
  } catch (error) {
    logger.error({ err: error, mode, action }, "GovCon feedback persistence failed");
    return res.status(500).json({ error: error instanceof Error ? error.message : "Feedback could not be saved" });
  }
});

router.post("/govcon/recompete-verify", async (req, res) => {
  const id = stringQuery(req.body?.id, 500);
  const title = stringQuery(req.body?.title, 500);
  const agency = stringQuery(req.body?.agency, 300);
  if (!id || !title || !agency) {
    return res.status(400).json({ error: "id, title, and agency are required" });
  }

  try {
    const result = await verifyRecompete({
      id,
      title,
      agency,
      naics: stringQuery(req.body?.naics, 6) ?? null,
      incumbentName: stringQuery(req.body?.incumbentName, 300) ?? null,
    });
    return res.json(result);
  } catch (error) {
    logger.error({ err: error, id }, "Recompete verification failed");
    return res.status(502).json({ error: error instanceof Error ? error.message : "Official award verification failed" });
  }
});

router.post("/govcon/budget-reset", async (req, res) => {
  const { adminReadAllowed } = await import("../middleware/api-hardening");
  if (!adminReadAllowed(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const { rfpDb, settingsTable } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");
    const { clearProviderBudgetMemory } = await import("../lib/providerBudget");

    const keys = [
      "provider-budget:v2:govcon:forecast",
      "provider-budget:v2:govcon:recompete",
    ];
    const result = await rfpDb
      .delete(settingsTable)
      .where(inArray(settingsTable.key, keys));
    clearProviderBudgetMemory();
    responseCache.clear();
    logger.info({ deleted: result.rowCount ?? 0 }, "GovCon budget cooldown reset");
    return res.json({
      ok: true,
      deleted: result.rowCount ?? 0,
      message: "GovCon budget cooldown cleared. Retry the Recompete Watch page.",
    });
  } catch (error) {
    logger.error({ err: error }, "GovCon budget reset failed");
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Reset failed",
    });
  }
});

export default router;
