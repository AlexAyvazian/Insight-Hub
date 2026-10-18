/**
 * Free-tier remote extraction for scanned PDFs, images and legacy Office files.
 *
 * LLMWhisperer (Unstract) — two independently tracked accounts, LLMWHISPERER_API_KEY and LLMWHISPERER_API_KEY_2.
 *   Free plan: 100 pages per day on every mode, no monthly cap; pages beyond the daily allowance are billable, so
 *   usage is hard-capped below the allowance and confirmed with the free /get-usage-info endpoint before each
 *   job. Text can be retrieved only once, so it is stored immediately. Docs: docs.unstract.com/llmwhisperer.
 * Nutrient Data Extraction API — fallback, NUTRIENT_API_KEY. Free plan: 5,000 credits per month (text 1/page,
 *   structure with OCR 1.5/page), refreshed monthly. Pay-as-you-go can bill beyond that if enabled on the account,
 *   so spending is capped locally at NUTRIENT_MONTHLY_CREDIT_CAP (default 4,500).
 *
 * Neither provider is ever asked to process more pages than the remaining free capacity allows.
 */
import { FreeTierCredentialPool } from "../providers/freeTierCredentialPool";
import { ProviderQuotaError, resetFromHeaders, type AccountPolicy, type QuotaSnapshot } from "../providers/accountLedger";
import type { ExtractedPage } from "./types";

const WHISPER_BASE = "https://llmwhisperer-api.us-central.unstract.com/api/v2";
const NUTRIENT_PARSE_URL = "https://api.nutrient.io/extraction/parse";
const PAGE_SEPARATOR = "<<<INSIGHT_HUB_PAGE_BREAK>>>";

export interface RemoteExtraction {
  provider: "llmwhisperer" | "nutrient";
  account: string;
  pages: ExtractedPage[];
  unitsUsed: number;
}

export interface RemoteExtractionRequest {
  bytes: Uint8Array;
  fileName: string;
  /** 1-based pages that still need text (null = whole document). */
  pages: number[] | null;
  /** Total page count when known (for capacity planning). */
  pageCount: number | null;
  scanned: boolean;
  signal?: AbortSignal;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function llmWhispererPolicy(slot: string): AccountPolicy {
  return {
    pool: "llmwhisperer",
    slot,
    provider: "llmwhisperer",
    allowanceKind: "recurring_daily",
    unit: "pages",
    periodLimit: envNumber("LLMWHISPERER_DAILY_FREE_PAGES", 100),
    safetyFraction: 0.95,
    overageBillable: true,
  };
}

export function nutrientPolicy(slot: string): AccountPolicy {
  return {
    pool: "nutrient",
    slot,
    provider: "nutrient",
    allowanceKind: "recurring_monthly",
    unit: "credits",
    periodLimit: envNumber("NUTRIENT_MONTHLY_FREE_CREDITS", 5_000),
    // Cap = NUTRIENT_MONTHLY_CREDIT_CAP / allowance; default 4,500 of 5,000 (90%).
    safetyFraction: Math.min(1, envNumber("NUTRIENT_MONTHLY_CREDIT_CAP", 4_500) / envNumber("NUTRIENT_MONTHLY_FREE_CREDITS", 5_000)),
    overageBillable: true,
  };
}

/** Free usage probe. Returns null when the account is on a plan we refuse to spend on (paid with overage). */
export async function llmWhispererUsage(apiKey: string, signal?: AbortSignal): Promise<QuotaSnapshot> {
  const response = await fetch(`${WHISPER_BASE}/get-usage-info`, {
    headers: { "unstract-key": apiKey },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new ProviderQuotaError(`LLMWhisperer usage ${response.status}: invalid key`, "auth");
  if (!response.ok) throw new Error(`LLMWhisperer usage error ${response.status}`);
  const json = (await response.json()) as {
    subscription_plan?: string;
    daily_quota?: number;
    today_page_count?: number;
    monthly_quota?: number;
    current_page_count?: number;
  };
  const dailyQuota = Number(json.daily_quota);
  const today = Number(json.today_page_count ?? 0);
  if (!(dailyQuota > 0)) {
    // daily_quota is -1 only on paid plans, where pages bill per use. Refuse to spend there.
    return { limit: 0, remaining: 0, source: `llmwhisperer:get-usage-info (plan ${json.subscription_plan ?? "unknown"} has no free daily quota)` };
  }
  const now = new Date();
  return {
    limit: dailyQuota,
    usedToday: today,
    remaining: Math.max(0, dailyQuota - today),
    resetAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)),
    source: "llmwhisperer:get-usage-info",
  };
}

const whisperPool = new FreeTierCredentialPool(
  "llmwhisperer-multi-account",
  [{ envKey: "LLMWHISPERER_API_KEY" }, { envKey: "LLMWHISPERER_API_KEY_2" }],
  {
    rotateOnSuccess: false,
    accounts: { policyFor: llmWhispererPolicy, probe: (apiKey) => llmWhispererUsage(apiKey), unitsPerCall: 1, probeBeforeEachRun: true },
  },
);

const nutrientPool = new FreeTierCredentialPool(
  "nutrient-extraction",
  [{ envKey: "NUTRIENT_API_KEY" }],
  { rotateOnSuccess: false, accounts: { policyFor: nutrientPolicy, unitsPerCall: 1 } },
);

export function extractionCredentialPools() {
  return { llmwhisperer: whisperPool, nutrient: nutrientPool };
}

function quotaFromResponse(provider: string, response: Response, body: string): never {
  const resetAt = resetFromHeaders(response.headers);
  if (response.status === 401 || response.status === 403) {
    throw new ProviderQuotaError(`${provider} ${response.status}: authentication failed`, "auth");
  }
  if (response.status === 402 || /quota|credit|limit exceeded|insufficient/i.test(body)) {
    throw new ProviderQuotaError(`${provider} ${response.status}: free allowance exhausted`, "quota_exhausted", resetAt);
  }
  if (response.status === 429) throw new ProviderQuotaError(`${provider} 429: rate limited`, "rate_limited", resetAt ?? new Date(Date.now() + 60_000));
  throw new Error(`${provider} error ${response.status}: ${body.slice(0, 200)}`);
}

function pageSpec(pages: number[] | null): string | null {
  if (!pages || pages.length === 0) return null;
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (const page of sorted.slice(1).concat([Number.NaN])) {
    if (page === prev + 1) {
      prev = page;
      continue;
    }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`);
    start = page;
    prev = page;
  }
  return ranges.join(",");
}

async function sleep(ms: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

export async function extractWithLlmWhisperer(request: RemoteExtractionRequest): Promise<RemoteExtraction> {
  const plannedPages = request.pages?.length ?? request.pageCount ?? 1;
  return whisperPool.run(
    async (apiKey, slot, context) => {
      const url = new URL(`${WHISPER_BASE}/whisper`);
      url.searchParams.set("mode", request.scanned ? "high_quality" : "native_text");
      url.searchParams.set("output_mode", "layout_preserving");
      url.searchParams.set("page_separator", PAGE_SEPARATOR);
      url.searchParams.set("file_name", request.fileName.slice(0, 120));
      const spec = pageSpec(request.pages);
      if (spec) url.searchParams.set("pages_to_extract", spec);
      const submit = await fetch(url, {
        method: "POST",
        headers: { "unstract-key": apiKey, "Content-Type": "application/octet-stream" },
        body: request.bytes,
        signal: request.signal ?? AbortSignal.timeout(60_000),
      });
      const submitBody = await submit.text();
      if (submit.status !== 202 && !submit.ok) quotaFromResponse("LLMWhisperer", submit, submitBody);
      const hash = (JSON.parse(submitBody) as { whisper_hash?: string }).whisper_hash;
      if (!hash) throw new Error("LLMWhisperer returned no whisper_hash");

      const deadline = Date.now() + 5 * 60_000;
      let delay = 2_000;
      while (true) {
        if (Date.now() > deadline) throw new Error("LLMWhisperer job timed out");
        await sleep(delay, request.signal);
        delay = Math.min(delay * 1.5, 15_000);
        const status = await fetch(`${WHISPER_BASE}/whisper-status?whisper_hash=${encodeURIComponent(hash)}`, {
          headers: { "unstract-key": apiKey },
          signal: request.signal ?? AbortSignal.timeout(20_000),
        });
        const statusBody = await status.text();
        if (!status.ok) quotaFromResponse("LLMWhisperer", status, statusBody);
        const state = (JSON.parse(statusBody) as { status?: string; message?: string }).status;
        if (state === "processed") break;
        if (state === "error") throw new Error(`LLMWhisperer processing error: ${statusBody.slice(0, 200)}`);
      }
      const retrieve = await fetch(`${WHISPER_BASE}/whisper-retrieve?whisper_hash=${encodeURIComponent(hash)}&text_only=true`, {
        headers: { "unstract-key": apiKey },
        signal: request.signal ?? AbortSignal.timeout(30_000),
      });
      const text = await retrieve.text();
      if (!retrieve.ok) quotaFromResponse("LLMWhisperer", retrieve, text);
      let resultText = text;
      try {
        const parsed = JSON.parse(text) as { result_text?: string };
        if (typeof parsed.result_text === "string") resultText = parsed.result_text;
      } catch {
        // text_only=true returns plain text.
      }
      const chunks = resultText.split(PAGE_SEPARATOR);
      const pageNumbers = request.pages?.length ? [...new Set(request.pages)].sort((a, b) => a - b) : chunks.map((_c, i) => i + 1);
      const pages = chunks
        .map((chunk, index) => ({ page: pageNumbers[index] ?? index + 1, text: chunk.trim(), needsOcr: chunk.trim().length < 10 }))
        .filter((page) => page.text.length > 0 || page.needsOcr);
      context.reportUsage(Math.max(1, pages.length), pages.some((page) => page.text.length > 40) ? "good" : "poor");
      return { provider: "llmwhisperer" as const, account: slot, pages, unitsUsed: Math.max(1, pages.length) };
    },
    { plannedUnits: plannedPages },
  );
}

export async function extractWithNutrient(request: RemoteExtractionRequest): Promise<RemoteExtraction> {
  const pages = request.pages?.length ?? request.pageCount ?? 1;
  const creditsPerPage = request.scanned ? 1.5 : 1;
  return nutrientPool.run(
    async (apiKey, slot, context) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(request.bytes)]), request.fileName.slice(0, 120));
      form.append("instructions", JSON.stringify({ mode: request.scanned ? "structure" : "text", output: { format: "markdown" } }));
      const response = await fetch(NUTRIENT_PARSE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: request.signal ?? AbortSignal.timeout(120_000),
      });
      const body = await response.text();
      if (!response.ok) quotaFromResponse("Nutrient", response, body);
      const json = JSON.parse(body) as {
        output?: { markdown?: string; pages?: Array<{ markdown?: string; text?: string; page?: number; pageIndex?: number }> };
        usage?: { data_extraction_credits?: { cost?: number } };
      };
      const cost = Number(json.usage?.data_extraction_credits?.cost);
      const extracted: ExtractedPage[] = json.output?.pages?.length
        ? json.output.pages.map((page, index) => ({
            page: page.page ?? (page.pageIndex != null ? page.pageIndex + 1 : index + 1),
            text: (page.markdown ?? page.text ?? "").trim(),
            needsOcr: false,
          }))
        : [{ page: 1, text: (json.output?.markdown ?? "").trim(), needsOcr: false }];
      const units = Number.isFinite(cost) && cost >= 0 ? cost : pages * creditsPerPage;
      context.reportUsage(units, extracted.some((page) => page.text.length > 40) ? "good" : "poor");
      return { provider: "nutrient" as const, account: slot, pages: extracted, unitsUsed: units };
    },
    { plannedUnits: pages * creditsPerPage },
  );
}

/** Tries LLMWhisperer accounts first, then Nutrient. Throws only when every free account is unavailable. */
export async function extractRemotely(request: RemoteExtractionRequest): Promise<RemoteExtraction> {
  const errors: string[] = [];
  if (await whisperPool.isConfigured()) {
    try {
      return await extractWithLlmWhisperer(request);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (await nutrientPool.isConfigured()) {
    try {
      return await extractWithNutrient(request);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new ProviderQuotaError(
    errors.length ? `No free extraction capacity: ${errors.join(" | ")}` : "No remote extractor is configured",
    "quota_exhausted",
  );
}
