/**
 * WebSearch API Provider
 *
 * Role: General web search API for broad procurement opportunity discovery.
 * Covers sources that Serper/Exa may miss.
 *
 * API: https://websearch.io or compatible endpoint
 */

import { profileNaturalQueries, queryRotationCursor, spreadSample } from "../search/profileWebQueries";
import { getRelevanceProfile } from "../search/relevanceProfile";
import type { DataSourceProvider, FetchOptions, ProviderFetchResult, ProviderStatus } from "./types";
import { resolveCredential } from "../config/providerConfig";

const WEBSEARCH_BASE = "https://api.websearch.io/v1";

export class WebsearchProvider implements DataSourceProvider {
  readonly name = "websearch" as const;

  private async getApiKey(): Promise<string | null> {
    return resolveCredential("websearchApiKey", "WEBSEARCH_API_KEY");
  }

  async isConfigured(): Promise<boolean> {
    return !!(await this.getApiKey());
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return { records: [], total: 0, errors: ["WebSearch API key not configured"] };

    const queries = this.buildQueries(options.keywords);
    const records = [];
    const errors: string[] = [];

    for (const query of queries.slice(0, 4)) {
      try {
        const res = await fetch(`${WEBSEARCH_BASE}/search`, {
          method: "GET",
          headers: {
            "X-API-KEY": apiKey,
            "Content-Type": "application/json",
          },
        });

        // Try query param style if header-based doesn't work
        const urlRes = await fetch(
          `${WEBSEARCH_BASE}/search?q=${encodeURIComponent(query)}&limit=10`,
          { headers: { "Authorization": `Bearer ${apiKey}`, "X-API-Key": apiKey } }
        );

        const target = urlRes.ok ? urlRes : res;
        if (!target.ok) {
          errors.push(`WebSearch API error ${target.status} for: ${query}`);
          continue;
        }

        const data = await target.json() as {
          results?: Array<{ title: string; url: string; description?: string; snippet?: string }>;
          organic?: Array<{ title: string; url: string; snippet?: string }>;
        };

        const items = data.results ?? data.organic ?? [];
        for (const item of items) {
          records.push({
            id: `websearch-${Buffer.from(item.url).toString("base64").slice(0, 16)}`,
            title: item.title,
            description: item.snippet ?? (item as any).description ?? "",
            url: item.url,
            source: "websearch" as const,
            providerName: "WebSearch API",
            status: "active" as const,
            relevanceScore: getRelevanceProfile().thresholds.reviewMin,
            rawData: { query, item },
          });
        }
      } catch (err: any) {
        errors.push(err.message ?? String(err));
      }
    }

    return { records: records as any, total: records.length, errors };
  }

  private buildQueries(keywords?: string): string[] {
    const year = new Date().getFullYear();
    return keywords
      ? [`${keywords} RFP bid ${year}`, `${keywords} government contract solicitation ${year}`]
      : spreadSample(profileNaturalQueries(year), 4, queryRotationCursor());
  }

  async getStatus(): Promise<ProviderStatus> {
    const configured = await this.isConfigured();
    return { name: this.name, configured, healthy: configured };
  }
}

export const websearchProvider = new WebsearchProvider();
