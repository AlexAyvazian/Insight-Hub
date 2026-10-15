/**
 * OpenGov Shared Procurement Adapter
 *
 * Collects publicly accessible solicitation data from the OpenGov
 * Procurement platform used by state, county, city, school district, and
 * special-district buyers.
 *
 * Every buyer on the OpenGov platform operates under its own tenant slug.
 * All catalog entries with domain "procurement.opengov.com" are routed
 * through this single adapter via the tenant configuration below.
 *
 * Public interface used:
 *   GET https://procurement.opengov.com/api/v2/portal/{tenant}/projects
 *   Query params: page (1-based), per_page (max 25), status (open|all)
 *
 * This is a publicly documented, unauthenticated endpoint — no credentials
 * or API key are required.  The embed URL pattern
 * (procurement.opengov.com/portal/embed/{tenant}/project-list) serves an
 * iframe shell; the structured project data is fetched from the API path.
 *
 * Identity / deduplication:
 *   Stable ID = "opengov-{tenantSlug}-{projectId}"  where projectId comes
 *   from the project's numeric or string id field in the API response.
 *   The canonical source URL is:
 *     https://procurement.opengov.com/portal/{tenant}/project/{id}
 *
 * Reliability controls:
 *   - Per-request AbortController timeout
 *   - Bounded retries with exponential back-off for 429/5xx
 *   - Per-tenant page cap (OPENGOV_MAX_PAGES, default 5)
 *   - Per-tenant result cap (OPENGOV_MAX_RESULTS_PER_TENANT, default 50)
 *   - Bounded concurrency across tenants (OPENGOV_CONCURRENCY, default 3)
 *   - Partial results preserved when one tenant fails
 *   - Same-run deduplication by stable ID
 *   - No global deadline that starves later tenants (each tenant has its
 *     own independent timeout budget)
 */

import { createHash } from "crypto";
import type {
  DataSourceProvider,
  FetchOptions,
  NormalizedOpportunity,
  ProviderFetchResult,
  ProviderStatus,
} from "./types";
import { positiveIntegerEnv } from "./officialPortalHttp";

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENGOV_API_ORIGIN = "https://procurement.opengov.com";
const OPENGOV_PORTAL_ORIGIN = "https://procurement.opengov.com";
const USER_AGENT =
  "OccuMed-InsightHub/1.0 public-procurement-reader (+https://www.occumed.com)";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_RESULTS_PER_TENANT = 50;
const DEFAULT_CONCURRENCY = 3;
const PAGE_SIZE = 25; // OpenGov public API max per_page

// ─── Tenant Map ───────────────────────────────────────────────────────────────
//
// Maps every portal catalog ID (from directRfpPortals.generated.041.ts) to its
// OpenGov tenant slug, buyer display name, jurisdiction, and state.
// "tenantSlug" is the subdirectory segment used in both the API path
// (/api/v2/portal/{slug}/projects) and the canonical portal URL
// (/portal/{slug}/project/{id}).

export interface OpenGovTenant {
  /** Portal catalog ID (matches DirectRfpPortal.id) */
  portalId: string;
  /** OpenGov platform tenant slug */
  tenantSlug: string;
  /** Official buyer/government entity name shown to users */
  buyerName: string;
  /** US state two-letter code */
  state: string;
  /** Connector capability for this tenant */
  capability:
    | "dedicated_listing_and_detail"
    | "dedicated_listing"
    | "directory_only"
    | "login_required";
  /** Human-readable reason for non-collection entries */
  capabilityReason?: string;
}

export const OPENGOV_TENANTS: OpenGovTenant[] = [
  {
    portalId: "ca-city-of-santa-cruz-opengov",
    tenantSlug: "santacruzca",
    buyerName: "City of Santa Cruz",
    state: "CA",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "ca-city-of-palm-desert-opengov",
    tenantSlug: "cityofpalmdesert",
    buyerName: "City of Palm Desert",
    state: "CA",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "ca-city-of-west-sacramento-opengov",
    tenantSlug: "cityofwestsacramento",
    buyerName: "City of West Sacramento",
    state: "CA",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "pa-scranton-city-school-district-opengov",
    tenantSlug: "ssdedu",
    buyerName: "Scranton City School District",
    state: "PA",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "fl-monroe-county-school-district-opengov",
    tenantSlug: "keyschools-mcsd",
    buyerName: "Monroe County School District",
    state: "FL",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "nj-passaic-city-school-district-opengov",
    tenantSlug: "passaicschools",
    buyerName: "Passaic City School District",
    state: "NJ",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "fl-volusia-county-opengov",
    tenantSlug: "volusia",
    buyerName: "Volusia County",
    state: "FL",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "fl-pinellas-county-school-district-opengov",
    tenantSlug: "pcsb",
    buyerName: "Pinellas County School District",
    state: "FL",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "nj-jersey-city-public-schools-opengov",
    tenantSlug: "jcboe",
    buyerName: "Jersey City Public Schools",
    state: "NJ",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "fl-santa-rosa-county-opengov",
    tenantSlug: "santarosafl",
    buyerName: "Santa Rosa County",
    state: "FL",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "oh-cleveland-metropolitan-school-district-opengov",
    tenantSlug: "clevelandmetroschools",
    buyerName: "Cleveland Metropolitan School District",
    state: "OH",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "ca-san-bernardino-city-unified-school-district-opengov",
    tenantSlug: "sbcusd",
    buyerName: "San Bernardino City Unified School District",
    state: "CA",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "fl-alachua-county-opengov",
    tenantSlug: "alachuacounty",
    buyerName: "Alachua County",
    state: "FL",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "va-richmond-public-schools-opengov",
    tenantSlug: "rvaschools",
    buyerName: "Richmond Public Schools",
    state: "VA",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "fl-clay-county-opengov",
    tenantSlug: "claycounty",
    buyerName: "Clay County",
    state: "FL",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "az-chandler-unified-school-district-opengov",
    tenantSlug: "cusd80",
    buyerName: "Chandler Unified School District",
    state: "AZ",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "md-wicomico-county-opengov",
    tenantSlug: "wicomicocounty",
    buyerName: "Wicomico County",
    state: "MD",
    capability: "dedicated_listing_and_detail",
  },
  {
    portalId: "sc-richland-school-district-two-opengov",
    tenantSlug: "richland2",
    buyerName: "Richland School District Two",
    state: "SC",
    capability: "dedicated_listing_and_detail",
  },
];

// Build lookup maps for fast access
export const OPENGOV_TENANT_BY_PORTAL_ID = new Map<string, OpenGovTenant>(
  OPENGOV_TENANTS.map((tenant) => [tenant.portalId, tenant]),
);

export const OPENGOV_PORTAL_IDS = new Set<string>(
  OPENGOV_TENANTS.map((tenant) => tenant.portalId),
);

// ─── API Types ────────────────────────────────────────────────────────────────

interface OpenGovProject {
  id: number | string;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  project_type?: string | null;
  solicitation_number?: string | null;
  published_at?: string | null;
  due_at?: string | null;
  close_at?: string | null;
  location?: string | null;
  department?: {
    name?: string | null;
  } | null;
  documents?: Array<{
    id?: number | string;
    name?: string | null;
    url?: string | null;
    public?: boolean;
  }> | null;
}

interface OpenGovProjectsResponse {
  data?: OpenGovProject[];
  meta?: {
    total?: number;
    page?: number;
    per_page?: number;
    total_pages?: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function openGovAbortError(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${label} cancelled`);
}

function throwIfOpenGovAborted(signal: AbortSignal, label: string): void {
  if (signal.aborted) throw openGovAbortError(signal, label);
}

function sleep(
  milliseconds: number,
  signal: AbortSignal,
  label: string,
): Promise<void> {
  throwIfOpenGovAborted(signal, label);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(openGovAbortError(signal, label));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function safeDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function canonicalProjectUrl(
  tenantSlug: string,
  projectId: number | string,
): string {
  return `${OPENGOV_PORTAL_ORIGIN}/portal/${tenantSlug}/project/${projectId}`;
}

function stableOpportunityId(
  tenantSlug: string,
  projectId: number | string,
): string {
  return `opengov-${tenantSlug}-${projectId}`;
}

function stableOpportunityIdFromUrl(canonicalUrl: string): string {
  // Fallback ID derived from URL SHA-256 when project ID is unavailable.
  const hash = createHash("sha256")
    .update(canonicalUrl)
    .digest("hex")
    .slice(0, 24);
  return `opengov-url-${hash}`;
}

function publicDocumentUrls(project: OpenGovProject): string[] {
  if (!Array.isArray(project.documents)) return [];
  return project.documents
    .filter((doc) => doc.public !== false && doc.url)
    .map((doc) => doc.url as string)
    .filter(Boolean);
}

function normalizeStatus(
  rawStatus: string | null | undefined,
): "active" | "archived" {
  if (!rawStatus) return "active";
  const lower = rawStatus.toLowerCase();
  if (
    lower === "closed" ||
    lower === "awarded" ||
    lower === "cancelled" ||
    lower === "archived"
  )
    return "archived";
  return "active";
}

function normalizeType(projectType: string | null | undefined): string {
  if (!projectType) return "Solicitation";
  const lower = projectType.toLowerCase();
  if (lower.includes("rfp")) return "RFP";
  if (lower.includes("rfq")) return "RFQ";
  if (lower.includes("rfi")) return "RFI";
  if (lower.includes("bid") || lower.includes("ifb") || lower.includes("itb"))
    return "Bid";
  return projectType;
}

function projectToOpportunity(
  project: OpenGovProject,
  tenant: OpenGovTenant,
  listingPage: number,
): NormalizedOpportunity | null {
  if (!project.id) return null;

  const projectId = project.id;
  const canonicalUrl = canonicalProjectUrl(tenant.tenantSlug, projectId);
  const externalId = stableOpportunityId(tenant.tenantSlug, projectId);

  // Do not fabricate missing dates.
  const postedDate = safeDate(project.published_at);
  const responseDeadline = safeDate(project.close_at ?? project.due_at);
  const docUrls = publicDocumentUrls(project);

  const title = project.title?.trim() || null;
  if (!title) return null; // Require at least a title to produce a record.

  const description = project.description?.trim() || null;
  const subAgency = project.department?.name?.trim() || undefined;

  return {
    externalId,
    title,
    agency: tenant.buyerName,
    subAgency,
    type: normalizeType(project.project_type),
    status: normalizeStatus(project.status),
    placeOfPerformance: project.location ?? `${tenant.state}`,
    postedDate: postedDate ?? new Date(0),
    responseDeadline,
    solicitationNumber: project.solicitation_number?.trim() || undefined,
    sourceUrl: canonicalUrl,
    description: description ?? undefined,
    source: "publicPortalProviders",
    providerName: "publicPortalProviders",
    rawData: {
      // Connector identity
      providerFamily: "official_public_portal",
      providerPlatform: "opengov",
      providerType: "opengov_public_api",
      connectorName: "OpenGov shared adapter",
      discoveryMethod: "dedicated_official_adapter",
      sourceBadge: "OpenGov Official Portal",
      sourceConfidence: "high",

      // Buyer identity (separate from connector identity)
      sourceId: tenant.portalId,
      buyerName: tenant.buyerName,
      buyerState: tenant.state,
      tenantSlug: tenant.tenantSlug,

      // Provenance
      openGovProjectId: String(projectId),
      listingPage,
      canonicalUrl,
      originalListingUrl: canonicalUrl,
      collectedAt: new Date().toISOString(),

      // Document URLs (publicly accessible attachments when available)
      documentUrls: docUrls,
      documentCount: docUrls.length,

      // Date quality flags — never fabricated
      dateUnknown: !postedDate,
      deadlineUnknown: !responseDeadline,

      // Tags
      tags: [
        "direct-official-portal",
        "opengov-platform",
        `state:${tenant.state}`,
        `tenant:${tenant.tenantSlug}`,
        `portal:${tenant.portalId}`,
        ...(docUrls.length > 0 ? ["has-public-documents"] : []),
        ...(!postedDate ? ["date-unknown"] : []),
      ],
    },
  };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchOpenGovPage(
  tenantSlug: string,
  page: number,
  timeoutMs: number,
  maxRetries: number,
  signal: AbortSignal,
): Promise<OpenGovProjectsResponse> {
  const label = `OpenGov [${tenantSlug}] page ${page}`;
  const url = new URL(
    `${OPENGOV_API_ORIGIN}/api/v2/portal/${tenantSlug}/projects`,
  );
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("status", "open");

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    throwIfOpenGovAborted(signal, label);

    const controller = new AbortController();
    // Combine the per-request timeout with the outer cancellation signal.
    const timeoutId = setTimeout(
      () =>
        controller.abort(
          new DOMException(
            `${label} timed out after ${timeoutMs}ms`,
            "TimeoutError",
          ),
        ),
      timeoutMs,
    );
    const onCancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onCancel, { once: true });

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
      });

      if (response.ok) {
        const json = (await response.json()) as OpenGovProjectsResponse;
        return json;
      }

      const retryable = response.status === 429 || response.status >= 500;
      const bodySnippet = await response
        .text()
        .then((text) => text.slice(0, 160))
        .catch(() => "");
      const message = `OpenGov [${tenantSlug}] page ${page} HTTP ${response.status}${bodySnippet ? `: ${bodySnippet}` : ""}`;

      if (!retryable || attempt >= maxRetries) {
        lastError = new Error(message);
        break;
      }

      const retryAfterSec = Number.parseInt(
        response.headers.get("retry-after") ?? "",
        10,
      );
      const delayMs = Number.isFinite(retryAfterSec)
        ? Math.min(retryAfterSec * 1000, 15_000)
        : 500 * 2 ** attempt;
      lastError = new Error(message);
      await sleep(delayMs, signal, label);
    } catch (error) {
      throwIfOpenGovAborted(signal, label);
      const err =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
          ? new Error(
              `OpenGov [${tenantSlug}] page ${page} timed out after ${timeoutMs}ms`,
            )
          : error;
      lastError = err;
      if (attempt >= maxRetries) break;
      await sleep(500 * 2 ** attempt, signal, label);
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onCancel);
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`OpenGov [${tenantSlug}] page ${page} request failed`);
}

// ─── Per-tenant collection ────────────────────────────────────────────────────

interface TenantResult {
  portalId: string;
  tenantSlug: string;
  records: NormalizedOpportunity[];
  error?: string;
  pagesFetched: number;
  total?: number;
}

async function collectTenant(
  tenant: OpenGovTenant,
  maxPages: number,
  maxResults: number,
  timeoutMs: number,
  maxRetries: number,
  outerSignal: AbortSignal,
): Promise<TenantResult> {
  const records: NormalizedOpportunity[] = [];
  const seenIds = new Set<string>();

  for (
    let page = 1;
    page <= maxPages && records.length < maxResults;
    page += 1
  ) {
    if (outerSignal.aborted) {
      return {
        portalId: tenant.portalId,
        tenantSlug: tenant.tenantSlug,
        records,
        pagesFetched: page - 1,
        error: "cancelled",
      };
    }

    let response: OpenGovProjectsResponse;
    try {
      response = await fetchOpenGovPage(
        tenant.tenantSlug,
        page,
        timeoutMs,
        maxRetries,
        outerSignal,
      );
    } catch (error) {
      throwIfOpenGovAborted(outerSignal, `OpenGov tenant ${tenant.tenantSlug}`);
      const reason = error instanceof Error ? error.message : String(error);
      // Preserve any records already collected from earlier pages.
      return {
        portalId: tenant.portalId,
        tenantSlug: tenant.tenantSlug,
        records,
        pagesFetched: page - 1,
        error: reason,
      };
    }

    const projects = response.data ?? [];
    for (const project of projects) {
      const opportunity = projectToOpportunity(project, tenant, page);
      if (!opportunity) continue;

      // Same-run deduplication by stable ID.
      if (seenIds.has(opportunity.externalId)) continue;
      seenIds.add(opportunity.externalId);
      records.push(opportunity);

      if (records.length >= maxResults) break;
    }

    // Stop pagination when the API returns an empty page or we have
    // reached the last page reported in meta.
    const totalPages = response.meta?.total_pages;
    if (
      projects.length === 0 ||
      (totalPages !== undefined && page >= totalPages)
    ) {
      return {
        portalId: tenant.portalId,
        tenantSlug: tenant.tenantSlug,
        records,
        pagesFetched: page,
        total: response.meta?.total,
      };
    }
  }

  return {
    portalId: tenant.portalId,
    tenantSlug: tenant.tenantSlug,
    records,
    pagesFetched: maxPages,
  };
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const slots = Math.min(Math.max(concurrency, 1), items.length || 1);
  await Promise.all(
    Array.from({ length: slots }, async () => {
      while (true) {
        if (signal?.aborted) return;
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) return;
        await worker(item);
      }
    }),
  );
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class OpenGovProvider implements DataSourceProvider {
  readonly name = "publicPortalProviders" as const;

  private readonly tenants: readonly OpenGovTenant[];

  constructor(tenants: readonly OpenGovTenant[] = OPENGOV_TENANTS) {
    this.tenants = tenants;
  }

  async isConfigured(): Promise<boolean> {
    // No credentials required — the OpenGov public API is unauthenticated.
    return true;
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    const outerSignal = options.signal ?? new AbortController().signal;
    throwIfOpenGovAborted(outerSignal, "OpenGov adapter");
    const maxPages = positiveIntegerEnv(
      "OPENGOV_MAX_PAGES",
      DEFAULT_MAX_PAGES,
      1,
      20,
    );
    const maxResultsPerTenant = positiveIntegerEnv(
      "OPENGOV_MAX_RESULTS_PER_TENANT",
      DEFAULT_MAX_RESULTS_PER_TENANT,
      1,
      500,
    );
    const concurrency = positiveIntegerEnv(
      "OPENGOV_CONCURRENCY",
      DEFAULT_CONCURRENCY,
      1,
      10,
    );
    const timeoutMs = positiveIntegerEnv(
      "OPENGOV_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
      3_000,
      60_000,
    );
    const maxRetries = positiveIntegerEnv(
      "OPENGOV_MAX_RETRIES",
      DEFAULT_MAX_RETRIES,
      0,
      5,
    );

    const overallLimit = Math.max(
      options.limit ?? this.tenants.length * maxResultsPerTenant,
      1,
    );

    const allRecords: NormalizedOpportunity[] = [];
    const allErrors: string[] = [];
    const seenGlobalIds = new Set<string>();

    const collectibleTenants = this.tenants.filter(
      (tenant) =>
        tenant.capability === "dedicated_listing_and_detail" ||
        tenant.capability === "dedicated_listing",
    );

    await runWithConcurrency(
      collectibleTenants,
      concurrency,
      async (tenant) => {
        const result = await collectTenant(
          tenant,
          maxPages,
          maxResultsPerTenant,
          timeoutMs,
          maxRetries,
          outerSignal,
        );

        if (result.error) {
          allErrors.push(`${tenant.portalId}: ${result.error}`);
        }
        // One line per tenant so a run's logs show which OpenGov portals answered (and with which HTTP status).
        console.log(
          JSON.stringify({
            event: "opengov_tenant_result",
            tenant: tenant.tenantSlug,
            records: result.records.length,
            pagesFetched: result.pagesFetched,
            error: result.error ?? null,
          }),
        );

        // Cross-tenant deduplication (same project appearing on two tenants).
        for (const record of result.records) {
          if (seenGlobalIds.has(record.externalId)) continue;
          seenGlobalIds.add(record.externalId);
          allRecords.push(record);
          if (allRecords.length >= overallLimit) return;
        }
      },
      outerSignal,
    );

    throwIfOpenGovAborted(outerSignal, "OpenGov adapter");

    const records = allRecords.slice(0, overallLimit);
    return { records, total: records.length, errors: allErrors };
  }

  async getStatus(): Promise<ProviderStatus> {
    return {
      name: "publicPortalProviders",
      configured: true,
      healthy: true,
    };
  }
}

export const openGovProvider = new OpenGovProvider();

// ─── Single-tenant fetch (used by publicPortalProviders/index.ts per-source) ──
//
// When the publicPortalProviders runner calls SOURCE_ADAPTERS[portalId].fetch(),
// it expects a single-tenant provider. This factory creates one per portal ID.

export function openGovTenantProvider(
  portalId: string,
): DataSourceProvider | undefined {
  const tenant = OPENGOV_TENANT_BY_PORTAL_ID.get(portalId);
  if (!tenant) return undefined;
  return new OpenGovProvider([tenant]);
}
