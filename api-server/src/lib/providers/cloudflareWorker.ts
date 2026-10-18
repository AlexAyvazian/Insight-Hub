import type { DataSourceProvider, FetchOptions, ProviderFetchResult, ProviderStatus } from "./types";
import { isObviouslyUnsafeUrl } from "../security/safeUrl";
import { resolveCredential } from "../config/providerConfig";

export interface WorkerExtractResult {
  url: string;
  content: string;
  status?: number;
}

export class CloudflareWorkerProvider implements DataSourceProvider {
  readonly name = "cloudflareWorker" as const;

  private async getEndpoint(): Promise<string | null> {
    const value = await resolveCredential("cloudflareWorkerApi", "CLOUDFLARE_WORKER_API");
    if (!value) return null;
    return value.replace(/\/$/, "");
  }

  async isConfigured(): Promise<boolean> {
    return !!(await this.getEndpoint());
  }

  async fetch(_options: FetchOptions): Promise<ProviderFetchResult> {
    return { records: [], total: 0, errors: [] };
  }

  async getStatus(): Promise<ProviderStatus> {
    const endpoint = await this.getEndpoint();
    if (!endpoint) return { name: this.name, configured: false, healthy: false };

    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(8000) });
      return { name: this.name, configured: true, healthy: response.ok };
    } catch (error) {
      return {
        name: this.name,
        configured: true,
        healthy: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async extractUrl(
    url: string,
    maxLength = 8000,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (isObviouslyUnsafeUrl(url)) return null;
    const endpoint = await this.getEndpoint();
    if (!endpoint) return null;

    try {
      const response = await fetch(`${endpoint}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, maxLength }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      const json = (await response.json()) as { content?: string; text?: string; markdown?: string };
      const content = json.content ?? json.markdown ?? json.text;
      return content ? content.slice(0, maxLength) : null;
    } catch {
      return null;
    }
  }

  async search(query: string, limit = 10): Promise<WorkerExtractResult[] | null> {
    const endpoint = await this.getEndpoint();
    if (!endpoint) return null;

    try {
      const response = await fetch(`${endpoint}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) return null;
      const json = (await response.json()) as { results?: WorkerExtractResult[] };
      return json.results ?? null;
    } catch {
      return null;
    }
  }
}

export const cloudflareWorkerProvider = new CloudflareWorkerProvider();
