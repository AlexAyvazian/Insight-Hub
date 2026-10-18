import { getRelevanceProfile } from "../search/relevanceProfile";
import type {
  DataSourceProvider,
  FetchOptions,
  ProviderFetchResult,
  ProviderStatus,
} from "./types";
import { composeAbortSignal } from "./abortSignals";
import { FreeTierCredentialPool } from "./freeTierCredentialPool";
import { ProviderQuotaError, type AccountPolicy, type QuotaSnapshot } from "./accountLedger";

const LINKUP_SEARCH_URL = "https://api.linkup.so/v1/search";
const LINKUP_BALANCE_URL = "https://api.linkup.so/v1/credits/balance";
const REQUEST_TIMEOUT_MS = 25_000;
/** Documented price of a fast/standard searchResults call (USD), https://docs.linkup.so pricing page. */
export const LINKUP_FAST_SEARCH_COST_USD = 0.005;

/**
 * Linkup accounts are metered in USD credit. Eligible accounts are topped back up to the free allowance each
 * month; an empty account answers 429 (the same status as its 10 qps rate limit), so a 429 is disambiguated with
 * the free /credits/balance endpoint before an account is treated as exhausted.
 */
export function linkupAccountPolicy(slot: string): AccountPolicy {
  return {
    pool: "linkup",
    slot,
    provider: "linkup",
    allowanceKind: "recurring_monthly",
    unit: "credits",
    periodLimit: null,
    safetyFraction: 1,
    overageBillable: false,
  };
}

export async function linkupBalance(apiKey: string, signal?: AbortSignal): Promise<QuotaSnapshot> {
  const response = await fetch(LINKUP_BALANCE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new ProviderQuotaError(`Linkup balance ${response.status}: invalid key`, "auth");
  }
  if (!response.ok) throw new Error(`Linkup balance error ${response.status}`);
  const json = (await response.json()) as { balance?: number };
  const balance = typeof json.balance === "number" ? json.balance : Number.NaN;
  // A response without a usable balance is a failed probe, never an account with unknown (unbounded) capacity.
  if (!Number.isFinite(balance)) throw new Error("Linkup balance response had no numeric balance");
  return {
    // Keep a one-call reserve so a nearly empty account is not driven into a 429.
    remaining: Math.max(0, balance - LINKUP_FAST_SEARCH_COST_USD),
    source: "linkup:/v1/credits/balance",
  };
}

// The primary key stays primary (rotateOnSuccess: false); LINKUP_API_KEY_2 is used only when it is unavailable.
const credentials = new FreeTierCredentialPool(
  "linkup-multi-account",
  [
    { dbKey: "linkupApiKey", envKey: "LINKUP_API_KEY" },
    { dbKey: "linkupApiKey2", envKey: "LINKUP_API_KEY_2" },
  ],
  {
    rotateOnSuccess: false,
    accounts: {
      policyFor: linkupAccountPolicy,
      probe: (apiKey) => linkupBalance(apiKey),
      unitsPerCall: LINKUP_FAST_SEARCH_COST_USD,
    },
  },
);

export function linkupCredentialPool(): FreeTierCredentialPool {
  return credentials;
}

export interface LinkupSearchResult {
  name: string;
  url: string;
  content: string;
}

export class LinkupProvider implements DataSourceProvider {
  readonly name = "linkup" as const;

  async isConfigured(): Promise<boolean> {
    return credentials.isConfigured();
  }

  async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<LinkupSearchResult[]> {
    if (!(await credentials.isConfigured())) throw new Error("Linkup API key not configured.");
    return credentials.run((apiKey) => this.searchWithKey(apiKey, query, signal));
  }

  private async searchWithKey(
    apiKey: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<LinkupSearchResult[]> {
    const requestSignal = composeAbortSignal(REQUEST_TIMEOUT_MS, signal);
    try {
      const fromDate = new Date();
      fromDate.setMonth(fromDate.getMonth() - 9);
      const response = await fetch(LINKUP_SEARCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: query,
          depth: "fast",
          outputType: "searchResults",
          maxResults: 15,
          fromDate: fromDate.toISOString().slice(0, 10),
          excludeDomains: [
            "linkedin.com",
            "facebook.com",
            "instagram.com",
            "x.com",
          ],
        }),
        signal: requestSignal.signal,
      });
      const body = await response.text();
      if (response.status === 429) {
        // 429 means either the 10 qps rate limit or an empty account. The free balance endpoint tells them apart.
        const balance = await linkupBalance(apiKey).catch(() => null);
        if (balance && balance.remaining != null && balance.remaining <= 0) {
          throw new ProviderQuotaError(`Linkup API error 429: credit balance exhausted`, "quota_exhausted");
        }
        throw new ProviderQuotaError(
          `Linkup API error 429: rate limited`,
          "rate_limited",
          new Date(Date.now() + 5_000),
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderQuotaError(`Linkup API error ${response.status}: invalid key`, "auth");
      }
      if (!response.ok) {
        throw new Error(
          `Linkup API error ${response.status}: ${body.slice(0, 200)}`,
        );
      }
      const json = JSON.parse(body) as {
        results?: Array<{ name?: string; url?: string; content?: string }>;
      };
      return (json.results ?? []).flatMap((result) =>
        result.url
          ? [
              {
                name: result.name ?? result.url,
                url: result.url,
                content: result.content ?? "",
              },
            ]
          : [],
      );
    } finally {
      requestSignal.cleanup();
    }
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    const query =
      options.keywords?.trim() ||
      `active occupational health RFP solicitation ${new Date().getFullYear()}`;
    const results = await this.search(query, options.signal);
    const records = results.map((result) => ({
      id: `linkup-${Buffer.from(result.url).toString("base64").slice(0, 16)}`,
      title: result.name,
      description: result.content,
      url: result.url,
      source: this.name,
      providerName: "Linkup",
      status: "active" as const,
      relevanceScore: getRelevanceProfile().thresholds.reviewMin,
      rawData: { query, result },
    }));
    return { records: records as any, total: records.length, errors: [] };
  }

  async getStatus(): Promise<ProviderStatus> {
    const configured = await this.isConfigured();
    return { name: this.name, configured, healthy: configured };
  }
}

export const linkupProvider = new LinkupProvider();
