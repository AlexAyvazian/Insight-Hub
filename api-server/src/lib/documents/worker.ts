/**
 * Document extraction worker. Runs outside the web process (a child process with its own small heap, or a
 * standalone run of dist/documentExtractionWorker.mjs) and processes the persistent document_extraction_jobs queue.
 *
 * Per job: SSRF-safe bounded download -> SHA-256 -> unchanged? done : cached by hash? reuse sections :
 * native open-source parse -> free-tier OCR only for pages without a text layer -> cited sections -> the owning
 * opportunity is reopened in the review queue so the new evidence is used. Quota waits are retried after the
 * provider's reset; nothing is dropped.
 */
import { hostname } from "node:os";
import { resolveCredential } from "../config/providerConfig";
import { ProviderQuotaError, sharedAccountLedger } from "../providers/accountLedger";
import { safeFetch, UnsafeUrlError } from "../security/safeUrl";
import { needsSamApiKey } from "./attachments";
import { htmlToText, parseDocumentNatively } from "./parsers";
import { acceptedJobError, CAPPED_METHOD_SUFFIX, extractionCredentialPools, extractRemotely, llmWhispererPolicy, PENDING_WHISPER_TTL_MS } from "./remoteExtractors";
import { buildSections } from "./sections";
import {
  claimNextJob,
  copySections,
  findExtractedByHash,
  finishJob,
  recordDocumentVersion,
  replaceSections,
  requeueNewlyAllowedContentTypes,
  sha256Hex,
  updateDocument,
  type ClaimedJob,
} from "./store";
import type { ExtractedPage, ParsedDocument } from "./types";

export const DOCUMENT_MAX_BYTES = Number(process.env.DOCUMENT_MAX_BYTES ?? 25 * 1024 * 1024);
const FETCH_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 5;

export const ALLOWED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "application/vnd.ms-office",
  "application/octet-stream",
  "application/zip",
  "application/x-zip-compressed",
  "application/json",
  // SAM.gov's noticedesc endpoint answers with HAL JSON.
  "application/hal+json",
  "application/rtf",
  "binary/octet-stream",
  "text/",
  "image/",
];

export interface JobOutcome {
  jobId: string;
  status: "done" | "failed" | "quota_wait" | "queued";
  detail: string;
  changed: boolean;
}

export type ReopenOpportunity = (opportunityKey: string, reason: string) => Promise<void>;

async function samKey(): Promise<string | null> {
  return (await resolveCredential("samApiKey", "SAM_GOV_API_KEY")) ?? process.env.SAM_GOV_API_KEY_2 ?? null;
}

export function withSamKey(url: string, key: string): string {
  const parsed = new URL(url);
  // resourceLinks often carry api_key=null; replace a missing, empty or "null" key.
  const existing = parsed.searchParams.get("api_key");
  if (!existing || existing.trim().toLowerCase() === "null") parsed.searchParams.set("api_key", key);
  return parsed.toString();
}

function fileNameFor(url: string, contentType: string): string {
  const raw = new URL(url).pathname.split("/").pop() ?? "document";
  let last = raw;
  try {
    last = decodeURIComponent(raw);
  } catch {
    // Malformed percent escapes: keep the undecoded name.
  }
  if (/\.[a-z0-9]{2,5}$/i.test(last)) return last;
  const ext = contentType.includes("pdf") ? ".pdf" : contentType.includes("word") ? ".docx" : contentType.includes("sheet") ? ".xlsx" : ".bin";
  return `${last || "document"}${ext}`;
}

/** SAM.gov's noticedesc endpoint returns JSON `{ description: "<html>" }`. */
export function samDescription(bytes: Uint8Array, contentType: string): ParsedDocument | null {
  if (!contentType.includes("json")) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { description?: string };
    if (typeof json.description !== "string") return null;
    return { format: "html", pageCount: 1, pages: [{ page: 1, text: htmlToText(json.description), needsOcr: false }], extractedPageCount: 1, method: "sam-noticedesc", warnings: [] };
  } catch {
    return null;
  }
}

async function nextWhisperReset(): Promise<Date> {
  const states = await Promise.all(
    ["LLMWHISPERER_API_KEY", "LLMWHISPERER_API_KEY_2"].map((slot) => sharedAccountLedger().state(llmWhispererPolicy(slot))),
  );
  const resets = states
    .map((state) => (state.cooldownUntil ? Date.parse(state.cooldownUntil) : state.resetAt ? Date.parse(state.resetAt) : Number.NaN))
    .filter((value) => Number.isFinite(value) && value > Date.now());
  return new Date(resets.length ? Math.min(...resets) : Date.now() + 6 * 3_600_000);
}

export async function processJob(job: ClaimedJob, reopen: ReopenOpportunity): Promise<JobOutcome> {
  const doc = job.document;
  let fetchUrl = doc.sourceUrl;
  if (needsSamApiKey(fetchUrl)) {
    const key = await samKey();
    if (!key) {
      await finishJob(job.jobId, "quota_wait", "SAM.gov API key not configured", new Date(Date.now() + 6 * 3_600_000));
      return { jobId: job.jobId, status: "quota_wait", detail: "sam key missing", changed: false };
    }
    fetchUrl = withSamKey(fetchUrl, key);
  }

  let fetched;
  try {
    fetched = await safeFetch(fetchUrl, { maxBytes: DOCUMENT_MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS, allowedContentTypes: ALLOWED_TYPES });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UnsafeUrlError) {
      const status = error.code === "too_large" ? "too_large" : error.code === "content_type" ? "unsupported" : "blocked";
      await updateDocument(doc.id, { retrieval_status: status, retrieval_error: message.slice(0, 300), extraction_status: "failed", last_checked_at: new Date() });
      await finishJob(job.jobId, "failed", message);
      await reopen(job.opportunityKey, `document ${status}`);
      return { jobId: job.jobId, status: "failed", detail: message, changed: false };
    }
    const retry = job.attempts < MAX_ATTEMPTS;
    await updateDocument(doc.id, { retrieval_status: retry ? "pending" : "failed", retrieval_error: message.slice(0, 300), last_checked_at: new Date() });
    await finishJob(job.jobId, retry ? "queued" : "failed", message, new Date(Date.now() + 2 ** job.attempts * 10 * 60_000));
    if (!retry) await reopen(job.opportunityKey, "document retrieval failed");
    return { jobId: job.jobId, status: retry ? "queued" : "failed", detail: message, changed: false };
  }

  if (fetched.status >= 400) {
    const detail = `HTTP ${fetched.status}`;
    const retry = fetched.status >= 500 && job.attempts < MAX_ATTEMPTS;
    await updateDocument(doc.id, { retrieval_status: retry ? "pending" : "failed", retrieval_error: detail, last_checked_at: new Date() });
    await finishJob(job.jobId, retry ? "queued" : "failed", detail, new Date(Date.now() + 2 ** job.attempts * 10 * 60_000));
    if (!retry) await reopen(job.opportunityKey, "document unavailable");
    return { jobId: job.jobId, status: retry ? "queued" : "failed", detail, changed: false };
  }

  const sha = sha256Hex(fetched.bytes);
  const base = {
    final_url: fetched.finalUrl.replace(/([?&]api_key=)[^&]+/i, "$1[redacted]"),
    content_type: fetched.contentType || null,
    byte_size: fetched.bytes.byteLength,
    retrieval_status: "fetched",
    retrieval_error: null,
    last_checked_at: new Date(),
    storage_ref: `sha256:${sha}`,
  };

  // Only fully extracted content takes the unchanged fast path: a partial document (OCR deferred for quota or an
  // accepted job still running) must be processed again so its missing pages are collected. The exception is a
  // document cut off at the unknown-length page cap: re-running it would only pay again for the same pages.
  const cappedPartial = doc.extractionStatus === "partial" && Boolean(doc.extractionMethod?.endsWith(CAPPED_METHOD_SUFFIX));
  if (doc.sha256 === sha && (doc.extractionStatus === "extracted" || cappedPartial)) {
    await updateDocument(doc.id, base);
    await finishJob(job.jobId, "done", null);
    return { jobId: job.jobId, status: "done", detail: "unchanged", changed: false };
  }

  const version = await recordDocumentVersion(doc, sha, base);
  const documentId = version.documentId;

  const found = await findExtractedByHash(sha);
  // A partial extraction is never reused as a cache hit, for the same reason.
  const cached = found?.extractionStatus === "extracted" ? found : null;
  if (cached && cached.id === documentId) {
    // Content reverted to a version already extracted: its row and sections were reactivated as they were.
    await finishJob(job.jobId, "done", null);
    await reopen(job.opportunityKey, "document version restored");
    return { jobId: job.jobId, status: "done", detail: "restored earlier extracted version", changed: true };
  }
  if (cached && cached.id !== documentId) {
    const copied = await copySections(cached.id, documentId, job.opportunityKey);
    await updateDocument(documentId, {
      extraction_status: cached.extractionStatus,
      extraction_method: "content-hash-cache",
      extraction_provider: cached.extractionProvider,
      page_count: cached.pageCount,
      extracted_page_count: cached.extractedPageCount,
    });
    await finishJob(job.jobId, "done", null);
    await reopen(job.opportunityKey, "document evidence available (cache)");
    return { jobId: job.jobId, status: "done", detail: `reused ${copied} cached sections`, changed: true };
  }

  let parsed: ParsedDocument;
  try {
    parsed = samDescription(fetched.bytes, fetched.contentType) ?? (await parseDocumentNatively(fetched.bytes, fetched.contentType, fetched.finalUrl));
  } catch (error) {
    parsed = { format: "unsupported", pageCount: 0, pages: [], extractedPageCount: 0, method: "none", warnings: [`native parse failed: ${error instanceof Error ? error.message : String(error)}`] };
  }

  let pages: ExtractedPage[] = parsed.pages;
  let provider: string | null = null;
  let account: string | null = null;
  let quotaWait = false;
  let acceptedAt: number | null = null;
  let capped = false;
  const needOcr = parsed.pages.filter((page) => page.needsOcr).map((page) => page.page);
  const remoteEligible = parsed.format === "pdf" || parsed.format === "image" || parsed.format === "legacy_office" || parsed.format === "unsupported";
  if (remoteEligible && (needOcr.length > 0 || parsed.pages.length === 0)) {
    try {
      const remote = await extractRemotely({
        bytes: fetched.bytes,
        fileName: fileNameFor(fetched.finalUrl, fetched.contentType),
        pages: parsed.format === "pdf" && parsed.pages.length ? needOcr : null,
        // Only PDFs report a real page count; other formats carry a one-page placeholder.
        pageCount: parsed.format === "pdf" ? parsed.pageCount || null : null,
        scanned: parsed.format !== "legacy_office",
      });
      provider = remote.provider;
      account = remote.account;
      capped = Boolean(remote.capped);
      if (capped) parsed.warnings.push("page cap reached for a document of unknown length; later pages were not extracted");
      const byPage = new Map(remote.pages.map((page) => [page.page, page]));
      // Non-PDF formats only have a placeholder page natively, so every remote page is kept.
      pages = parsed.format === "pdf" && parsed.pages.length
        ? parsed.pages.map((page) => (page.needsOcr && byPage.get(page.page)?.text ? { ...byPage.get(page.page)!, needsOcr: false } : page))
        : remote.pages;
    } catch (error) {
      quotaWait = error instanceof ProviderQuotaError;
      acceptedAt = acceptedJobError(error)?.submittedAt ?? null;
      parsed.warnings.push(`remote extraction unavailable: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    }
  }

  const sections = buildSections(pages);
  await replaceSections(documentId, job.opportunityKey, sections);
  const extractedPages = pages.filter((page) => !page.needsOcr && page.text.trim()).length;
  const totalPages = Math.max(parsed.pageCount, pages.length);
  // A capped unknown-length document is never complete: nothing shows that its last page was reached.
  const complete = !capped && totalPages > 0 && extractedPages >= totalPages;
  const status = complete ? "extracted" : extractedPages > 0 ? "partial" : quotaWait ? "quota_wait" : parsed.format === "unsupported" ? "unsupported" : "failed";
  await updateDocument(documentId, {
    page_count: totalPages || null,
    extracted_page_count: extractedPages,
    extraction_status: status,
    extraction_method: provider ? `${parsed.method}+${provider}${capped ? CAPPED_METHOD_SUFFIX : ""}` : parsed.method,
    extraction_provider: provider,
    extraction_account: account,
    extraction_quality: parsed.warnings.length ? parsed.warnings.join(" | ").slice(0, 500) : "ok",
  });

  if (!complete && acceptedAt !== null && Date.now() - acceptedAt < PENDING_WHISPER_TTL_MS) {
    // A remote job was accepted and charged; come back to collect it until its result expires, instead of
    // resubmitting elsewhere. The retention window, not the attempt count, bounds these retries.
    await finishJob(job.jobId, "queued", "waiting for accepted remote extraction", new Date(Date.now() + 10 * 60_000));
    return { jobId: job.jobId, status: "queued", detail: `${extractedPages}/${totalPages} pages; remote job pending`, changed: false };
  }
  if (!complete && quotaWait && job.attempts < MAX_ATTEMPTS + 10) {
    // Keep the partial text, and come back for the missing pages after the free allowance resets.
    await finishJob(job.jobId, "quota_wait", "waiting for free extraction capacity", await nextWhisperReset());
    await reopen(job.opportunityKey, "partial document evidence");
    return { jobId: job.jobId, status: "quota_wait", detail: `${extractedPages}/${totalPages} pages; waiting for OCR capacity`, changed: true };
  }
  await finishJob(job.jobId, "done", status === "extracted" ? null : parsed.warnings.join(" | ").slice(0, 300) || status);
  await reopen(job.opportunityKey, "document evidence available");
  return { jobId: job.jobId, status: "done", detail: `${status}: ${extractedPages}/${totalPages} pages, ${sections.length} sections`, changed: true };
}

export function isAllowedContentType(contentType: string): boolean {
  return ALLOWED_TYPES.some((allowed) => contentType.startsWith(allowed));
}

let allowListRecoveryDone = false;

export interface WorkerRunSummary {
  processed: number;
  outcomes: JobOutcome[];
  stoppedBy: "empty" | "deadline" | "max_jobs";
}

export async function runDocumentWorker(options: {
  maxJobs: number;
  deadlineMs: number;
  reopen: ReopenOpportunity;
  workerId?: string;
}): Promise<WorkerRunSummary> {
  const workerId = options.workerId ?? `${hostname()}:${process.pid}`;
  const started = Date.now();
  const outcomes: JobOutcome[] = [];
  extractionCredentialPools();
  if (!allowListRecoveryDone) {
    try {
      const requeued = await requeueNewlyAllowedContentTypes(isAllowedContentType);
      allowListRecoveryDone = true;
      if (requeued > 0) console.info(JSON.stringify({ event: "document_jobs_requeued_after_allow_list_change", requeued }));
    } catch (error) {
      // Retried on the next batch.
      console.warn(JSON.stringify({ event: "document_allow_list_recovery_failed", error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
    }
  }
  while (outcomes.length < options.maxJobs) {
    if (Date.now() - started > options.deadlineMs) return { processed: outcomes.length, outcomes, stoppedBy: "deadline" };
    const job = await claimNextJob(workerId);
    if (!job) return { processed: outcomes.length, outcomes, stoppedBy: "empty" };
    try {
      outcomes.push(await processJob(job, options.reopen));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finishJob(job.jobId, job.attempts < MAX_ATTEMPTS ? "queued" : "failed", message, new Date(Date.now() + 30 * 60_000)).catch(() => undefined);
      outcomes.push({ jobId: job.jobId, status: "failed", detail: message, changed: false });
    }
  }
  return { processed: outcomes.length, outcomes, stoppedBy: "max_jobs" };
}
