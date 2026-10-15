import { resolveCredential } from "../config/providerConfig";

const DEFAULT_MODEL = "gemini-embedding-001";
const REQUEST_TIMEOUT_MS = 25_000;

export type GeminiEmbeddingInputType = "query" | "document";

function taskType(inputType: GeminiEmbeddingInputType): string {
  return inputType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
}

function validVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

/**
 * Text-only Gemini embedding fallback. Cloudflare remains the primary semantic
 * provider; Gemini is used only when Cloudflare is unavailable or fails. Its
 * vectors are never mixed with vectors produced by another model.
 */
export class GeminiEmbeddingProvider {
  private async apiKey(): Promise<string | null> {
    // Same key pool as Gemini generation: the first usable key wins, so one bad or missing key does not disable
    // Gemini embeddings while GEMINI_KEY_2 / GEMINI_KEY_3 are configured.
    return (
      (await resolveCredential("geminiApiKey", "GEMINI_API_KEY")) ??
      (await resolveCredential("geminiKey2", "GEMINI_KEY_2")) ??
      (await resolveCredential("geminiKey3", "GEMINI_KEY_3"))
    );
  }

  private async model(): Promise<string> {
    return (
      (await resolveCredential(
        "geminiEmbeddingModel",
        "GEMINI_EMBEDDING_MODEL",
      )) ?? DEFAULT_MODEL
    );
  }

  async isConfigured(): Promise<boolean> {
    return !!(await this.apiKey());
  }

  async embed(
    texts: string[],
    inputType: GeminiEmbeddingInputType,
  ): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    const apiKey = await this.apiKey();
    if (!apiKey) return null;
    const model = await this.model();
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text: text.slice(0, 8_000) }] },
            taskType: taskType(inputType),
            outputDimensionality: 768,
          })),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Gemini embeddings error ${response.status}: ${body.slice(0, 240)}`,
      );
    }
    const payload = (await response.json()) as {
      embeddings?: Array<{ values?: unknown }>;
    };
    const vectors = (payload.embeddings ?? [])
      .map((row) => row.values)
      .filter(validVector);
    return vectors.length === texts.length ? vectors : null;
  }
}

export const geminiEmbeddingProvider = new GeminiEmbeddingProvider();
