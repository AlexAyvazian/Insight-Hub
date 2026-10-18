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
import { FreeTierCredentialPool, type CredentialRunContext } from "../providers/freeTierCredentialPool";
import { ProviderQuotaError, resetFromHeaders, type AccountPolicy, type QuotaSnapshot } from "../providers/accountLedger";
import { createHash } from "node:crypto";
import { rcPool } from "../releaseC/db";
import { ensureReleaseCSchema } from "../releaseC/schema";
import type { ExtractedPage } from "./types";

const WHISPER_BASE = "https://llmwhisperer-api.us-central.unstract.com/api/v2";
const NUTRIENT_PARSE_URL = "https://api.nutrient.io/extraction/parse";
const NUTRIENT_ACCOUNT_URL = "https://api.nutrient.io/account/info";
const PAGE_SEPARATOR = "<<<INSIGHT_HUB_PAGE_BREAK>>>";

export interface RemoteExtraction {
  provider: "llmwhisperer" | "nutrient";
  account: string;
  pages: ExtractedPage[];
  unitsUsed: number;
  /** The page cap for an unknown-length document was reached, so pages beyond it may be missing. */
  capped?: boolean;
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

/**
 * Free Nutrient account check (GET /account/info, no credits used), for status reporting. Only the plan name and
 * numeric credit/usage fields are kept; the response also lists API keys, which are never read out.
 */
export async function nutrientAccountInfo(apiKey: string, signal?: AbortSignal): Promise<QuotaSnapshot & { plan: string | null; credits: Record<string, number> }> {
  const response = await fetch(NUTRIENT_ACCOUNT_URL, { headers: { Authorization: `Bearer ${apiKey}` }, signal: signal ?? AbortSignal.timeout(10_000) });
  if (response.status === 401 || response.status === 403) throw new ProviderQuotaError(`Nutrient account ${response.status}: authentication failed`, "auth");
  if (!response.ok) throw new Error(`Nutrient account error ${response.status}`);
  const json = (await response.json()) as Record<string, unknown>;
  const credits: Record<string, number> = {};
  const walk = (value: unknown, path: string) => {
    if (!value || typeof value !== "object" || /apikey/i.test(path)) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const name = path ? `${path}.${key}` : key;
      if (/apikey/i.test(key)) continue;
      if (typeof child === "number" && /credit|usage|used|remaining|limit|total/i.test(name)) credits[name] = child;
      else if (child && typeof child === "object") walk(child, name);
    }
  };
  walk(json, "");
  const plan = typeof json.subscriptionType === "string" ? json.subscriptionType : null;
  return { plan, credits, source: "nutrient:/account/info" };
}

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

/**
 * A remote job was accepted (and charged) but its result is not available yet. It is final for this run: the same
 * document is never resubmitted to another account or provider; the next attempt resumes the accepted job.
 */
export class AcceptedJobError extends Error {
  readonly credentialRetryable = false;
  readonly accountHealthy = true;
  /** When the remote job was accepted; its result can be collected until PENDING_WHISPER_TTL_MS after this. */
  readonly submittedAt: number;
  constructor(message: string, submittedAt: number = Date.now()) {
    super(message);
    this.name = "AcceptedJobError";
    this.submittedAt = submittedAt;
  }
}

/** The AcceptedJobError behind an error, whether thrown directly or wrapped as a cause. */
export function acceptedJobError(error: unknown): AcceptedJobError | null {
  if (error instanceof AcceptedJobError) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof AcceptedJobError ? cause : null;
}

interface PendingWhisperJob {
  slot: string;
  hash: string;
  submittedAt: number;
}

// LLMWhisperer keeps processed results for a limited time; after this an accepted job is treated as lost.
export const PENDING_WHISPER_TTL_MS = 6 * 60 * 60_000;
const pendingWhisperJobs = new Map<string, PendingWhisperJob>();

function whisperJobKey(request: RemoteExtractionRequest): string {
  return createHash("sha256")
    .update(request.bytes)
    .update(`|${pageSpec(request.pages) ?? ""}|${request.scanned ? "hq" : "native"}`)
    .digest("hex");
}

export function clearPendingWhisperJobs(): void {
  pendingWhisperJobs.clear();
}

// Accepted jobs are also persisted, so a restarted or redeployed worker resumes them instead of resubmitting.
// Database problems fall back to the in-process map; they never block extraction.
async function loadPendingWhisperJob(jobKey: string): Promise<PendingWhisperJob | undefined> {
  const local = pendingWhisperJobs.get(jobKey);
  if (local) return local;
  try {
    await ensureReleaseCSchema();
    const result = await (await rcPool()).query(
      `SELECT account_slot, remote_id, submitted_at FROM remote_extraction_jobs WHERE job_key = $1 AND provider = 'llmwhisperer'`,
      [jobKey],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const job = { slot: String(row.account_slot), hash: String(row.remote_id), submittedAt: new Date(row.submitted_at).getTime() };
    pendingWhisperJobs.set(jobKey, job);
    return job;
  } catch {
    return undefined;
  }
}

async function savePendingWhisperJob(jobKey: string, job: PendingWhisperJob, plannedUnits: number): Promise<void> {
  pendingWhisperJobs.set(jobKey, job);
  try {
    await ensureReleaseCSchema();
    await (await rcPool()).query(
      `INSERT INTO remote_extraction_jobs (job_key, provider, account_slot, remote_id, planned_units, submitted_at)
       VALUES ($1, 'llmwhisperer', $2, $3, $4, $5)
       ON CONFLICT (job_key) DO UPDATE SET account_slot = EXCLUDED.account_slot, remote_id = EXCLUDED.remote_id,
         planned_units = EXCLUDED.planned_units, submitted_at = EXCLUDED.submitted_at`,
      [jobKey, job.slot, job.hash, plannedUnits, new Date(job.submittedAt)],
    );
  } catch (error) {
    console.warn(JSON.stringify({ event: "remote_extraction_job_persist_failed", error: error instanceof Error ? error.message : String(error) }));
  }
}

async function deletePendingWhisperJob(jobKey: string): Promise<void> {
  pendingWhisperJobs.delete(jobKey);
  try {
    await (await rcPool()).query(`DELETE FROM remote_extraction_jobs WHERE job_key = $1`, [jobKey]);
  } catch {
    // Expired rows are ignored by the TTL check.
  }
}

/**
 * Pages a request may be charged for. When the real page count is unknown (legacy Office files, images), the
 * submission is capped with pages_to_extract, so a long document can never be charged beyond the planned pages.
 */
export const UNKNOWN_PAGE_COUNT_CAP = 20;
/** extraction_method suffix for a document cut off at UNKNOWN_PAGE_COUNT_CAP (kept partial, not re-run unchanged). */
export const CAPPED_METHOD_SUFFIX = "+capped";

export function whisperPlannedPages(request: Pick<RemoteExtractionRequest, "pages" | "pageCount">): { pages: number; spec: string | null } {
  if (request.pages?.length) return { pages: new Set(request.pages).size, spec: pageSpec(request.pages) };
  if (request.pageCount && request.pageCount > 0) return { pages: request.pageCount, spec: null };
  return { pages: UNKNOWN_PAGE_COUNT_CAP, spec: `1-${UNKNOWN_PAGE_COUNT_CAP}` };
}

export async function extractWithLlmWhisperer(request: RemoteExtractionRequest): Promise<RemoteExtraction> {
  const { pages: plannedPages, spec } = whisperPlannedPages(request);
  const jobKey = whisperJobKey(request);
  let pending = await loadPendingWhisperJob(jobKey);
  if (pending && Date.now() - pending.submittedAt > PENDING_WHISPER_TTL_MS) {
    // Past LLMWhisperer's retention the accepted result is gone; the document is extracted again.
    await deletePendingWhisperJob(jobKey);
    pending = undefined;
  }

  const operation = async (apiKey: string, slot: string, context: CredentialRunContext): Promise<RemoteExtraction> => {
    let hash = pending?.hash;
    let submittedAt = pending?.submittedAt ?? Date.now();
    if (!hash) {
      const url = new URL(`${WHISPER_BASE}/whisper`);
      url.searchParams.set("mode", request.scanned ? "high_quality" : "native_text");
      url.searchParams.set("output_mode", "layout_preserving");
      url.searchParams.set("page_separator", PAGE_SEPARATOR);
      url.searchParams.set("file_name", request.fileName.slice(0, 120));
      if (spec) url.searchParams.set("pages_to_extract", spec);
      const submit = await fetch(url, {
        method: "POST",
        headers: { "unstract-key": apiKey, "Content-Type": "application/octet-stream" },
        body: request.bytes,
        signal: request.signal ?? AbortSignal.timeout(60_000),
      });
      const submitBody = await submit.text();
      if (submit.status !== 202 && !submit.ok) quotaFromResponse("LLMWhisperer", submit, submitBody);
      hash = (JSON.parse(submitBody) as { whisper_hash?: string }).whisper_hash;
      if (!hash) throw new Error("LLMWhisperer returned no whisper_hash");
      submittedAt = Date.now();
      await savePendingWhisperJob(jobKey, { slot, hash, submittedAt }, plannedPages);
      // The accepted job is charged whether or not the result is retrieved, so it is counted now.
      context.reportUsage(plannedPages);
    }
    try {
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
        if (state === "error") {
          await deletePendingWhisperJob(jobKey);
          throw new Error(`LLMWhisperer processing error: ${statusBody.slice(0, 200)}`);
        }
      }
      const retrieve = await fetch(`${WHISPER_BASE}/whisper-retrieve?whisper_hash=${encodeURIComponent(hash)}&text_only=true`, {
        headers: { "unstract-key": apiKey },
        signal: request.signal ?? AbortSignal.timeout(30_000),
      });
      const text = await retrieve.text();
      if (!retrieve.ok) quotaFromResponse("LLMWhisperer", retrieve, text);
      await deletePendingWhisperJob(jobKey);
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
      const quality = pages.some((page) => page.text.length > 40) ? "good" : "poor";
      // Usage was counted at submission (only on a fresh submit); record any extra pages beyond the plan.
      const used = Math.max(1, pages.length);
      context.reportUsage(pending ? 0 : Math.max(0, used - plannedPages), quality);
      // With an unknown length, reaching the cap means the document may continue beyond the extracted pages.
      const capped = !request.pages?.length && !(request.pageCount && request.pageCount > 0) && chunks.length >= UNKNOWN_PAGE_COUNT_CAP;
      return { provider: "llmwhisperer" as const, account: slot, pages, unitsUsed: used, capped };
    } catch (error) {
      // After acceptance, never let the pool or the Nutrient fallback resubmit the same document.
      throw new AcceptedJobError(`LLMWhisperer job ${hash.slice(0, 12)} not completed: ${error instanceof Error ? error.message : String(error)}`, submittedAt);
    }
  };

  // An accepted job is collected on the account that accepted it, with no new reservation.
  if (pending) return whisperPool.runOnSlot(pending.slot, operation);
  return whisperPool.run(operation, { plannedUnits: plannedPages });
}

/** The whole document is uploaded (no page selection), so every page is charged, not only the OCR subset. */
export function nutrientPlannedCredits(request: Pick<RemoteExtractionRequest, "pageCount" | "pages" | "scanned">): number {
  // Unknown page count: plan the conservative cap (Nutrient has no page limit option, so the worker only sends
  // such documents when this much capacity is free).
  const known = Math.max(request.pageCount ?? 0, request.pages?.length ?? 0);
  const pages = known > 0 ? known : UNKNOWN_PAGE_COUNT_CAP;
  return pages * (request.scanned ? 1.5 : 1);
}

export async function extractWithNutrient(request: RemoteExtractionRequest): Promise<RemoteExtraction> {
  // Nutrient processes the whole upload and has no page-limit option, so a document whose page count is unknown
  // could be charged beyond any reservation. Such documents are left to LLMWhisperer (which caps pages) or stay
  // pending until one is available.
  if (!(request.pageCount && request.pageCount > 0)) {
    throw Object.assign(new Error("Nutrient skipped: page count unknown, so the charge cannot be bounded"), { credentialRetryable: false });
  }
  const plannedCredits = nutrientPlannedCredits(request);
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
      const units = Number.isFinite(cost) && cost >= 0 ? cost : plannedCredits;
      context.reportUsage(units, extracted.some((page) => page.text.length > 40) ? "good" : "poor");
      return { provider: "nutrient" as const, account: slot, pages: extracted, unitsUsed: units };
    },
    { plannedUnits: plannedCredits },
  );
}

/** Tries LLMWhisperer accounts first, then Nutrient. Throws only when every free account is unavailable. */
export async function extractRemotely(request: RemoteExtractionRequest): Promise<RemoteExtraction> {
  const errors: string[] = [];
  if (await whisperPool.isConfigured()) {
    try {
      return await extractWithLlmWhisperer(request);
    } catch (error) {
      if (acceptedJobError(error)) throw error;
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
