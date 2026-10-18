/**
 * Per-source, per-query continuation checkpoints. A source query whose pages did not all fit in one run stores where
 * it stopped (and the date window it was searching), and the next run resumes there. Completed queries are recorded
 * too, so coverage shows which partitions were fully read.
 *
 * Best-effort: a database problem means the query starts from offset 0, the behaviour before checkpoints existed.
 */
import { rcPool } from "./db";
import { ensureReleaseCSchema } from "./schema";

export interface QueryCheckpoint {
  source: string;
  queryKey: string;
  nextOffset: number;
  totalRecords: number | null;
  windowFrom: string | null;
  windowTo: string | null;
  complete: boolean;
  lastError: string | null;
  updatedAt: string;
}

/** A partial checkpoint older than this is abandoned: its window has drifted too far from the current one. */
export const CHECKPOINT_MAX_AGE_MS = 3 * 24 * 3_600_000;

export async function loadQueryCheckpoint(source: string, queryKey: string): Promise<QueryCheckpoint | null> {
  try {
    await ensureReleaseCSchema();
    const result = await (await rcPool()).query(
      `SELECT source, query_key, next_offset, total_records, window_from, window_to, complete, last_error, updated_at
       FROM source_query_checkpoints WHERE source = $1 AND query_key = $2`,
      [source, queryKey.slice(0, 500)],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      source: String(row.source),
      queryKey: String(row.query_key),
      nextOffset: Number(row.next_offset ?? 0),
      totalRecords: row.total_records == null ? null : Number(row.total_records),
      windowFrom: (row.window_from as string | null) ?? null,
      windowTo: (row.window_to as string | null) ?? null,
      complete: Boolean(row.complete),
      lastError: (row.last_error as string | null) ?? null,
      updatedAt: new Date(row.updated_at as string).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function saveQueryCheckpoint(checkpoint: Omit<QueryCheckpoint, "updatedAt">): Promise<void> {
  try {
    await ensureReleaseCSchema();
    await (await rcPool()).query(
      `INSERT INTO source_query_checkpoints (source, query_key, next_offset, total_records, window_from, window_to, complete, last_error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (source, query_key) DO UPDATE SET next_offset = EXCLUDED.next_offset, total_records = EXCLUDED.total_records,
         window_from = EXCLUDED.window_from, window_to = EXCLUDED.window_to, complete = EXCLUDED.complete,
         last_error = EXCLUDED.last_error, updated_at = now()`,
      [
        checkpoint.source,
        checkpoint.queryKey.slice(0, 500),
        checkpoint.nextOffset,
        checkpoint.totalRecords,
        checkpoint.windowFrom,
        checkpoint.windowTo,
        checkpoint.complete,
        checkpoint.lastError?.slice(0, 300) ?? null,
      ],
    );
  } catch (error) {
    console.warn(JSON.stringify({ event: "source_query_checkpoint_write_failed", source: checkpoint.source, error: error instanceof Error ? error.message : String(error) }));
  }
}

/** Where to start a query: the stored offset and window when an unfinished checkpoint is still fresh, else offset 0. */
export function resumePoint(checkpoint: QueryCheckpoint | null, now = Date.now()): { offset: number; windowFrom: string | null; windowTo: string | null; resumed: boolean } {
  if (
    checkpoint &&
    !checkpoint.complete &&
    checkpoint.nextOffset > 0 &&
    checkpoint.windowFrom &&
    checkpoint.windowTo &&
    now - Date.parse(checkpoint.updatedAt) < CHECKPOINT_MAX_AGE_MS
  ) {
    return { offset: checkpoint.nextOffset, windowFrom: checkpoint.windowFrom, windowTo: checkpoint.windowTo, resumed: true };
  }
  return { offset: 0, windowFrom: null, windowTo: null, resumed: false };
}

export async function checkpointSummary(): Promise<Record<string, unknown>> {
  await ensureReleaseCSchema();
  const result = await (await rcPool()).query(
    `SELECT source, count(*)::int AS queries, count(*) FILTER (WHERE complete)::int AS complete,
            count(*) FILTER (WHERE NOT complete)::int AS resuming, count(last_error)::int AS errored, max(updated_at) AS last_updated
     FROM source_query_checkpoints GROUP BY source ORDER BY source`,
  );
  return { rows: result.rows };
}
