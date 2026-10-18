/**
 * Release C extraction self-test: proves the production document path on synthetic fixtures, spending at most a few
 * free units (one LLMWhisperer page and about 1.5 Nutrient credits).
 *
 *   1. OCR: a one-page scanned PDF (no text layer) is registered for a synthetic opportunity and the real worker
 *      sends it to remote OCR; the recognised text must contain the fixture's verification code.
 *   2. Cache: the same bytes under another URL and opportunity must be served from the content-hash cache.
 *   3. Amendment: a notice is re-checked after its content changes; the old version must be superseded and the new
 *      text stored, with a document_version_changed audit event.
 *   4. Nutrient fallback: the scanned page is sent to Nutrient directly (the fallback the worker uses when no
 *      LLMWhisperer account is available).
 *
 * Synthetic rows use the opportunity key prefix "release-c-selftest:" and touch no real opportunity. Runs only when
 * RELEASE_C_SELFTEST_ENABLED=true, one at a time, and at most once per cooldown per process.
 */
import { randomUUID } from "node:crypto";
import { extractWithNutrient } from "../documents/remoteExtractors";
import { documentsFor, registerAttachments, sectionsFor } from "../documents/store";
import { rcPool } from "./db";
import { ensureReleaseCSchema } from "./schema";
import { SELFTEST_OCR_MARKER, SELFTEST_SCANNED_PDF_BASE64, selftestAmendmentHtml } from "./selftestFixtures";

export const SELFTEST_KEY_PREFIX = "release-c-selftest:";
const COOLDOWN_MS = 6 * 3_600_000;
const STEP_TIMEOUT_MS = Number(process.env.RELEASE_C_SELFTEST_STEP_TIMEOUT_MS ?? 8 * 60_000);
const POLL_MS = 10_000;

export interface SelftestStep {
  name: "ocr" | "cache" | "amendment" | "nutrient";
  ok: boolean | null;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface SelftestRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "passed" | "failed";
  steps: SelftestStep[];
  usageBefore: Record<string, unknown>[];
  usageAfter: Record<string, unknown>[] | null;
}

const runs = new Map<string, SelftestRun>();
const noticeVersion = new Map<string, 1 | 2>();
let lastStartedAt = 0;
let active: string | null = null;

export function selftestEnabled(): boolean {
  return process.env.RELEASE_C_SELFTEST_ENABLED === "true";
}

export function selftestRun(id: string): SelftestRun | null {
  return runs.get(id) ?? null;
}

/** Fixture bytes for the worker to download. Unknown runs or names return null. */
export function selftestFixture(runId: string, name: string): { body: Uint8Array | string; contentType: string } | null {
  if (!runs.has(runId)) return null;
  if (name === "scanned.pdf" || name === "scanned-copy.pdf") return { body: scannedBytes(runId), contentType: "application/pdf" };
  if (name === "notice.html") return { body: selftestAmendmentHtml(noticeVersion.get(runId) ?? 1), contentType: "text/html; charset=utf-8" };
  return null;
}

/**
 * The scanned fixture with a trailing PDF comment naming the run, so every run has a new content hash and its OCR
 * step cannot be satisfied from an earlier run's cache entry. Both URLs of one run share the bytes (the cache step).
 */
export function scannedBytes(runId: string): Uint8Array {
  return Buffer.concat([Buffer.from(SELFTEST_SCANNED_PDF_BASE64, "base64"), Buffer.from(`\n% release-c-selftest ${runId}\n`)]);
}

function publicBase(): string | null {
  const base = (process.env.RELEASE_C_SELFTEST_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").trim().replace(/\/+$/, "");
  return base || null;
}

async function usageSnapshot(): Promise<Record<string, unknown>[]> {
  const result = await (await rcPool()).query(
    `SELECT pool, slot, provider, used_today, used_month, used_total, requests_total, quota_remaining, last_outcome
       FROM provider_account_usage WHERE pool IN ('llmwhisperer-multi-account','nutrient-extraction') OR provider IN ('llmwhisperer','nutrient')
       ORDER BY pool, slot`,
  );
  return result.rows as Record<string, unknown>[];
}

async function jobFor(documentId: string): Promise<{ status: string; lastError: string | null } | null> {
  const result = await (await rcPool()).query(`SELECT status, last_error FROM document_extraction_jobs WHERE document_id = $1`, [documentId]);
  const row = result.rows[0];
  return row ? { status: String(row.status), lastError: (row.last_error as string | null) ?? null } : null;
}

/** Waits until the current document for `url` under `key` has a settled job, and returns it. */
async function waitForDocument(key: string, url: string, settled: (doc: Awaited<ReturnType<typeof documentsFor>>[number]) => boolean) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const docs = await documentsFor(key);
    const doc = docs.find((d) => d.sourceUrl === url && !d.supersededBy);
    if (doc && settled(doc)) {
      const job = await jobFor(doc.id);
      if (job && job.status !== "running" && job.status !== "queued") return { doc, job, docs };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

/** OCR output may space or break the digits ("4 7 2 1"), so the marker is matched with whitespace removed. */
export function hasMarker(text: string): boolean {
  return text.replace(/\s+/g, "").includes(SELFTEST_OCR_MARKER);
}

/** A short sample of synthetic fixture text, so a failed check shows what the extractor actually returned. */
function sample(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

async function step(run: SelftestRun, name: SelftestStep["name"], work: () => Promise<Omit<SelftestStep, "name">>): Promise<void> {
  try {
    run.steps.push({ name, ...(await work()) });
  } catch (error) {
    run.steps.push({ name, ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) });
  }
}

async function execute(run: SelftestRun, base: string): Promise<void> {
  const keyA = `${SELFTEST_KEY_PREFIX}${run.id}:a`;
  const keyB = `${SELFTEST_KEY_PREFIX}${run.id}:b`;
  const fixture = (name: string) => `${base}/api/release-c/selftest-fixture/${run.id}/${name}`;
  const scannedUrl = fixture("scanned.pdf");
  const noticeUrl = fixture("notice.html");
  const ref = (url: string, title: string) => ({ url, title, role: "attachment" as const, sourceVersion: null, amendedAt: null });

  await registerAttachments(keyA, [ref(scannedUrl, "Self-test scanned page"), ref(noticeUrl, "Self-test notice")], 100);

  await step(run, "ocr", async () => {
    const done = await waitForDocument(keyA, scannedUrl, (doc) => doc.extractionStatus !== "pending");
    if (!done) return { ok: false, detail: "worker did not finish the scanned page in time" };
    const text = (await sectionsFor(keyA)).filter((s) => s.documentId === done.doc.id).map((s) => s.text).join(" ");
    const ok = done.doc.extractionStatus === "extracted" && hasMarker(text);
    return {
      ok,
      detail: ok ? `scanned page read by ${done.doc.extractionProvider}` : `status ${done.doc.extractionStatus}; marker ${hasMarker(text) ? "found" : "missing"}`,
      evidence: { status: done.doc.extractionStatus, method: done.doc.extractionMethod, provider: done.doc.extractionProvider, pages: `${done.doc.extractedPageCount}/${done.doc.pageCount}`, job: done.job.status, jobError: done.job.lastError, chars: text.length, sample: sample(text) },
    };
  });

  await step(run, "cache", async () => {
    const copyUrl = fixture("scanned-copy.pdf");
    await registerAttachments(keyB, [ref(copyUrl, "Self-test scanned copy")], 100);
    const done = await waitForDocument(keyB, copyUrl, (doc) => doc.extractionStatus !== "pending");
    if (!done) return { ok: false, detail: "worker did not finish the copy in time" };
    const ok = done.doc.extractionMethod === "content-hash-cache";
    return { ok, detail: ok ? "identical content reused from the hash cache (no remote call)" : `method ${done.doc.extractionMethod}`, evidence: { method: done.doc.extractionMethod, status: done.doc.extractionStatus } };
  });

  await step(run, "amendment", async () => {
    const first = await waitForDocument(keyA, noticeUrl, (doc) => doc.extractionStatus !== "pending");
    if (!first) return { ok: false, detail: "worker did not finish the notice in time" };
    noticeVersion.set(run.id, 2);
    // The re-check the ingestion path schedules for a re-listed attachment.
    await (await rcPool()).query(
      `UPDATE document_extraction_jobs SET status = 'queued', next_attempt_at = now(), updated_at = now() WHERE document_id = $1 AND status <> 'running'`,
      [first.doc.id],
    );
    const second = await waitForDocument(keyA, noticeUrl, (doc) => doc.id !== first.doc.id && doc.extractionStatus !== "pending");
    if (!second) return { ok: false, detail: "amended notice was not re-processed in time" };
    const text = (await sectionsFor(keyA)).filter((s) => s.documentId === second.doc.id).map((s) => s.text).join(" ");
    const audit = await (await rcPool()).query(
      `SELECT count(*)::int AS n FROM opportunity_audit_log WHERE opportunity_key = $1 AND event = 'document_version_changed'`,
      [keyA],
    );
    const superseded = second.docs.some((d) => d.id === first.doc.id && d.supersededBy === second.doc.id);
    const ok = superseded && /Amendment 1/.test(text) && Number(audit.rows[0]?.n ?? 0) >= 1;
    return {
      ok,
      detail: ok ? "old version superseded, amended text stored, version change audited" : `superseded ${superseded}; amended text ${/Amendment 1/.test(text)}`,
      evidence: { previousDocument: first.doc.id, currentDocument: second.doc.id, auditEvents: audit.rows[0]?.n ?? 0 },
    };
  });

  await step(run, "nutrient", async () => {
    const result = await extractWithNutrient({
      bytes: scannedBytes(run.id),
      fileName: "release-c-selftest.pdf",
      pages: [1],
      pageCount: 1,
      scanned: true,
    });
    const text = result.pages.map((p) => p.text).join(" ");
    const ok = hasMarker(text);
    return { ok, detail: ok ? `Nutrient read the scanned page (${result.unitsUsed} credits)` : "Nutrient returned text without the marker", evidence: { account: result.account, unitsUsed: result.unitsUsed, chars: text.length, sample: sample(text) } };
  });
}

export type StartResult = { started: SelftestRun } | { refused: string; status: number };

export async function startSelftest(): Promise<StartResult> {
  if (!selftestEnabled()) return { refused: "Self-test is disabled (RELEASE_C_SELFTEST_ENABLED is not true).", status: 403 };
  if (active) return { refused: `A self-test is already running (${active}).`, status: 409 };
  if (Date.now() - lastStartedAt < COOLDOWN_MS) return { refused: "A self-test ran recently; try again later.", status: 429 };
  const base = publicBase();
  if (!base) return { refused: "No public base URL (RENDER_EXTERNAL_URL) for the worker to fetch fixtures from.", status: 503 };
  // Reserve the slot before any await, so concurrent requests cannot both start a run.
  const id = randomUUID().slice(0, 8);
  const previousStart = lastStartedAt;
  active = id;
  lastStartedAt = Date.now();
  let usageBefore: Record<string, unknown>[];
  try {
    await ensureReleaseCSchema();
    usageBefore = await usageSnapshot();
  } catch (error) {
    active = null;
    lastStartedAt = previousStart;
    throw error;
  }
  const run: SelftestRun = { id, startedAt: new Date().toISOString(), finishedAt: null, status: "running", steps: [], usageBefore, usageAfter: null };
  runs.set(run.id, run);
  noticeVersion.set(run.id, 1);
  void execute(run, base)
    .catch((error) => {
      run.steps.push({ name: "ocr", ok: false, detail: `self-test aborted: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` });
    })
    .finally(async () => {
      run.usageAfter = await usageSnapshot().catch(() => null);
      run.finishedAt = new Date().toISOString();
      run.status = run.steps.length > 0 && run.steps.every((s) => s.ok === true) ? "passed" : "failed";
      active = null;
    });
  return { started: run };
}

/** For tests. */
export function resetSelftestState(): void {
  runs.clear();
  noticeVersion.clear();
  lastStartedAt = 0;
  active = null;
}
