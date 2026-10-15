/**
 * Tango Provider (Procurement Intelligence)
 *
 * Uses Tango by MakeGov's opportunity API with bounded pagination.
 */

import type {
  DataSourceProvider,
  FetchOptions,
  NormalizedOpportunity,
  ProviderFetchResult,
  ProviderStatus,
} from "./types";
import { resolveCredential } from "../config/providerConfig";
import { profileSemanticQuery } from "./profileQueryTerms";

const TANGO_DEFAULT_BASE = "https://tango.makegov.com/api/";
const UNKNOWN_POSTED_DATE = new Date(0);
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RECORD_LIMIT = 500;
const MAX_PAGE_SIZE = 100;
const TANGO_SEMANTIC_QUERY_MAX_CHARS = 300;

interface TangoOpportunity {
  opportunity_id: string;
  title?: string;
  active?: boolean;
  first_notice_date?: string;
  last_notice_date?: string;
  response_deadline?: string;
  naics_code?: string;
  psc_code?: string;
  meta?: {
    notice_type?: {
      code?: string;
      type?: string;
    } | null;
  } | null;
  office?: {
    agency_name?: string;
    department_name?: string;
  } | null;
  place_of_performance?: {
    city?: string;
    state?: string;
    country?: string;
  } | null;
  sam_url?: string;
  set_aside?: string;
  solicitation_number?: string;
  description?: string;
}

interface TangoListResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: TangoOpportunity[];
}

/**
 * Plain text from a Tango field. Tango sends some fields as strings and others as `{ code, description }` objects (or
 * numbers); the ingestion pipeline calls `.trim()` on these, so a non-string value fails every record that carries it
 * ("e?.trim is not a function") and nothing from the provider is stored.
 */
export function tangoText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["description", "name", "title", "display_name", "label", "type", "code", "value"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return undefined;
}

function parsedDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function integerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(10_000, Math.max(250, seconds * 1_000));
    }
    const retryAt = new Date(retryAfter).getTime();
    if (Number.isFinite(retryAt)) {
      return Math.min(10_000, Math.max(250, retryAt - Date.now()));
    }
  }
  return Math.min(5_000, 500 * 2 ** attempt);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class TangoProvider implements DataSourceProvider {
  readonly name = "tango" as const;

  private async getApiKey(): Promise<string | null> {
    return resolveCredential("tangoApiKey", "TANGO_API_KEY");
  }

  private async getBaseUrl(): Promise<string> {
    const custom = await resolveCredential("tangoBaseUrl", "TANGO_BASE_URL");
    const configured = custom || TANGO_DEFAULT_BASE;
    return configured.endsWith("/") ? configured : `${configured}/`;
  }

  async isConfigured(): Promise<boolean> {
    return !!(await this.getApiKey());
  }

  private static fmtDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  private normalize(
    opportunity: TangoOpportunity,
    pageNumber: number,
  ): NormalizedOpportunity {
    const placeParts: string[] = [];
    const place = opportunity.place_of_performance;
    const city = tangoText(place?.city);
    const state = tangoText(place?.state);
    const country = tangoText(place?.country);
    if (city) placeParts.push(city);
    if (state) placeParts.push(state);
    if (country && country !== "United States" && country !== "USA") {
      placeParts.push(country);
    }

    const postedDate = parsedDate(opportunity.first_notice_date);
    return {
      externalId: tangoText(opportunity.opportunity_id) ?? "",
      title: tangoText(opportunity.title) || "Untitled Opportunity",
      agency: tangoText(opportunity.office?.agency_name) || "Unknown Agency",
      subAgency: tangoText(opportunity.office?.department_name),
      type: tangoText(opportunity.meta?.notice_type?.type) || "Solicitation",
      status: opportunity.active ? "active" : "archived",
      naicsCode: tangoText(opportunity.naics_code),
      postedDate: postedDate ?? UNKNOWN_POSTED_DATE,
      responseDeadline: parsedDate(opportunity.response_deadline),
      setAside: tangoText(opportunity.set_aside),
      placeOfPerformance:
        placeParts.length > 0 ? placeParts.join(", ") : undefined,
      description: tangoText(opportunity.description),
      solicitationNumber: tangoText(opportunity.solicitation_number),
      sourceUrl: tangoText(opportunity.sam_url),
      source: this.name,
      providerName: this.name,
      rawData: {
        providerName: "tango",
        providerFamily: "direct_procurement_api",
        providerType: "tango_makegov_api",
        discoveryMethod: "direct_api",
        sourceConfidence: "high",
        dateUnknown: !postedDate,
        listingPageNumber: pageNumber,
        paginationMode: "bounded_api_next_link",
        tags: [
          "direct-api",
          "tango",
          ...(!postedDate ? ["date-unknown"] : []),
        ],
        notes:
          "Collected directly from the configured Tango by MakeGov opportunity API using bounded pagination.",
        tango: opportunity,
      },
    };
  }

  private async fetchPage(
    url: URL,
    apiKey: string,
    allowedOrigin: string,
    timeoutMs: number,
    maxRetries: number,
  ): Promise<TangoListResponse> {
    if (url.origin !== allowedOrigin) {
      throw new Error(
        `Tango API returned a pagination URL outside the configured API origin: ${url.origin}`,
      );
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          headers: {
            "X-API-KEY": apiKey,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (response.ok) {
          const payload = (await response.json()) as TangoListResponse;
          return {
            count: Number.isFinite(payload.count) ? payload.count : 0,
            next: typeof payload.next === "string" ? payload.next : null,
            previous:
              typeof payload.previous === "string" ? payload.previous : null,
            results: Array.isArray(payload.results) ? payload.results : [],
          };
        }

        const responseText = await response.text().catch(() => "");
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxRetries) {
          await wait(retryDelayMs(response, attempt));
          continue;
        }
        throw new Error(
          `Tango API error ${response.status}: ${responseText.slice(0, 300)}`,
        );
      } catch (error) {
        const timedOut = controller.signal.aborted;
        if (attempt < maxRetries && (timedOut || error instanceof TypeError)) {
          await wait(Math.min(5_000, 500 * 2 ** attempt));
          continue;
        }
        if (timedOut) {
          throw new Error(`Tango API request timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error("Tango API request failed after retry limit");
  }

  /**
   * Targeted queries instead of one unfiltered pull of every active federal
   * notice. Tango supports server-side naics/psc filters (multi-value with "|")
   * and a vector-backed search, so each query asks for what Occu-Med buys.
   * Codes and search text come from the Occu-Med relevance profile, read at
   * call time (no vocabulary lives here). Set TANGO_CODE_QUERIES=false to fall back to a single query.
   */
  private async buildQueries(
    keywords: string | undefined,
  ): Promise<Array<{ label: string; params: Record<string, string> }>> {
    const focus = keywords?.trim();
    if (focus) return [{ label: "keywords", params: { search: focus } }];
    if (process.env.TANGO_CODE_QUERIES === "false") {
      return [{ label: "unfiltered", params: {} }];
    }
    try {
      const { getOccuMedSearchProfile } = await import("../search/occumedSearchProfile");
      const profile = await getOccuMedSearchProfile();
      const queries: Array<{ label: string; params: Record<string, string> }> = [];
      if (profile.naics.length > 0) queries.push({ label: "naics", params: { naics: profile.naics.join("|") } });
      if (profile.psc.length > 0) queries.push({ label: "psc", params: { psc: profile.psc.join("|") } });
      const phrases = profile.directPhrases.slice(0, 3);
      queries.push({
        label: "semantic",
        params: { search: [profileSemanticQuery(TANGO_SEMANTIC_QUERY_MAX_CHARS), ...phrases].join(" ").trim().slice(0, TANGO_SEMANTIC_QUERY_MAX_CHARS) },
      });
      return queries;
    } catch {
      return [{ label: "semantic", params: { search: profileSemanticQuery(TANGO_SEMANTIC_QUERY_MAX_CHARS) } }];
    }
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        "Tango API key not configured. Set TANGO_API_KEY in environment or Settings.",
      );
    }

    const baseUrl = await this.getBaseUrl();
    const endpoint = new URL("opportunities/", baseUrl);
    const allowedOrigin = endpoint.origin;
    const today = new Date();
    const dateRange = Math.max(1, options.dateRange ?? 30);
    const fromDate = new Date(today);
    fromDate.setDate(today.getDate() - dateRange);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, options.limit ?? 50),
    );
    const maxPages = integerEnv(
      "TANGO_MAX_PAGES",
      DEFAULT_MAX_PAGES,
      1,
      25,
    );
    const recordLimit = Math.min(MAX_RECORD_LIMIT, pageSize * maxPages);
    const timeoutMs = integerEnv(
      "TANGO_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
      2_000,
      120_000,
    );
    const maxRetries = integerEnv(
      "TANGO_MAX_RETRIES",
      DEFAULT_MAX_RETRIES,
      0,
      5,
    );

    endpoint.searchParams.set(
      "first_notice_date_after",
      TangoProvider.fmtDate(fromDate),
    );
    endpoint.searchParams.set(
      "first_notice_date_before",
      TangoProvider.fmtDate(today),
    );
    endpoint.searchParams.set("active", "true");
    endpoint.searchParams.set("notice_type", "o|k");
    endpoint.searchParams.set(
      "response_deadline_after",
      TangoProvider.fmtDate(today),
    );
    endpoint.searchParams.set(
      "response_deadline_before",
      TangoProvider.fmtDate(
        new Date(
          today.getFullYear() + 1,
          today.getMonth(),
          today.getDate(),
        ),
      ),
    );
    endpoint.searchParams.set(
      "shape",
      "opportunity_id,title,active,first_notice_date,last_notice_date,response_deadline,naics_code,psc_code,office(*),place_of_performance(*),sam_url,set_aside,solicitation_number,description,meta(*)",
    );
    endpoint.searchParams.set("limit", String(pageSize));
    endpoint.searchParams.set("page", "1");
    endpoint.searchParams.set("ordering", "-first_notice_date");

    const queries = await this.buildQueries(options.keywords);
    const pagesPerQuery = Math.max(1, Math.ceil(maxPages / queries.length));

    const records: NormalizedOpportunity[] = [];
    const errors: string[] = [];
    const seenOpportunityIds = new Set<string>();
    const queryStats: Array<{ label: string; returned: number; added: number; pages: number }> = [];
    let reportedTotal = 0;
    let firstError: unknown = null;

    for (const query of queries) {
      if (records.length >= recordLimit) break;
      const first = new URL(endpoint.toString());
      for (const [key, value] of Object.entries(query.params)) first.searchParams.set(key, value);

      const seenPageUrls = new Set<string>();
      let currentUrl: URL | null = first;
      let pageNumber = 0;
      let returned = 0;
      let added = 0;

      while (currentUrl && pageNumber < pagesPerQuery && records.length < recordLimit) {
        const pageKey = currentUrl.toString();
        if (seenPageUrls.has(pageKey)) {
          errors.push(`Tango ${query.label} pagination stopped because the API repeated a page URL.`);
          break;
        }
        seenPageUrls.add(pageKey);
        pageNumber += 1;

        let page: TangoListResponse;
        try {
          page = await this.fetchPage(currentUrl, apiKey, allowedOrigin, timeoutMs, maxRetries);
        } catch (error) {
          firstError ??= error;
          errors.push(
            `Tango ${query.label} query page ${pageNumber} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          break;
        }

        reportedTotal = Math.max(reportedTotal, page.count || 0);
        for (const opportunity of page.results) {
          if (!opportunity?.opportunity_id) continue;
          returned += 1;
          if (seenOpportunityIds.has(opportunity.opportunity_id)) continue;
          seenOpportunityIds.add(opportunity.opportunity_id);
          const record = this.normalize(opportunity, pageNumber);
          record.rawData = { ...(record.rawData ?? {}), tangoQuery: query.label };
          records.push(record);
          added += 1;
          if (records.length >= recordLimit) break;
        }

        currentUrl =
          page.next && records.length < recordLimit
            ? new URL(page.next, currentUrl)
            : null;
      }
      queryStats.push({ label: query.label, returned, added, pages: pageNumber });
    }

    // Every query failed and nothing was retained: surface the real error so
    // the provider budget and cooldown logic see it (e.g. a 429).
    if (records.length === 0 && firstError) throw firstError;

    return {
      records,
      total: reportedTotal || records.length,
      errors,
      diagnostics: {
        queryCount: queries.length,
        queries: queryStats.map((stat) => stat.label),
        tangoQueryStats: queryStats,
        targetedQueries: queries.every((query) => query.label !== "unfiltered"),
      },
    };
  }

  async getStatus(): Promise<ProviderStatus> {
    const configured = await this.isConfigured();
    return {
      name: this.name,
      configured,
      healthy: configured,
    };
  }
}

export const tangoProvider = new TangoProvider();
