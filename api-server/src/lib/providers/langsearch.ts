/**
 * Langsearch Provider
 *
 * Role: AI-native search API optimized for LLM workflows. Returns clean,
 * structured results well-suited for procurement opportunity discovery.
 */

import type {
  DataSourceProvider,
  FetchOptions,
  ProviderFetchResult,
  ProviderStatus,
} from "./types";
import { resolveCredential } from "../config/providerConfig";
import { composeAbortSignal } from "./abortSignals";
import {
  providerBudgetAvailable,
  recordProviderFailure,
  recordProviderSuccess,
} from "../providerBudget";
import { getRelevanceProfile } from "../search/relevanceProfile";
import { keywordQueries, profileNaturalQueries, queryRotationCursor, spreadSample } from "../search/profileWebQueries";

const LANGSEARCH_BASE = "https://api.langsearch.com/v1";
const LANGSEARCH_REQUEST_TIMEOUT_MS = 30_000;
const TRANSIENT_COOLDOWN_MS = 15 * 60 * 1_000;
const QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

const KEY_SLOTS = [
  {
    dbKey: "langsearchApiKey",
    envKey: "LANGSEARCH_API_KEY",
    slot: "primary",
  },
  {
    dbKey: "langsearchApiKey2",
    envKey: "LANGSEARCH_API_KEY_2",
    slot: "secondary",
  },
  {
    dbKey: "langsearchApiKey3",
    envKey: "LANGSEARCH_API_KEY_3",
    slot: "tertiary",
  },
  {
    dbKey: "langsearchApiKey4",
    envKey: "LANGSEARCH_API_KEY_4",
    slot: "quaternary",
  },
] as const;

type LangsearchKeySlot = (typeof KEY_SLOTS)[number]["slot"];

type LangsearchWebPage = {
  id?: string;
  name?: string;
  url?: string;
  displayUrl?: string;
  snippet?: string;
  summary?: string;
  datePublished?: string | null;
  dateLastCrawled?: string | null;
};

type LangsearchResponse = {
  code?: number;
  msg?: string | null;
  data?: {
    webPages?: { value?: LangsearchWebPage[] };
  };
  webPages?: { value?: LangsearchWebPage[] };
};

interface ResolvedLangsearchKey {
  value: string;
  slot: LangsearchKeySlot;
}

interface LangsearchRequestResult {
  pages: LangsearchWebPage[];
  errors: string[];
  slot?: LangsearchKeySlot;
}

function slotBudgetName(slot: LangsearchKeySlot): string {
  return `langsearch:${slot}`;
}

export class LangsearchProvider implements DataSourceProvider {
  readonly name = "langsearch" as const;

  private readonly cooldownUntil = new Map<LangsearchKeySlot, number>();

  private async getApiKeys(): Promise<ResolvedLangsearchKey[]> {
    const resolved = await Promise.all(
      KEY_SLOTS.map(async ({ dbKey, envKey, slot }) => ({
        value: await resolveCredential(dbKey, envKey),
        slot,
      })),
    );

    const seen = new Set<string>();
    return resolved.flatMap(({ value, slot }) => {
      const normalized = value?.trim();
      if (!normalized || seen.has(normalized)) return [];
      seen.add(normalized);
      return [{ value: normalized, slot }];
    });
  }

  async isConfigured(): Promise<boolean> {
    return (await this.getApiKeys()).length > 0;
  }

  private cooldownFor(status: number, body: string): number {
    if (status === 401 || status === 403) return QUOTA_COOLDOWN_MS;
    if (/quota|daily|exhaust|limit reached/i.test(body)) {
      return QUOTA_COOLDOWN_MS;
    }
    return TRANSIENT_COOLDOWN_MS;
  }

  private shouldFailOver(status: number): boolean {
    return (
      status === 401 ||
      status === 403 ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      status >= 500
    );
  }

  private async availableKeys(): Promise<ResolvedLangsearchKey[]> {
    const keys = await this.getApiKeys();
    const now = Date.now();
    const rows = await Promise.all(
      keys.map(async (key) => ({
        key,
        durableAvailable: await providerBudgetAvailable(
          slotBudgetName(key.slot),
        ),
      })),
    );
    return rows
      .filter(
        ({ key, durableAvailable }) =>
          durableAvailable && (this.cooldownUntil.get(key.slot) ?? 0) <= now,
      )
      .map(({ key }) => key);
  }

  private async requestWebSearch(
    query: string,
    options: { dateRange?: number; signal?: AbortSignal } = {},
  ): Promise<LangsearchRequestResult> {
    const configuredKeys = await this.getApiKeys();
    if (configuredKeys.length === 0) {
      return { pages: [], errors: ["LangSearch API key not configured"] };
    }

    const candidates = await this.availableKeys();
    if (candidates.length === 0) {
      return {
        pages: [],
        errors: [
          "All configured LangSearch keys are cooling down after quota or upstream failures.",
        ],
      };
    }

    const errors: string[] = [];

    // Keys remain primary -> secondary -> tertiary. Successful keys are reused
    // until quota/upstream failure. Slot-level cooldowns are also persisted in
    // the RFP settings store so redeploys cannot immediately re-burn a known
    // exhausted trial key.
    for (const { value: apiKey, slot } of candidates) {
      const budgetName = slotBudgetName(slot);
      const requestSignal = composeAbortSignal(
        LANGSEARCH_REQUEST_TIMEOUT_MS,
        options.signal,
      );
      try {
        const response = await fetch(`${LANGSEARCH_BASE}/web-search`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            count: 10,
            freshness: this.freshnessForDateRange(options.dateRange),
            summary: true,
          }),
          signal: requestSignal.signal,
        });

        const body = await response.text();
        if (!response.ok) {
          const message = `LangSearch ${slot} key HTTP ${response.status}: ${body.slice(0, 180)}`;
          errors.push(message);
          await recordProviderFailure(budgetName, message);
          if (this.shouldFailOver(response.status)) {
            this.cooldownUntil.set(
              slot,
              Date.now() + this.cooldownFor(response.status, body),
            );
          }
          continue;
        }

        let data: LangsearchResponse;
        try {
          data = JSON.parse(body) as LangsearchResponse;
        } catch {
          const message = `LangSearch ${slot} key returned malformed JSON`;
          errors.push(message);
          await recordProviderFailure(budgetName, message);
          this.cooldownUntil.set(slot, Date.now() + TRANSIENT_COOLDOWN_MS);
          continue;
        }

        if (data.code && data.code !== 200) {
          const apiMessage = data.msg ?? "unknown error";
          const message = `LangSearch ${slot} key API error ${data.code}: ${apiMessage}`;
          errors.push(message);
          await recordProviderFailure(budgetName, message);
          this.cooldownUntil.set(
            slot,
            Date.now() + this.cooldownFor(data.code, apiMessage),
          );
          continue;
        }

        const pages = data.data?.webPages?.value ?? data.webPages?.value ?? [];
        await recordProviderSuccess(budgetName, pages.length);
        if (errors.length > 0) {
          console.warn(
            JSON.stringify({
              event: "langsearch_key_failover",
              successfulSlot: slot,
              failedAttempts: errors.length,
            }),
          );
        }
        return { pages, errors: [], slot };
      } catch (error) {
        const message = `LangSearch ${slot} key request failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        errors.push(message);
        await recordProviderFailure(budgetName, message);
        this.cooldownUntil.set(slot, Date.now() + TRANSIENT_COOLDOWN_MS);
      } finally {
        requestSignal.cleanup();
      }
    }

    return { pages: [], errors };
  }

  async search(
    query: string,
    options: { dateRange?: number; signal?: AbortSignal } = {},
  ): Promise<
    Array<{
      title: string;
      url: string;
      content: string;
      dateRaw?: string;
      keySlot?: LangsearchKeySlot;
    }>
  > {
    const result = await this.requestWebSearch(query, options);
    if (result.pages.length === 0 && result.errors.length > 0) {
      throw new Error(result.errors.join("; "));
    }
    return result.pages.flatMap((page) => {
      const url = page.url ?? page.displayUrl;
      return url
        ? [
            {
              title: page.name ?? url,
              url,
              content: page.summary || page.snippet || "",
              dateRaw: page.datePublished ?? page.dateLastCrawled ?? undefined,
              keySlot: result.slot,
            },
          ]
        : [];
    });
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    const queries = this.buildQueries(options.keywords);
    const records = [];
    const errors: string[] = [];
    const seenUrls = new Set<string>();

    for (const query of queries.slice(0, 4)) {
      const result = await this.requestWebSearch(query, {
        dateRange: options.dateRange,
        signal: options.signal,
      });
      errors.push(...result.errors);

      if (result.pages.length === 0 && result.errors.length === 0) {
        errors.push(`LangSearch returned 0 web results for query: ${query}`);
        continue;
      }

      for (const page of result.pages) {
        const url = page.url ?? page.displayUrl;
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);

        records.push({
          id: `langsearch-${Buffer.from(url).toString("base64").slice(0, 16)}`,
          title: page.name ?? url,
          description: page.summary || page.snippet || "",
          url,
          source: "langsearch" as const,
          providerName: "LangSearch",
          status: "active" as const,
          // Unscored search hit: the canonical review floor, so only the relevance gate can promote it.
          relevanceScore: getRelevanceProfile().thresholds.reviewMin,
          rawData: { query, page, keySlot: result.slot },
        });
      }
    }

    return { records: records as any, total: records.length, errors };
  }

  private freshnessForDateRange(
    dateRange?: number,
  ): "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit" {
    if (!dateRange || dateRange <= 0) return "oneMonth";
    if (dateRange <= 1) return "oneDay";
    if (dateRange <= 7) return "oneWeek";
    if (dateRange <= 30) return "oneMonth";
    if (dateRange <= 365) return "oneYear";
    return "noLimit";
  }

  private buildQueries(keywords?: string): string[] {
    const year = new Date().getFullYear();
    // Query text comes from the profile at call time; fetch() runs the first four, so spread them across bundles.
    return keywords ? keywordQueries(keywords, year) : spreadSample(profileNaturalQueries(year), 4, queryRotationCursor());
  }

  async getStatus(): Promise<ProviderStatus> {
    const configured = await this.isConfigured();
    return { name: this.name, configured, healthy: configured };
  }
}

export const langsearchProvider = new LangsearchProvider();
