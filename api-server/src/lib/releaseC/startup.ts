/**
 * Release C runtime wiring, called once from the web bootstrap:
 *   - secret redaction for console output (pino is redacted in logger.ts),
 *   - additive Release C tables (idempotent CREATE ... IF NOT EXISTS),
 *   - the review-queue tick: when queued records are due, start a normal ingestion run for the "reviewQueue"
 *     provider so approvals go through the same staging/promotion pipeline (skipped while another run is active),
 *   - optional document extraction child process (DOCUMENT_EXTRACTION_WORKER_MODE=child).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installConsoleRedaction } from "../security/logRedaction";
import { releaseCFlags } from "./flags";
import { ensureReleaseCSchema } from "./schema";

type Log = { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };

let child: ChildProcess | null = null;
let stopped = false;
const workerState = { starts: 0, exits: 0, lastStartAt: null as string | null, lastExit: null as Record<string, unknown> | null };

/** Document worker child status for the Release C status endpoint. */
export function documentWorkerState() {
  return { running: Boolean(child && child.exitCode === null && !child.killed), pid: child?.pid ?? null, ...workerState };
}
const timers: Array<ReturnType<typeof setInterval>> = [];

function workerEntry(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, "workers/documentExtractionWorker.mjs"), path.resolve(here, "../workers/documentExtractionWorker.mjs")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function startWorkerChild(log: Log, attempt = 0): void {
  const entry = workerEntry();
  if (!entry) {
    log.warn({ event: "document_worker_entry_missing" }, "Document worker build output not found; worker not started");
    return;
  }
  const heapMb = Math.max(64, Math.min(256, Number(process.env.DOCUMENT_WORKER_HEAP_MB ?? 128)));
  const spawned = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, entry], { env: process.env, stdio: ["ignore", "inherit", "inherit"] });
  child = spawned;
  workerState.starts += 1;
  workerState.lastStartAt = new Date().toISOString();
  log.info({ event: "document_worker_started", pid: spawned.pid, heapMb }, "Document extraction worker started");
  // A spawn failure emits "error" (possibly followed by "exit"); restart is scheduled once either way, and the
  // error never reaches the web process as an unhandled event.
  let restartScheduled = false;
  const scheduleRestart = (details: Record<string, unknown>) => {
    if (child === spawned) child = null;
    if (stopped || restartScheduled) return;
    restartScheduled = true;
    workerState.exits += 1;
    workerState.lastExit = { ...details, at: new Date().toISOString() };
    const delay = Math.min(30 * 60_000, 30_000 * 2 ** Math.min(attempt, 6));
    log.warn({ event: "document_worker_exited", ...details, restartInMs: delay }, "Document extraction worker exited");
    setTimeout(() => startWorkerChild(log, attempt + 1), delay).unref();
  };
  spawned.on("error", (error) => scheduleRestart({ error: error.message }));
  spawned.once("exit", (code, signal) => scheduleRestart({ code, signal }));
}

export async function startReleaseC(log: Log): Promise<void> {
  installConsoleRedaction();
  const flags = releaseCFlags();
  try {
    await ensureReleaseCSchema();
  } catch (error) {
    log.warn({ event: "release_c_schema_failed", error: error instanceof Error ? error.message : String(error) }, "Release C tables not ready; features degrade to in-memory");
  }
  log.info({ event: "release_c_flags", ...flags }, "Release C flags");

  if (flags.reviewQueue) {
    const intervalMs = Math.max(5 * 60_000, Number(process.env.REVIEW_QUEUE_INTERVAL_MS ?? 30 * 60_000));
    const tick = async () => {
      try {
        const { reviewQueueStats } = await import("./reviewQueue");
        const stats = await reviewQueueStats();
        if (stats.dueNow === 0) return;
        const { startManualIngestion, ActiveIngestionRunError } = await import("../ingestion/manualIngestion");
        try {
          const run = await startManualIngestion({ providers: ["reviewQueue"] });
          log.info({ event: "review_queue_run_started", runId: run.id, dueNow: stats.dueNow }, "Review queue run started");
        } catch (error) {
          if (error instanceof ActiveIngestionRunError) return;
          throw error;
        }
      } catch (error) {
        log.warn({ event: "review_queue_tick_failed", error: error instanceof Error ? error.message : String(error) }, "Review queue tick failed");
      }
    };
    const first = setTimeout(() => void tick(), 5 * 60_000);
    first.unref();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    timers.push(timer);
  }

  if (flags.documentPipeline && flags.workerMode === "child") startWorkerChild(log);
}

export function stopReleaseC(): void {
  stopped = true;
  for (const timer of timers) clearInterval(timer);
  child?.kill("SIGTERM");
}
