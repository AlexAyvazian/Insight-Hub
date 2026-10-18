import type {
  DataSourceProvider,
  FetchOptions,
  ProviderFetchResult,
  ProviderStatus,
} from "./types";
import type { ProviderName } from "../config/providerConfig";
import { resolveCredential } from "../config/providerConfig";

export interface OpenAiCompatibleProviderOptions {
  name: ProviderName;
  dbKey: string;
  envKey: string;
  baseUrl: string;
  defaultModel: string;
  displayName: string;
  modelDbKey?: string;
  modelEnvKey?: string;
  extraHeaders?: Record<string, string>;
}

/**
 * Generic OpenAI-compatible chat-completion provider used as an explicit
 * failover/validation utility. These providers do not act as opportunity feeds.
 */
export class OpenAiCompatibleProvider implements DataSourceProvider {
  readonly name: ProviderName;
  private readonly dbKey: string;
  private readonly envKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly displayName: string;
  private readonly modelDbKey?: string;
  private readonly modelEnvKey?: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.name = options.name;
    this.dbKey = options.dbKey;
    this.envKey = options.envKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.defaultModel = options.defaultModel;
    this.displayName = options.displayName;
    this.modelDbKey = options.modelDbKey;
    this.modelEnvKey = options.modelEnvKey;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  private async getApiKey(): Promise<string | null> {
    return resolveCredential(this.dbKey, this.envKey);
  }

  private async getModel(): Promise<string> {
    if (!this.modelDbKey && !this.modelEnvKey) return this.defaultModel;
    return (
      (await resolveCredential(
        this.modelDbKey ?? `${this.name}Model`,
        this.modelEnvKey,
      )) ?? this.defaultModel
    );
  }

  async isConfigured(): Promise<boolean> {
    return !!(await this.getApiKey());
  }

  async fetch(_options: FetchOptions): Promise<ProviderFetchResult> {
    return { records: [], total: 0, errors: [] };
  }

  async getStatus(): Promise<ProviderStatus> {
    const configured = await this.isConfigured();
    return { name: this.name, configured, healthy: configured };
  }

  async complete(
    prompt: string,
    maxTokens = 512,
    modelOverrideOrSignal?: string | AbortSignal,
    signal?: AbortSignal,
  ): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error(`${this.displayName} API key not configured.`);
    const modelOverride =
      typeof modelOverrideOrSignal === "string" ? modelOverrideOrSignal : undefined;
    const parentSignal =
      modelOverrideOrSignal instanceof AbortSignal
        ? modelOverrideOrSignal
        : signal;
    const model = modelOverride ?? (await this.getModel());
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.2,
    };

    // GPT OSS 120B is used only for bounded difficult-record validation. Medium
    // reasoning gives it enough room to reconcile evidence without turning every
    // search result into an expensive deep-reasoning request.
    if (this.name === "cerebras" && model === "gpt-oss-120b") {
      body.reasoning_effort = "medium";
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: parentSignal
        ? AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });

    if (response.status === 429) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `${this.name.toUpperCase()}_RATE_LIMITED: ${
          text.slice(0, 200) || "Rate limit reached"
        }`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `${this.displayName} error ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return (json.choices?.[0]?.message?.content ?? "").trim();
  }
}

export const cerebrasProvider = new OpenAiCompatibleProvider({
  name: "cerebras",
  dbKey: "cerebrasApiKey",
  envKey: "CEREBRAS_API_KEY",
  modelDbKey: "cerebrasModel",
  modelEnvKey: "CEREBRAS_MODEL",
  displayName: "Cerebras",
  baseUrl: "https://api.cerebras.ai/v1",
  defaultModel: "gpt-oss-120b",
});

export const deepseekProvider = new OpenAiCompatibleProvider({
  name: "deepseek",
  dbKey: "deepseekApiKey",
  envKey: "DEEPSEEK_API_KEY",
  modelDbKey: "deepseekModel",
  modelEnvKey: "DEEPSEEK_MODEL",
  displayName: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  defaultModel: "deepseek-chat",
});

export const mistralProvider = new OpenAiCompatibleProvider({
  name: "mistral",
  dbKey: "mistralApiKey",
  envKey: "MISTRAL_API_KEY",
  modelDbKey: "mistralModel",
  modelEnvKey: "MISTRAL_MODEL",
  displayName: "Mistral",
  baseUrl: "https://api.mistral.ai/v1",
  defaultModel: "mistral-small-latest",
});

export const nvidiaProvider = new OpenAiCompatibleProvider({
  name: "nvidia",
  dbKey: "nvidiaApiKey",
  envKey: "NVIDIA_API_KEY",
  modelDbKey: "nvidiaModel",
  modelEnvKey: "NVIDIA_MODEL",
  displayName: "NVIDIA NIM",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  // meta/llama-3.1-8b-instruct reached end of life on 2026-08-26 (410), and z-ai/glm-5.3-flash timed out at 30 s in
  // production. Nemotron 70B is a non-reasoning model that answers well inside the timeout. Override with NVIDIA_MODEL.
  defaultModel: "nvidia/llama-3.1-nemotron-70b-instruct",
});
