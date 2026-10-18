/**
 * Search coverage tracking for Opportunities: what each provider query returned, how much matched, how much was
 * excluded by the query partition (and why), and errors. Builds on the Release B query rotation: the service
 * family a query belongs to is recorded so coverage gaps per family are visible.
 *
 * Writes are best-effort and batched; a database problem never fails an ingestion run.
 */
import { randomUUID } from "node:crypto";
import { rcPool } from "./db";
import type { NormalizedOpportunity } from "../providers/types";
import { ensureReleaseCSchema } from "./schema";

export interface CoverageEvent {
  runId?: string | null;
  provider: string;
  serviceFamily?: string | null;
  query?: string | null;
  page?: number | null;
  returned: number;
  matched: number;
  excluded: number;
  staged?: number;
  error?: string | null;
  details?: Record<string, unknown>;
}

export async function recordCoverage(events: CoverageEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await ensureReleaseCSchema();
    for (const event of events) {
      await (await rcPool()).query(
        `INSERT INTO opportunity_coverage_events (id, run_id, provider, service_family, query, page, returned, matched, excluded, staged, error, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          event.runId ?? null,
          event.provider,
          event.serviceFamily ?? null,
          event.query?.slice(0, 1000) ?? null,
          event.page ?? null,
          event.returned,
          event.matched,
          event.excluded,
          event.staged ?? 0,
          event.error?.slice(0, 500) ?? null,
          JSON.stringify(event.details ?? {}),
        ],
      );
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "opportunity_coverage_write_failed", error: error instanceof Error ? error.message : String(error) }));
  }
}

/** Short excluded-record samples for the coverage audit (title and id only). */
export function exclusionSamples(records: NormalizedOpportunity[], limit = 5): Array<{ id: string; title: string }> {
  return records.slice(0, limit).map((record) => ({ id: record.externalId ?? "", title: (record.title ?? "").slice(0, 160) }));
}

export async function coverageSummary(sinceHours = 24 * 7): Promise<Record<string, unknown>> {
  await ensureReleaseCSchema();
  const result = await (await rcPool()).query(
    `SELECT provider, coalesce(service_family, 'unassigned') AS family, count(*)::int AS queries,
            sum(returned)::int AS returned, sum(matched)::int AS matched, sum(excluded)::int AS excluded,
            sum(staged)::int AS staged, count(error)::int AS errors, max(created_at) AS last_seen
     FROM opportunity_coverage_events WHERE created_at > now() - make_interval(hours => $1)
     GROUP BY provider, family ORDER BY provider, family`,
    [sinceHours],
  );
  return { sinceHours, rows: result.rows };
}
