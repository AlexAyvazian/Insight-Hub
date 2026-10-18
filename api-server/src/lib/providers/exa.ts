/**
 * Exa Provider
 *
 * Role: Neural search engine optimized for AI use cases. Finds semantically
 * relevant results across the web — better at understanding intent than keyword
 * search. Supports "deep" multi-query search with structured output extraction
 * and full-page content retrieval.
 *
 * API docs: https://docs.exa.ai
 */

import type {
  DataSourceProvider,
  FetchOptions,
  ProviderFetchResult,
  ProviderStatus,
} from "./types";
import { composeAbortSignal } from "./abortSignals";
import { FreeTierCredentialPool } from "./freeTierCredentialPool";
import { keywordQueries, profileNaturalQueries, queryRotationCursor, spreadSample } from "../search/profileWebQueries";

const EXA_BASE = "https://api.exa.ai";
const EXA_REQUEST_TIMEOUT_MS = 30_000;

// These keys belong to separate Exa accounts/Teams, so each slot is an
// independent renewable quota pool. Stay on one account until it hits quota,
// rate, auth, or transient pressure; then cool it down and fail over.
const credentials = new FreeTierCredentialPool(
  "exa-multi-account",
  [
    { dbKey: "exaApiKey", envKey: "EXA_API_KEY" },
    { envKey: "EXA_API_KEY_2" },
    { envKey: "EXA_API_KEY_3" },
  ],
  { rotateOnSuccess: false },
);

export interface ExaResult {
  id: string;
  url: string;
  title: string;
  score?: number;
  publishedDate?: string;
  author?: string;
  highlights?: string[];
  text?: string;
}

export interface ExaSearchResponse {
  results: ExaResult[];
  resolvedSearchType?: string;
}

export class ExaProvider implements DataSourceProvider {
  readonly name = "exa" as const;

  async isConfigured(): Promise<boolean> {
    return credentials.isConfigured();
  }

  async fetch(_options: FetchOptions): Promise<ProviderFetchResult> {
    return { records: [], total: 0, errors: [] };
  }

  async getStatus(): Promise<ProviderStatus> {
    const configured = await this.isConfigured();
    return { name: this.name, configured, healthy: configured };
  }

  private async request<T>(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    return credentials.run(async (apiKey, slot) => {
      const requestSignal = composeAbortSignal(EXA_REQUEST_TIMEOUT_MS, signal);
      let response: Response;
      try {
        response = await fetch(`${EXA_BASE}${path}`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: requestSignal.signal,
        });
        credentials.recordRateLimitHeaders(slot, response.headers);
      } finally {
        requestSignal.cleanup();
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Exa error ${response.status}: ${text.slice(0, 200)}`);
      }

      return response.json() as Promise<T>;
    });
  }

  /**
   * Search the web using Exa's neural search. Returns results with highlights.
   * type: "auto" for most queries, "deep" for thorough research (4-12s).
   */
  async search(
    query: string,
    options: {
      numResults?: number;
      type?: "auto" | "fast" | "deep" | "deep-reasoning";
      maxHighlightChars?: number;
      startPublishedDate?: string;
      includeDomains?: string[];
      excludeDomains?: string[];
      category?: "news" | "research paper" | "company" | "people";
      signal?: AbortSignal;
    } = {},
  ): Promise<ExaResult[]> {
    const {
      numResults = 10,
      type = "auto",
      maxHighlightChars = 4000,
      startPublishedDate,
      includeDomains,
      excludeDomains,
      category,
      signal,
    } = options;

    const body: Record<string, unknown> = {
      query,
      num_results: numResults,
      type,
      contents: { highlights: { max_characters: maxHighlightChars } },
    };

    if (startPublishedDate) body["startPublishedDate"] = startPublishedDate;
    if (includeDomains?.length) body["includeDomains"] = includeDomains;
    if (excludeDomains?.length) body["excludeDomains"] = excludeDomains;
    if (category) body["category"] = category;

    const data = await this.request<ExaSearchResponse>("/search", body, signal);
    return data.results ?? [];
  }

  /** Search with full text content for RAG / deeper analysis. */
  async searchWithContent(
    query: string,
    numResults = 5,
    maxChars = 10000,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExaResult[]> {
    const body: Record<string, unknown> = {
      query,
      num_results: numResults,
      type: "deep",
      contents: { text: { max_characters: maxChars } },
    };

    const data = await this.request<ExaSearchResponse>(
      "/search",
      body,
      options.signal,
    );
    return data.results ?? [];
  }

  /** Get full content for known URLs through the same account failover pool. */
  async getContents(
    urls: string[],
    maxChars = 10000,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExaResult[]> {
    if (urls.length === 0 || !(await credentials.isConfigured())) return [];

    try {
      const data = await this.request<{ results?: ExaResult[] }>(
        "/contents",
        {
          urls,
          text: { max_characters: maxChars },
        },
        options.signal,
      );
      return data.results ?? [];
    } catch {
      return [];
    }
  }

  /** Run multiple search queries in parallel and deduplicate by URL. */
  async searchMultiple(
    queries: string[],
    numPerQuery = 8,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExaResult[]> {
    const batches = await Promise.allSettled(
      queries.map((query) =>
        this.search(query, {
          numResults: numPerQuery,
          signal: options.signal,
        }),
      ),
    );

    const seen = new Set<string>();
    const results: ExaResult[] = [];

    for (const batch of batches) {
      if (batch.status === "fulfilled") {
        for (const result of batch.value) {
          if (result.url && !seen.has(result.url)) {
            seen.add(result.url);
            results.push(result);
          }
        }
      }
    }

    return results;
  }

  /** Find active RFPs and procurement opportunities via neural search. */
  async findOpportunities(keywords?: string): Promise<ExaResult[]> {
    const year = new Date().getFullYear();
    // Query text comes from the profile at call time (search bundles), spread across bundles.
    const queries = keywords
      ? keywordQueries(keywords, year).slice(0, 2)
      : spreadSample(profileNaturalQueries(year), 3, queryRotationCursor());

    return this.searchMultiple(queries, 10);
  }
}

export const exaProvider = new ExaProvider();