/**
 * You.com Provider
 *
 * Role: AI-powered web search with structured results. You.com's Search API
 * returns high-quality, relevant web results with snippets, ideal for finding
 * active procurement opportunities across the open web.
 *
 * API docs: https://documentation.you.com/api-reference
 */

import type {
  DataSourceProvider,
  FetchOptions,
  ProviderFetchResult,
  ProviderStatus,
} from "./types";
import { FreeTierCredentialPool } from "./freeTierCredentialPool";
import { getRelevanceProfile } from "../search/relevanceProfile";
import { keywordQueries, profileNaturalQueries, queryRotationCursor, spreadSample } from "../search/profileWebQueries";

const YOU_BASE = "https://api.ydc-index.io";

// These keys belong to separate You.com accounts. Keep the current account
// active until its daily/rate/auth capacity is unavailable, then cool it down
// and fail over to the second renewable account.
const credentials = new FreeTierCredentialPool(
  "you-multi-account",
  [
    { dbKey: "youApiKey", envKey: "YOU_API_KEY" },
    { envKey: "YOU_API_KEY_2" },
  ],
  { rotateOnSuccess: false },
);

type YouHit = {
  title?: string;
  url?: string;
  description?: string;
  snippets?: string[];
};

export class YouProvider implements DataSourceProvider {
  readonly name = "you" as const;

  async isConfigured(): Promise<boolean> {
    return credentials.isConfigured();
  }

  private async searchRequest(
    query: string,
    numResults: number,
    signal?: AbortSignal,
  ): Promise<YouHit[]> {
    return credentials.run(async (apiKey, slot) => {
      const url = new URL(`${YOU_BASE}/search`);
      url.searchParams.set("query", query);
      url.searchParams.set("num_web_results", String(numResults));

      const response = await fetch(url.toString(), {
        headers: { "X-API-Key": apiKey },
        signal,
      });
      credentials.recordRateLimitHeaders(slot, response.headers);
      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `You.com API error ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const data = JSON.parse(body) as { hits?: YouHit[] };
      return data.hits ?? [];
    });
  }

  async fetch(options: FetchOptions): Promise<ProviderFetchResult> {
    if (!(await credentials.isConfigured())) {
      return {
        records: [],
        total: 0,
        errors: ["You.com API keys not configured"],
      };
    }

    const queries = this.buildQueries(options.keywords);
    const records = [];
    const errors: string[] = [];

    for (const query of queries.slice(0, 4)) {
      try {
        const hits = await this.searchRequest(query, 10, options.signal);
        for (const hit of hits) {
          if (!hit.url) continue;
          records.push({
            id: `you-${Buffer.from(hit.url).toString("base64").slice(0, 16)}`,
            title: hit.title ?? hit.url,
            description:
              (hit.snippets ?? []).join(" ") || hit.description || "",
            url: hit.url,
            source: "you" as const,
            providerName: "You.com",
            status: "active" as const,
            // Unscored search hit: the canonical review floor, so only the relevance gate can promote it.
            relevanceScore: getRelevanceProfile().thresholds.reviewMin,
            rawData: { query, hit },
          });
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return { records: records as any, total: records.length, errors };
  }

  private buildQueries(keywords?: string): string[] {
    const year = new Date().getFullYear();
    // Query text comes from the profile at call time; fetch() runs the first few, so spread them across bundles.
    return keywords
      ? keywordQueries(keywords, year).slice(0, 2)
      : spreadSample(profileNaturalQueries(year), 4, queryRotationCursor());
  }

  async getStatus(): Promise<ProviderStatus> {
    const configured = await this.isConfigured();
    return { name: this.name, configured, healthy: configured };
  }

  async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<Array<{ title: string; url: string; content: string }>> {
    const hits = await this.searchRequest(query, 15, signal);
    return hits.flatMap((hit) =>
      hit.url
        ? [
            {
              title: hit.title ?? hit.url,
              url: hit.url,
              content:
                (hit.snippets ?? []).join(" ") || hit.description || "",
            },
          ]
        : [],
    );
  }
}

export const youProvider = new YouProvider();