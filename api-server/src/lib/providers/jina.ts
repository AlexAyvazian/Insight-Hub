/**
 * Jina AI Provider
 *
 * Role: renewable web content extraction via Jina Reader (r.jina.ai).
 * Reader works without a key at the free basic rate; JINA_API_KEY is optional
 * and is used only to raise Reader limits and to enable the embeddings API.
 */

import { isObviouslyUnsafeUrl } from "../security/safeUrl";
import type {
  DataSourceProvider,
  FetchOptions,
  ProviderFetchResult,
  ProviderStatus,
} from "./types";
import { resolveCredential } from "../config/providerConfig";

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_EMBEDDINGS_URL = "https://api.jina.ai/v1/embeddings";
const JINA_EMBEDDING_MODEL = "jina-embeddings-v3";

export class JinaProvider implements DataSourceProvider {
  readonly name = "jina" as const;

  private async getApiKey(): Promise<string | null> {
    return resolveCredential("jinaApiKey", "JINA_API_KEY");
  }

  async isConfigured(): Promise<boolean> {
    return true;
  }

  async usageMode(): Promise<"keyed" | "keyless"> {
    return (await this.getApiKey()) ? "keyed" : "keyless";
  }

  async fetch(_options: FetchOptions): Promise<ProviderFetchResult> {
    return { records: [], total: 0, errors: [] };
  }

  async getStatus(): Promise<ProviderStatus> {
    let healthy = false;
    let errorMessage: string | undefined;

    try {
      const result = await this.extractUrl("https://example.com", 2000);
      healthy = result !== null && result.length > 10;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Unknown error";
    }

    return { name: this.name, configured: true, healthy, errorMessage };
  }

  async extractUrl(
    url: string,
    maxLength = 8000,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (isObviouslyUnsafeUrl(url)) return null;
    const apiKey = await this.getApiKey();

    try {
      const headers: Record<string, string> = {
        Accept: "text/plain",
        "X-Return-Format": "markdown",
        "X-Timeout": "10",
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const response = await fetch(
        `${JINA_READER_BASE}${encodeURIComponent(url)}`,
        {
          method: "GET",
          headers,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        },
      );

      if (!response.ok) return null;

      const text = await response.text();
      return text.slice(0, maxLength);
    } catch {
      return null;
    }
  }

  async embed(
    texts: string[],
    task: "retrieval.query" | "retrieval.passage" = "retrieval.passage",
  ): Promise<number[][] | null> {
    const apiKey = await this.getApiKey();
    if (!apiKey || texts.length === 0) return null;

    try {
      const response = await fetch(JINA_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: JINA_EMBEDDING_MODEL,
          task,
          input: texts.map((text) => text.slice(0, 2000)),
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.warn(
          `[Jina embed] HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
        return null;
      }

      const json = (await response.json()) as {
        data?: { index: number; embedding: number[] }[];
      };
      const data = json.data;
      if (!data?.length) return null;

      const out: (number[] | undefined)[] = new Array(texts.length).fill(
        undefined,
      );
      for (const item of data) {
        if (
          item.index >= 0 &&
          item.index < texts.length &&
          Array.isArray(item.embedding)
        ) {
          out[item.index] = item.embedding;
        }
      }
      if (out.some((value) => value === undefined)) return null;
      return out as number[][];
    } catch (error) {
      console.warn(
        `[Jina embed] ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  async extractUrls(
    urls: string[],
    concurrency = 3,
    maxLength = 6000,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    for (let index = 0; index < urls.length; index += concurrency) {
      const batch = urls.slice(index, index + concurrency);
      const extracted = await Promise.allSettled(
        batch.map((url) =>
          this.extractUrl(url, maxLength).then((text) => ({ url, text })),
        ),
      );

      for (const result of extracted) {
        if (result.status === "fulfilled" && result.value.text) {
          results.set(result.value.url, result.value.text);
        }
      }
    }

    return results;
  }
}

export const jinaProvider = new JinaProvider();
