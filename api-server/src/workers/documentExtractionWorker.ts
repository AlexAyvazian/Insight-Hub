/**
 * Opportunity document extraction worker (Release C).
 *
 * Runs separately from the web process: as a child process of the web service (DOCUMENT_EXTRACTION_WORKER_MODE=child,
 * small heap, one document at a time), or standalone (`node dist/workers/documentExtractionWorker.mjs --once`) from
 * a scheduled job that has RFP_DATABASE_URL and the extraction keys. Free/open-source extraction first (pdf.js,
 * DOCX/XLSX/HTML parsers); only scanned pages go to the free tiers of LLMWhisperer (two tracked accounts) and then
 * Nutrient, and only while their free allowance is confirmed.
 */
import { rfpPool } from "@workspace/db";
import { runDocumentWorker } from "../lib/documents/worker";
import { reopenOpportunity } from "../lib/releaseC/reviewQueue";
import { installConsoleRedaction } from "../lib/security/logRedaction";

installConsoleRedaction();

const once = process.argv.includes("--once");
const idleMs = Math.max(10_000, Number(process.env.DOCUMENT_WORKER_IDLE_MS ?? 120_000));
const batchJobs = Math.max(1, Number(process.env.DOCUMENT_WORKER_BATCH_JOBS ?? 10));
const batchDeadlineMs = Math.max(30_000, Number(process.env.DOCUMENT_WORKER_BATCH_DEADLINE_MS ?? 10 * 60_000));
let stopping = false;

process.once("SIGTERM", () => {
  stopping = true;
});
process.once("SIGINT", () => {
  stopping = true;
});

async function main(): Promise<void> {
  do {
    const summary = await runDocumentWorker({
      maxJobs: batchJobs,
      deadlineMs: batchDeadlineMs,
      reopen: (key, reason) => reopenOpportunity(key, reason),
    }).catch((error) => {
      console.error(JSON.stringify({ event: "document_worker_batch_failed", error: error instanceof Error ? error.message : String(error) }));
      return null;
    });
    if (summary) {
      console.info(
        JSON.stringify({
          event: "document_worker_batch",
          processed: summary.processed,
          stoppedBy: summary.stoppedBy,
          statuses: summary.outcomes.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {}),
        }),
      );
    }
    if (once || stopping) break;
    if (!summary || summary.stoppedBy === "empty") await new Promise((resolve) => setTimeout(resolve, idleMs));
  } while (!stopping);
  await rfpPool.end().catch(() => undefined);
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(JSON.stringify({ event: "document_worker_crashed", error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  },
);
