/** Gemini AI provider for query generation, extraction, and relevance scoring. */
import type {
  DataSourceProvider,
  FetchOptions,
  ProviderFetchResult,
  ProviderStatus,
} from "./types";
import { FreeTierCredentialPool } from "./freeTierCredentialPool";
import {
  judgeScopeBlock,
  profileClientTypes,
  profileDefaultQueries,
  profileServiceLabels,
  scoreGuidance,
} from "../search/profileText";

// gemini-2.0-flash was retired (404 "no longer available"); Google's error names gemini-3.8-flash. Override with
// GEMINI_MODEL.
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
function geminiEndpoint(): string {
  const model = (process.env.GEMINI_MODEL ?? "").trim().replace(/^models\//, "") || DEFAULT_GEMINI_MODEL;
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}
const credentials = new FreeTierCredentialPool(
  "gemini-multi-account",
  [
    { dbKey: "geminiApiKey", envKey: "GEMINI_API_KEY" },
    { envKey: "GEMINI_KEY_2" },
    { envKey: "GEMINI_KEY_3" },
  ],
  { rotateOnSuccess: false },
);

/**
 * Occu-Med's scope as the AI providers describe it. Everything here is read from the Neon relevance profile at
 * call time (the profile can refresh while the process runs), never captured at module load.
 */
export function occumedProfileView(): { company: string; services: string[]; clientTypes: string[] } {
  return {
    company: "Occu-Med",
    services: profileServiceLabels(),
    clientTypes: profileClientTypes(),
  };
}

/** Default web-search queries built from the profile's search bundles. */
export function occumedDefaultQueries(year: number = new Date().getFullYear()): string[] {
  return profileDefaultQueries(year);
}

/** Prompt lines describing what Occu-Med provides and who it serves, plus the profile's scope rules and policies. */
export function occumedScopeSummary(): string {
  const view = occumedProfileView();
  return [
    `${view.company} provides: ${view.services.join("; ")}.`,
    `They serve: ${view.clientTypes.join(", ")}.`,
    judgeScopeBlock(),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Scope rules and canonical score guidance every extractor prompt carries, rendered from the profile. */
export function occumedExtractionGuidance(): string {
  return [judgeScopeBlock(), scoreGuidance()].filter(Boolean).join("\n");
}

/**
 * Per-request timeout. Panel prompts of 20k+ characters on the flash model ran past 30 s in production, failing every
 * key in turn; callers with their own deadline still pass a signal. Override with GEMINI_TIMEOUT_MS.
 */
function geminiTimeoutMs(): number {
  const value = Number(process.env.GEMINI_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 60_000;
}

/**
 * Extra output tokens for the flash model's thinking, which counts against maxOutputTokens: with only the answer's
 * budget (700 for a panel batch) it ran out before writing any votes ("0/3 distinct valid panel votes" in
 * production). Override with GEMINI_THINKING_HEADROOM_TOKENS.
 */
function geminiThinkingHeadroom(): number {
  const value = Number(process.env.GEMINI_THINKING_HEADROOM_TOKENS);
  return Number.isFinite(value) && value >= 0 ? value : 2_048;
}

async function callGemini(
  apiKey: string,
  prompt: string,
  maxTokens = 512,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${geminiEndpoint()}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens + geminiThinkingHeadroom() },
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(geminiTimeoutMs())])
      : AbortSignal.timeout(geminiTimeoutMs()),
  });
  if (response.status === 429) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(
      `GEMINI_QUOTA_EXCEEDED: ${body?.error?.message ?? "Rate limit reached"}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as {
    candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  };
  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).filter((part) => !part.thought).map((part) => part.text ?? "").join("");
  if (!text.trim() && candidate?.finishReason === "MAX_TOKENS") {
    throw new Error("Gemini stopped at the output token limit before answering (thinking used the budget)");
  }
  return text
    .replace(/```json\n?/g, "")
    .replace(/```/g, "")
    .trim();
}

export class GeminiProvider implements DataSourceProvider {
  readonly name = "gemini" as const;

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

  async complete(
    prompt: string,
    maxTokens = 512,
    signal?: AbortSignal,
  ): Promise<string> {
    return credentials.run((apiKey) =>
      callGemini(apiKey, prompt, maxTokens, signal),
    );
  }

  async generateSearchQueries(customKeywords?: string): Promise<string[]> {
    const queryYear = new Date().getFullYear();
    if (!(await this.isConfigured())) return occumedDefaultQueries(queryYear);
    const prompt = `You are a procurement intelligence specialist helping Occu-Med find relevant contracting opportunities.\n${occumedScopeSummary()}\n${customKeywords ? `User-specified focus: ${customKeywords}` : ""}\nGenerate exactly 8 targeted web search queries for ACTIVE RFPs, solicitations, bids, and supplier opportunities in ${queryYear}. Include -awarded -"contract award" -"award notice" in each query. Respond ONLY with a JSON array of 8 strings.`;
    try {
      const queries = JSON.parse(await this.complete(prompt, 600));
      if (Array.isArray(queries) && queries.length > 0) return queries as string[];
    } catch (error) {
      if (/GEMINI_QUOTA_EXCEEDED/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    return occumedDefaultQueries(queryYear);
  }

  async extractOpportunityFromWebResult(
    title: string,
    url: string,
    content: string,
  ): Promise<{
    isOpportunity: boolean;
    title?: string;
    agency?: string;
    description?: string;
    deadline?: string | null;
    estimatedValue?: number | null;
    location?: string | null;
    relevanceScore?: number;
    relevanceReason?: string;
    reason?: string;
  } | null> {
    if (!(await this.isConfigured())) return null;
    const today = new Date().toISOString().split("T")[0];
    const prompt = `You are a strict procurement analyst for Occu-Med. Today is ${today}. Determine whether the following is a CURRENTLY OPEN procurement for a service Occu-Med provides: ${profileServiceLabels().join("; ")}. Reject awards, expired notices, jobs, news, regulations, and unrelated patient care.\n${occumedExtractionGuidance()}\nTitle: ${title}\nURL: ${url}\nContent: ${content.slice(0, 3000)}\nReturn JSON only. If accepted include isOpportunity:true,title,agency,description,deadline,estimatedValue,location,relevanceScore,relevanceReason. Otherwise return isOpportunity:false and reason.`;
    try {
      return JSON.parse(await this.complete(prompt, 512));
    } catch (error) {
      if (/GEMINI_QUOTA_EXCEEDED/i.test(error instanceof Error ? error.message : String(error))) throw error;
      return null;
    }
  }

  async scoreRelevance(
    opportunityTitle: string,
    description: string,
    orgContext: string,
  ): Promise<{ score: number; explanation: string } | null> {
    if (!(await this.isConfigured())) return null;
    const prompt = `Score relevance 0-100.\nOrganization: ${orgContext}\nOpportunity: ${opportunityTitle}\nDescription: ${description.slice(0, 2000)}\nRespond ONLY with JSON: {"score":<integer>,"explanation":"1-2 sentences"}`;
    try {
      return JSON.parse(await this.complete(prompt, 256));
    } catch (error) {
      if (/GEMINI_QUOTA_EXCEEDED/i.test(error instanceof Error ? error.message : String(error))) throw error;
      return null;
    }
  }
}

export const geminiProvider = new GeminiProvider();
