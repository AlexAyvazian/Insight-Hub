/**
 * Minimax Provider
 *
 * Role: Chinese-origin multimodal AI model (MiniMax). Used as an additional
 * AI scorer/extractor alongside Gemini, Groq, and OpenRouter for opportunity
 * classification and relevance scoring — adds diversity to the AI ensemble.
 *
 * API docs: https://platform.minimaxi.com/document/ChatCompletion%20v2
 */

import type { DataSourceProvider, FetchOptions, ProviderFetchResult, ProviderStatus } from "./types";
import { resolveCredential } from "../config/providerConfig";
import { occumedExtractionGuidance } from "./gemini";

const MINIMAX_BASE = "https://api.minimaxi.chat/v1";
const DEFAULT_MODEL = "MiniMax-Text-01";

export class MinimaxProvider implements DataSourceProvider {
  readonly name = "minimax" as const;

  private async getApiKey(): Promise<string | null> {
    return resolveCredential("minimaxApiKey", "MINIMAX_API_KEY");
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
    signal?: AbortSignal,
  ): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error("Minimax API key not configured.");

    const res = await fetch(`${MINIMAX_BASE}/text/chatcompletion_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Minimax error ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      base_resp?: { status_code?: number; status_msg?: string };
    };
    // MiniMax reports account errors (balance, auth, rate limit) as HTTP 200 with a non-zero base_resp code and no
    // choices. Surface them so the caller's budget tracking can cool the provider down instead of retrying blindly.
    const code = Number(json.base_resp?.status_code ?? 0);
    if (code !== 0) throw new Error(`Minimax error ${code}: ${String(json.base_resp?.status_msg ?? "").slice(0, 200)}`);
    return (json.choices?.[0]?.message?.content ?? "").trim();
  }

  async scoreRelevance(
    opportunityTitle: string,
    description: string,
    orgContext: string
  ): Promise<{ score: number; explanation: string } | null> {
    const prompt = `Score relevance 0-100.
Org: ${orgContext}
Opportunity: ${opportunityTitle}
Description: ${description.slice(0, 1500)}

JSON only: {"score":<0-100>,"explanation":"1-2 sentences"}`;

    try {
      const text = await this.complete(prompt, 200);
      const cleaned = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  async extractOpportunityFromWebResult(
    title: string,
    url: string,
    content: string
  ): Promise<{ isOpportunity: boolean; title?: string; agency?: string; description?: string; deadline?: string | null; estimatedValue?: number | null; location?: string | null; relevanceScore?: number; relevanceReason?: string; reason?: string } | null> {
    const today = new Date().toISOString().split("T")[0];
    const prompt = `Procurement analyst for Occu-Med. Today: ${today}
Is this an ACTIVE open solicitation Occu-Med could bid on?
${occumedExtractionGuidance()}
Title: ${title}
URL: ${url}
Content: ${content.slice(0, 2000)}
If YES: {"isOpportunity":true,"title":"...","agency":"...","description":"...","deadline":"YYYY-MM-DD or null","estimatedValue":number or null,"location":"...","relevanceScore":0-100,"relevanceReason":"..."}
If NO: {"isOpportunity":false,"reason":"..."}`;

    try {
      const text = await this.complete(prompt, 400);
      const cleaned = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

export const minimaxProvider = new MinimaxProvider();
