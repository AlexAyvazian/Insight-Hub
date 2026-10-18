/**
 * Self-Hosted Web Crawler Provider
 *
 * Role: Replace external scraping APIs (Firecrawl, Olostep, Jina) with a self-hosted
 * crawler using Playwright. This eliminates API key dependencies and rate limits.
 *
 * Benefits:
 * - No API keys required
 * - No rate limits
 * - Full control over crawling behavior
 * - Can be scaled horizontally
 * - Works offline
 */

import type { DataSourceProvider, FetchOptions, ProviderFetchResult, ProviderStatus } from "./types";
import { resolveCredential } from "../config/providerConfig";
import { isObviouslyUnsafeUrl } from "../security/safeUrl";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAGES = 10;

export interface CrawlResult {
  url: string;
  title: string;
  content: string;
  markdown?: string;
  statusCode?: number;
  error?: string;
}

export interface CrawlOptions {
  timeout?: number;
  waitFor?: number;
  screenshot?: boolean;
  pdf?: boolean;
  onlyMainContent?: boolean;
  followRedirects?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class SelfHostedCrawlerProvider implements DataSourceProvider {
  readonly name = "selfHostedCrawler" as const;

  private async getCrawlerUrl(): Promise<string | null> {
    return resolveCredential("selfHostedCrawlerUrl", "SELF_HOSTED_CRAWLER_URL");
  }

  async isConfigured(): Promise<boolean> {
    const crawlerUrl = await this.getCrawlerUrl();
    return !!crawlerUrl;
  }

  async fetch(_options: FetchOptions): Promise<ProviderFetchResult> {
    return { records: [], total: 0, errors: [] };
  }

  async getStatus(): Promise<ProviderStatus> {
    const configured = await this.isConfigured();
    return { name: this.name, configured, healthy: configured };
  }

  /**
   * Crawl a single URL and return the content.
   * Uses the self-hosted crawler service via HTTP API.
   */
  async crawl(url: string, options: CrawlOptions = {}): Promise<CrawlResult | null> {
    const crawlerUrl = await this.getCrawlerUrl();
    if (!crawlerUrl) return null;
    // Record URLs are third-party data: never ask the crawler to visit an internal or non-http(s) address.
    if (isObviouslyUnsafeUrl(url)) return null;

    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

    try {
      const response = await fetch(`${crawlerUrl}/crawl`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.CRAWLER_SERVICE_TOKEN ? { Authorization: `Bearer ${process.env.CRAWLER_SERVICE_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          url,
          timeout,
          waitFor: options.waitFor,
          screenshot: options.screenshot ?? false,
          pdf: options.pdf ?? false,
          onlyMainContent: options.onlyMainContent ?? true,
          followRedirects: options.followRedirects ?? true,
          headers: options.headers,
        }),
        signal: options.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Crawler error ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const result = await response.json() as {
        success: boolean;
        data?: CrawlResult;
        error?: string;
      };

      if (!result.success || !result.data) {
        return null;
      }

      return result.data;
    } catch (error) {
      console.error(`Self-hosted crawler error for ${url}:`, error);
      return null;
    }
  }

  /**
   * Crawl multiple URLs in parallel.
   */
  async crawlMany(urls: string[], options: CrawlOptions = {}): Promise<CrawlResult[]> {
    const crawlerUrl = await this.getCrawlerUrl();
    if (!crawlerUrl) return [];

    const CONCURRENCY = 5;
    const results: CrawlResult[] = [];

    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(url => this.crawl(url, options))
      );
      
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value) {
          results.push(result.value);
        }
      }
    }

    return results;
  }

  /**
   * Extract text content from a URL (simplified version for compatibility).
   */
  async getText(url: string, options: CrawlOptions = {}): Promise<string | null> {
    const result = await this.crawl(url, options);
    return result?.content ?? result?.markdown ?? null;
  }

  /**
   * Extract markdown from a URL.
   */
  async extractMarkdown(url: string, options: CrawlOptions = {}): Promise<string | null> {
    const result = await this.crawl(url, { ...options, onlyMainContent: true });
    return result?.markdown ?? result?.content ?? null;
  }
}

export const selfHostedCrawlerProvider = new SelfHostedCrawlerProvider();
