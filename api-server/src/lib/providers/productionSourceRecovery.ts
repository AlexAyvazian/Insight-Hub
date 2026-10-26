import type {
  DataSourceProvider,
  FetchOptions,
  NormalizedOpportunity,
  ProviderFetchResult,
  ProviderStatus,
} from "./types";
import { BonfirePortalProvider, type BonfireTenant } from "./bonfirePortal";
import {
  CgiAdvantagePublicProvider,
  type CgiAdvantagePublicTenant,
} from "./cgiAdvantagePublic";
import { bsoPortalProviders } from "./bsoPortal";
import { OfficialPlatformSession } from "./officialPlatformSession";
import { parsePeriscopeCsvExportForm } from "./periscopePublic";
import type { PublicPortalSource } from "./publicPortalProviders/catalog";
import { statewideContentHasExplicitEmptyEvidence } from "./statewideProcurementContentSignals";
import type {
  StatewidePlatformFamily,
  StatewidePortalConfig,
} from "./statewideProcurementConfigs";
import {
  parseStatewideListingContent,
  statewideMatchesOptions,
  statewideToOpportunity,
  type StatewideListingRecord,
} from "./statewideProcurementParser";

interface StaticRecoveryTenant {
  portalId: string;
  buyerName: string;
  state: string;
  platform: string;
  platformFamily: StatewidePlatformFamily;
  sourceBadge: string;
  urls: readonly string[];
  timeoutMs?: number;
}

interface PeriscopeRecoveryTenant {
  portalId: string;
  buyerName: string;
  state: string;
  rootUrl: string;
  sourceBadge: string;
}

function uniqueOrigins(urls: readonly string[]): string[] {
  return Array.from(new Set(urls.map((url) => new URL(url).origin)));
}

function configFor(tenant: StaticRecoveryTenant): StatewidePortalConfig {
  return {
    portalId: tenant.portalId,
    buyerName: tenant.buyerName,
    state: tenant.state,
    platform: tenant.platform,
    platformFamily: tenant.platformFamily,
    listingUrl: tenant.urls[0]!,
    alternateListingUrls: tenant.urls.slice(1),
    origin: new URL(tenant.urls[0]!).origin,
    allowedOrigins: uniqueOrigins(tenant.urls.slice(1)),
    sourceBadge: tenant.sourceBadge,
    maxPages: tenant.urls.length,
    maxRetries: 0,
    requestTimeoutMs: tenant.timeoutMs ?? 12_000,
  };
}

function sourceFor(
  tenant: StaticRecoveryTenant,
  options: { enabled?: boolean; notes?: string } = {},
): PublicPortalSource {
  return {
    id: tenant.portalId,
    agencyName: tenant.buyerName,
    agencyType: "state",
    state: tenant.state,
    sourceUrl: tenant.urls[0]!,
    searchUrl: tenant.urls[0]!,
    domain: new URL(tenant.urls[0]!).hostname,
    portalPlatform: tenant.platform,
    sourceLevel: "state",
    level: "state",
    accessMode: "public_html",
    scraperType: "existing_parser",
    enabled: options.enabled ?? true,
    verificationStatus: options.enabled === false ? "needs_review" : "verified",
    notes:
      options.notes
      ?? `Bounded official listing-only recovery route for ${tenant.sourceBadge}; no detail-page fan-out.`,
  };
}

function normalizeRows(
  rows: Iterable<StatewideListingRecord>,
  config: StatewidePortalConfig,
  options: FetchOptions,
  seen: Set<string>,
): NormalizedOpportunity[] {
  const records: NormalizedOpportunity[] = [];
  for (const row of rows) {
    const key = row.nativeId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const record = statewideToOpportunity(config, row);
    if (record && statewideMatchesOptions(record, options)) records.push(record);
  }
  return records;
}

export class StaticOfficialRecoveryProvider implements DataSourceProvider {
  readonly name = "publicPortalProviders" as const;
  private lastAttempt?: Date;
  private lastSuccess?: Date;
  private lastError?: string;
  private recordCount = 0;

  constructor(readonly tenant: StaticRecoveryTenant) {}

  async isConfigured(): Promise<boolean> {
    return this.tenant.urls.length > 0;
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    this.lastAttempt = new Date();
    const config = configFor(this.tenant);
    const session = new OfficialPlatformSession(
      uniqueOrigins(this.tenant.urls),
      `${this.tenant.portalId} production recovery`,
    );
    const requestedLimit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const target = Math.min(200, offset + requestedLimit);
    const records: NormalizedOpportunity[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    let explicitEmpty = false;
    let successfulFetches = 0;

    for (const [index, url] of this.tenant.urls.entries()) {
      if (records.length >= target) break;
      try {
        const response = await session.requestText(url, {
          timeoutMs: this.tenant.timeoutMs ?? 12_000,
          maxRetries: 0,
          signal: options.signal,
          redirectLimit: 5,
        });
        successfulFetches += 1;
        explicitEmpty ||= statewideContentHasExplicitEmptyEvidence(response.body);
        const rows = parseStatewideListingContent(
          response.body,
          config,
          response.url,
          index + 1,
        );
        records.push(...normalizeRows(rows, config, options, seen));
      } catch (error) {
        errors.push(
          `${this.tenant.portalId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const selected = records.slice(offset, offset + requestedLimit);
    this.recordCount = selected.length;
    if (selected.length || (successfulFetches > 0 && explicitEmpty)) {
      this.lastSuccess = new Date();
      this.lastError = undefined;
      return {
        records: selected,
        total: selected.length,
        errors: selected.length ? errors : [],
      };
    }

    const reason =
      errors.join("; ")
      || `${this.tenant.portalId}: official recovery pages returned no parseable active opportunity rows`;
    this.lastError = reason;
    return { records: [], total: 0, errors: [reason] };
  }

  async getStatus(): Promise<ProviderStatus> {
    return {
      name: this.name,
      configured: await this.isConfigured(),
      healthy: !this.lastError,
      errorMessage: this.lastError,
      lastAttempt: this.lastAttempt,
      lastSuccess: this.lastSuccess,
      recordCount: this.recordCount,
    };
  }
}

class ManualAccessProvider implements DataSourceProvider {
  readonly name = "publicPortalProviders" as const;

  constructor(readonly reason: string) {}

  async isConfigured(): Promise<boolean> {
    return true;
  }

  async fetch(): Promise<ProviderFetchResult> {
    return { records: [], total: 0, errors: [] };
  }

  async getStatus(): Promise<ProviderStatus> {
    return {
      name: this.name,
      configured: true,
      healthy: true,
      errorMessage: this.reason,
      recordCount: 0,
    };
  }
}

class FirstUsableProvider implements DataSourceProvider {
  readonly name = "publicPortalProviders" as const;
  private lastAttempt?: Date;
  private lastSuccess?: Date;
  private lastError?: string;
  private recordCount = 0;

  constructor(readonly providers: readonly DataSourceProvider[]) {}

  async isConfigured(): Promise<boolean> {
    const configured = await Promise.all(
      this.providers.map((provider) => provider.isConfigured().catch(() => false)),
    );
    return configured.some(Boolean);
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    this.lastAttempt = new Date();
    const errors: string[] = [];
    for (const provider of this.providers) {
      const result = await provider.fetch(options);
      if (result.records.length || result.errors.length === 0) {
        this.recordCount = result.records.length;
        this.lastSuccess = new Date();
        this.lastError = undefined;
        return { ...result, errors: [...errors, ...result.errors] };
      }
      errors.push(...result.errors);
    }
    this.recordCount = 0;
    this.lastError = errors.join("; ") || "All official recovery routes failed";
    return { records: [], total: 0, errors: [this.lastError] };
  }

  async getStatus(): Promise<ProviderStatus> {
    return {
      name: this.name,
      configured: await this.isConfigured(),
      healthy: !this.lastError,
      errorMessage: this.lastError,
      lastAttempt: this.lastAttempt,
      lastSuccess: this.lastSuccess,
      recordCount: this.recordCount,
    };
  }
}

class PeriscopeListingOnlyProvider implements DataSourceProvider {
  readonly name = "publicPortalProviders" as const;
  private lastAttempt?: Date;
  private lastSuccess?: Date;
  private lastError?: string;
  private recordCount = 0;

  constructor(readonly tenant: PeriscopeRecoveryTenant) {}

  async isConfigured(): Promise<boolean> {
    return /^https:\/\//.test(this.tenant.rootUrl);
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    this.lastAttempt = new Date();
    const listingUrl = new URL(
      "view/search/external/advancedSearchBid.xhtml?openBids=true",
      this.tenant.rootUrl,
    ).toString();
    const config: StatewidePortalConfig = {
      portalId: this.tenant.portalId,
      buyerName: this.tenant.buyerName,
      state: this.tenant.state,
      platform: "Periscope S2G / BSO",
      platformFamily: "periscope_bso",
      listingUrl,
      origin: new URL(listingUrl).origin,
      sourceBadge: this.tenant.sourceBadge,
      maxPages: 1,
      maxRetries: 0,
      requestTimeoutMs: 12_000,
    };
    const session = new OfficialPlatformSession(
      [config.origin],
      `${this.tenant.portalId} Periscope listing-only recovery`,
    );
    const requestedLimit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = new Map<string, StatewideListingRecord>();
    const errors: string[] = [];
    let explicitEmpty = false;

    try {
      const listing = await session.requestText(listingUrl, {
        timeoutMs: 12_000,
        maxRetries: 0,
        signal: options.signal,
        redirectLimit: 5,
      });
      explicitEmpty = statewideContentHasExplicitEmptyEvidence(listing.body);
      for (const row of parseStatewideListingContent(
        listing.body,
        config,
        listing.url,
        1,
      )) {
        rows.set(row.nativeId.toLowerCase(), row);
      }

      const exportForm = parsePeriscopeCsvExportForm(listing.body, listing.url);
      if (exportForm) {
        const body = new URLSearchParams();
        for (const [name, value] of exportForm.fields) body.set(name, value);
        body.set(exportForm.exportName, exportForm.exportValue);
        try {
          const exported = await session.requestText(exportForm.actionUrl, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              origin: config.origin,
              referer: listing.url,
            },
            body: body.toString(),
            timeoutMs: 12_000,
            maxRetries: 0,
            signal: options.signal,
            redirectLimit: 3,
          });
          for (const row of parseStatewideListingContent(
            exported.body,
            config,
            listing.url,
            1,
          )) {
            rows.set(row.nativeId.toLowerCase(), row);
          }
        } catch (error) {
          errors.push(
            `${this.tenant.portalId}: public CSV export failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      const reason = `${this.tenant.portalId}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.lastError = reason;
      this.recordCount = 0;
      return { records: [], total: 0, errors: [reason] };
    }

    const seen = new Set<string>();
    const records = normalizeRows(rows.values(), config, options, seen).slice(
      offset,
      offset + requestedLimit,
    );
    this.recordCount = records.length;
    if (records.length || explicitEmpty) {
      this.lastSuccess = new Date();
      this.lastError = undefined;
      return { records, total: records.length, errors };
    }

    const reason =
      errors.join("; ")
      || `${this.tenant.portalId}: public listing returned no parseable active bid rows`;
    this.lastError = reason;
    return { records: [], total: 0, errors: [reason] };
  }

  async getStatus(): Promise<ProviderStatus> {
    return {
      name: this.name,
      configured: await this.isConfigured(),
      healthy: !this.lastError,
      errorMessage: this.lastError,
      lastAttempt: this.lastAttempt,
      lastSuccess: this.lastSuccess,
      recordCount: this.recordCount,
    };
  }
}

const FLORIDA: StaticRecoveryTenant = {
  portalId: "fl-vbs",
  buyerName: "State of Florida",
  state: "FL",
  platform: "Florida DMS Current Bid Opportunities",
  platformFamily: "state_html",
  sourceBadge: "Florida Current Bid Opportunities",
  urls: [
    "https://www.dms.myflorida.com/business_operations/state_purchasing/office_of_supplier_development_osd/vendor_resources2/current_bid_opportunities",
  ],
};

const LOUISIANA: StaticRecoveryTenant = {
  portalId: "la-lapac",
  buyerName: "State of Louisiana",
  state: "LA",
  platform: "Louisiana LaPAC Open Bids",
  platformFamily: "state_html",
  sourceBadge: "Louisiana LaPAC Open Bids",
  urls: [
    "https://wwwcfprd.doa.louisiana.gov/osp/lapac/srchopen.cfm",
    "https://wwwcfprd.doa.louisiana.gov/osp/lapac/deptbids.cfm",
  ],
};

const INDIANA: StaticRecoveryTenant = {
  portalId: "in-idoa",
  buyerName: "State of Indiana",
  state: "IN",
  platform: "Indiana IDOA Current Business Opportunities",
  platformFamily: "state_html",
  sourceBadge: "Indiana Current Business Opportunities",
  urls: [
    "https://www.in.gov/idoa/procurement/current-business-opportunities/",
  ],
};

const VERMONT: StaticRecoveryTenant = {
  portalId: "vt-bids",
  buyerName: "State of Vermont",
  state: "VT",
  platform: "Vermont Business Registry Open State Bids",
  platformFamily: "state_html",
  sourceBadge: "Vermont Open State Bids",
  urls: [
    "https://www.vermontbusinessregistry.com/BidSearch.aspx?type=5",
    "https://www.vermontbusinessregistry.com/BidSearch.aspx?type=1",
  ],
};

const RHODE_ISLAND: StaticRecoveryTenant = {
  portalId: "ri-bids",
  buyerName: "State of Rhode Island",
  state: "RI",
  platform: "Rhode Island VSS / RIVIP Public Bid Search",
  platformFamily: "state_html",
  sourceBadge: "Rhode Island Public Bid Search",
  urls: [
    "https://www.purchasing.ri.gov/bidding/ExternalBidSearch.aspx",
    "https://ridop.ri.gov/vendor-resources/all-solicitations",
  ],
};

const PENNSYLVANIA: StaticRecoveryTenant = {
  portalId: "pa-emarketplace",
  buyerName: "Commonwealth of Pennsylvania",
  state: "PA",
  platform: "Pennsylvania eMarketplace",
  platformFamily: "state_html",
  sourceBadge: "Pennsylvania eMarketplace",
  urls: [
    "https://www.emarketplace.state.pa.us/Solicitations.aspx",
    "https://www.emarketplace.state.pa.us/Search.aspx",
  ],
};

const ALASKA_NOTICES: StaticRecoveryTenant = {
  portalId: "ak-iris-vss",
  buyerName: "State of Alaska",
  state: "AK",
  platform: "Alaska IRIS VSS / Online Public Notices",
  platformFamily: "cgi_advantage",
  sourceBadge: "Alaska Public Solicitations",
  urls: ["https://aws.state.ak.us/OnlinePublicNotices/default.aspx"],
};

const NORTH_DAKOTA: StaticRecoveryTenant = {
  portalId: "nd-spo",
  buyerName: "State of North Dakota",
  state: "ND",
  platform: "North Dakota NDBuys",
  platformFamily: "webprocure_ivalua",
  sourceBadge: "North Dakota NDBuys",
  urls: ["https://www.omb.nd.gov/doing-business-state/procurement/ndbuys"],
};

const UTAH_BONFIRE: BonfireTenant = {
  portalId: "ut-purchasing",
  tenantSlug: "utah",
  buyerName: "State of Utah",
  state: "UT",
  listingUrl: "https://utah.bonfirehub.com/opportunities",
  origin: "https://utah.bonfirehub.com",
};

const ALASKA_CGI: CgiAdvantagePublicTenant = {
  portalId: "ak-iris-vss",
  buyerName: "State of Alaska",
  state: "AK",
  listingUrl: "https://iris-vss.alaska.gov/",
  sourceBadge: "Alaska IRIS VSS Published Solicitations",
};

const NORTH_DAKOTA_MANUAL_REASON =
  "NDBuys redirects to an interactive public search that may require CAPTCHA. The official link is retained for manual browser access; no CAPTCHA bypass is attempted.";

export const PRODUCTION_RECOVERY_SOURCES: PublicPortalSource[] = [
  sourceFor(FLORIDA),
  sourceFor(LOUISIANA),
  sourceFor(INDIANA),
  sourceFor(VERMONT),
  sourceFor(RHODE_ISLAND),
  sourceFor(PENNSYLVANIA),
  sourceFor(ALASKA_NOTICES),
  sourceFor(NORTH_DAKOTA, {
    enabled: false,
    notes: NORTH_DAKOTA_MANUAL_REASON,
  }),
  {
    id: UTAH_BONFIRE.portalId,
    agencyName: UTAH_BONFIRE.buyerName,
    agencyType: "state",
    state: UTAH_BONFIRE.state,
    sourceUrl: UTAH_BONFIRE.listingUrl,
    searchUrl: UTAH_BONFIRE.listingUrl,
    domain: new URL(UTAH_BONFIRE.listingUrl).hostname,
    portalPlatform: "Bonfire / Euna",
    sourceLevel: "state",
    level: "state",
    accessMode: "api",
    scraperType: "existing_parser",
    enabled: true,
    verificationStatus: "verified",
    notes: "Dedicated Bonfire public open-opportunities API adapter for Utah.",
  },
];

export const productionRecoveryProviders: Record<string, DataSourceProvider> = {
  [FLORIDA.portalId]: new StaticOfficialRecoveryProvider(FLORIDA),
  [LOUISIANA.portalId]: new StaticOfficialRecoveryProvider(LOUISIANA),
  [INDIANA.portalId]: new StaticOfficialRecoveryProvider(INDIANA),
  [VERMONT.portalId]: new StaticOfficialRecoveryProvider(VERMONT),
  [RHODE_ISLAND.portalId]: new StaticOfficialRecoveryProvider(RHODE_ISLAND),
  [PENNSYLVANIA.portalId]: new StaticOfficialRecoveryProvider(PENNSYLVANIA),
  [ALASKA_NOTICES.portalId]: new FirstUsableProvider([
    new CgiAdvantagePublicProvider(ALASKA_CGI),
    new StaticOfficialRecoveryProvider(ALASKA_NOTICES),
  ]),
  [NORTH_DAKOTA.portalId]: new ManualAccessProvider(
    NORTH_DAKOTA_MANUAL_REASON,
  ),
  [UTAH_BONFIRE.portalId]: new BonfirePortalProvider([UTAH_BONFIRE]),
};

export function applyProductionSourceProviderOverrides(): void {
  const tenants: readonly PeriscopeRecoveryTenant[] = [
    {
      portalId: "ma-commbuys",
      buyerName: "Massachusetts COMMBUYS",
      state: "MA",
      rootUrl: "https://www.commbuys.com/bso/",
      sourceBadge: "Massachusetts COMMBUYS Open Bids",
    },
    {
      portalId: "nv-epro",
      buyerName: "NEVADAePro",
      state: "NV",
      rootUrl: "https://nevadaepro.com/bso/",
      sourceBadge: "NEVADAePro Open Bids",
    },
    {
      portalId: "nj-start",
      buyerName: "New Jersey START",
      state: "NJ",
      rootUrl: "https://www.njstart.gov/bso/",
      sourceBadge: "New Jersey START Open Bids",
    },
  ];
  for (const tenant of tenants) {
    bsoPortalProviders[tenant.portalId] = new PeriscopeListingOnlyProvider(tenant);
  }
}

applyProductionSourceProviderOverrides();
