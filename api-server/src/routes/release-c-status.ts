/**
 * Release C operator status (read-only, administrative read authorization like /hardening/diagnostics).
 *
 *   GET /release-c/status       flags, document worker, documents and extraction jobs, review queue, per-account
 *                               usage ledger, coverage and audit events. No document text and no key material.
 *   GET /release-c/credentials  free capacity probes for the extraction and Linkup account slots (usage/balance
 *                               endpoints only; nothing billable). Cached for a few minutes.
 *   POST /release-c/extraction-selftest, GET /release-c/extraction-selftest/:id
 *                               the capped extraction self-test (lib/releaseC/selftest.ts); off unless enabled.
 *   GET /release-c/selftest-fixture/:run/:name  the self-test's synthetic documents, fetched by the worker.
 */
import { Router } from "express";
import { adminReadAllowed } from "../middleware/api-hardening";
import { releaseCFlags, reviewMode } from "../lib/releaseC/flags";
import { documentWorkerState } from "../lib/releaseC/startup";
import { rcPool } from "../lib/releaseC/db";
import { ensureReleaseCSchema } from "../lib/releaseC/schema";
import { redactSensitiveText } from "../lib/security/logRedaction";
import { selftestFixture, selftestRun, startSelftest } from "../lib/releaseC/selftest";

const router = Router();

const PROBE_CACHE_MS = 5 * 60_000;
/** Even `?refresh=1` reuses a result younger than this, and concurrent requests share one probe round. */
const PROBE_MIN_INTERVAL_MS = 60_000;
let probeCache: { at: number; value: unknown } | null = null;
let probeInFlight: Promise<unknown> | null = null;

/** Host and path only: attachment URLs can carry query-string credentials (for example SAM.gov api_key). */
function safeLocation(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.slice(0, 160);
  } catch {
    return null;
  }
}

function safeError(value: unknown): string | null {
  return typeof value === "string" && value ? redactSensitiveText(value).replace(/https?:\/\/\S+/g, (u) => safeLocation(u) ?? "[url]").slice(0, 200) : null;
}

async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await (await rcPool()).query(sql, params)).rows as Record<string, unknown>[];
}

router.get("/release-c/status", async (req, res) => {
  if (!adminReadAllowed(req)) return res.status(401).json({ error: "Administrative read authorization is required." });
  try {
    await ensureReleaseCSchema();
    const [docsByStatus, retrieval, jobs, recentDocs, sections, versions, queue, queueDue, queueErrors, decisions, usage, coverage, audit, remoteJobs, checkpoints] =
      await Promise.all([
        rows(`SELECT extraction_status, coalesce(extraction_method, '') AS method, count(*)::int AS documents,
                     coalesce(sum(page_count), 0)::int AS pages, coalesce(sum(extracted_page_count), 0)::int AS extracted_pages
              FROM opportunity_documents WHERE superseded_by IS NULL GROUP BY 1, 2 ORDER BY 3 DESC`),
        rows(`SELECT retrieval_status, count(*)::int AS n FROM opportunity_documents WHERE superseded_by IS NULL GROUP BY 1`),
        rows(`SELECT status, count(*)::int AS n, max(attempts)::int AS max_attempts FROM document_extraction_jobs GROUP BY 1`),
        rows(`SELECT id, opportunity_key, source_url, document_role, content_type, byte_size, page_count, extracted_page_count,
                     retrieval_status, retrieval_error, extraction_status, extraction_method, extraction_provider, extraction_account,
                     extraction_quality, sha256 IS NOT NULL AS hashed, superseded_by IS NOT NULL AS superseded, last_checked_at, updated_at
              FROM opportunity_documents ORDER BY updated_at DESC LIMIT 25`),
        rows(`SELECT count(*)::int AS sections, coalesce(sum(char_count), 0)::bigint AS chars,
                     count(*) FILTER (WHERE page_start IS NOT NULL)::int AS with_page
              FROM opportunity_document_sections`),
        rows(`SELECT count(*) FILTER (WHERE superseded_by IS NOT NULL)::int AS superseded_versions,
                     count(DISTINCT sha256)::int AS distinct_hashes, count(*)::int AS total
              FROM opportunity_documents`),
        rows(`SELECT status, count(*)::int AS n, coalesce(sum(attempts), 0)::int AS attempts FROM opportunity_review_queue GROUP BY 1`),
        rows(`SELECT count(*) FILTER (WHERE next_attempt_at <= now())::int AS due_now,
                     count(*) FILTER (WHERE next_attempt_at > now())::int AS deferred,
                     extract(epoch from (now() - min(enqueued_at))) / 3600 AS oldest_hours
              FROM opportunity_review_queue WHERE status = 'queued'`),
        rows(`SELECT last_error, count(*)::int AS n FROM opportunity_review_queue WHERE last_error IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
        rows(`SELECT status, coalesce(decision->>'kind', '') AS kind, coalesce(decision->>'method', '') AS method, count(*)::int AS n
              FROM opportunity_review_queue WHERE decided_at > now() - interval '7 days' GROUP BY 1, 2, 3 ORDER BY 4 DESC`),
        rows(`SELECT pool, slot, provider, model_family, allowance_kind, unit, quota_limit, quota_remaining, used_today, used_month,
                     used_total, requests_total, reset_at, reset_source, exhausted, exhausted_reason, needs_confirmation,
                     cooldown_until, last_outcome, successes, failures, last_confirmed_at, updated_at
              FROM provider_account_usage ORDER BY pool, slot`),
        rows(`SELECT provider, count(*)::int AS events, coalesce(sum(returned), 0)::int AS returned, coalesce(sum(matched), 0)::int AS matched,
                     coalesce(sum(excluded), 0)::int AS excluded, coalesce(sum(staged), 0)::int AS staged,
                     count(*) FILTER (WHERE error IS NOT NULL)::int AS errors
              FROM opportunity_coverage_events WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`),
        rows(`SELECT event, count(*)::int AS n, max(created_at) AS last_at FROM opportunity_audit_log
              WHERE created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC`),
        rows(`SELECT provider, account_slot, count(*)::int AS pending, coalesce(sum(planned_units), 0)::float AS planned_units
              FROM remote_extraction_jobs GROUP BY 1, 2`),
        rows(`SELECT source, query_key, next_offset, total_records, complete, last_error, updated_at
              FROM source_query_checkpoints ORDER BY updated_at DESC LIMIT 40`),
      ]);
    const due = queueDue[0] ?? {};
    return res.json({
      generatedAt: new Date().toISOString(),
      revision: process.env.RENDER_GIT_COMMIT ?? null,
      flags: releaseCFlags(),
      documentWorker: documentWorkerState(),
      documents: {
        byStatus: docsByStatus,
        retrieval,
        sections: sections[0] ?? null,
        versions: versions[0] ?? null,
        recent: recentDocs.map((d) => ({ ...d, source_url: safeLocation(d.source_url), retrieval_error: safeError(d.retrieval_error) })),
      },
      extractionJobs: jobs,
      remoteJobsPending: remoteJobs,
      reviewQueue: {
        byStatus: queue,
        dueNow: Number(due.due_now ?? 0),
        deferred: Number(due.deferred ?? 0),
        oldestQueuedHours: due.oldest_hours == null ? null : Math.round(Number(due.oldest_hours) * 10) / 10,
        errors: queueErrors.map((e) => ({ error: safeError(e.last_error), n: e.n })),
        decidedLast7Days: decisions,
      },
      accountUsage: usage,
      coverageLast24h: coverage,
      reviewMode: reviewMode(),
      // Per-query paging state: complete queries, and ones resuming from an offset next run.
      sourceCheckpoints: checkpoints.map((c) => ({ ...c, last_error: safeError(c.last_error) })),
      auditLast7Days: audit,
    });
  } catch (error) {
    return res.status(503).json({ error: safeError(error instanceof Error ? error.message : String(error)) });
  }
});

router.get("/release-c/credentials", async (req, res) => {
  if (!adminReadAllowed(req)) return res.status(401).json({ error: "Administrative read authorization is required." });
  const age = probeCache ? Date.now() - probeCache.at : Number.POSITIVE_INFINITY;
  if (probeCache && (age < PROBE_MIN_INTERVAL_MS || (age < PROBE_CACHE_MS && req.query.refresh !== "1"))) {
    return res.json({ cached: true, ...(probeCache.value as object) });
  }
  probeInFlight ??= probeCredentials().finally(() => {
    probeInFlight = null;
  });
  try {
    return res.json({ cached: false, ...((await probeInFlight) as object) });
  } catch (error) {
    return res.status(503).json({ error: safeError(error instanceof Error ? error.message : String(error)) });
  }
});

async function probeCredentials(): Promise<unknown> {
  const { extractionCredentialPools, nutrientAccountInfo } = await import("../lib/documents/remoteExtractors");
  const { linkupCredentialPool } = await import("../lib/providers/linkup");
  const pools = extractionCredentialPools();
  const nutrientDetails: Record<string, unknown> = {};
  const [llmwhisperer, nutrient, linkup] = await Promise.all([
    pools.llmwhisperer.probeSlots(),
    pools.nutrient.probeSlots(async (apiKey, slot) => {
      const info = await nutrientAccountInfo(apiKey);
      nutrientDetails[slot] = { plan: info.plan, credits: info.credits };
      return info;
    }),
    linkupCredentialPool().probeSlots(),
  ]);
  const value = {
    checkedAt: new Date().toISOString(),
    llmwhisperer,
    nutrient: nutrient.map((slot) => ({ ...slot, account: nutrientDetails[slot.slot] ?? null })),
    linkup,
  };
  probeCache = { at: Date.now(), value };
  return value;
}

router.post("/release-c/extraction-selftest", async (req, res) => {
  if (!adminReadAllowed(req)) return res.status(401).json({ error: "Administrative read authorization is required." });
  try {
    const result = await startSelftest();
    if ("refused" in result) return res.status(result.status).json({ error: result.refused });
    return res.status(202).json(result.started);
  } catch (error) {
    return res.status(503).json({ error: safeError(error instanceof Error ? error.message : String(error)) });
  }
});

router.get("/release-c/extraction-selftest/:id", (req, res) => {
  if (!adminReadAllowed(req)) return res.status(401).json({ error: "Administrative read authorization is required." });
  const run = selftestRun(req.params.id);
  return run ? res.json(run) : res.status(404).json({ error: "Unknown self-test run." });
});

router.get("/release-c/selftest-fixture/:run/:name", (req, res) => {
  const fixture = selftestFixture(req.params.run, req.params.name);
  if (!fixture) return res.status(404).end();
  res.setHeader("Content-Type", fixture.contentType);
  res.setHeader("Cache-Control", "no-store");
  return res.send(typeof fixture.body === "string" ? fixture.body : Buffer.from(fixture.body));
});

export default router;
