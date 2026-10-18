/**
 * Persistent AI review queue for Opportunities.
 *
 * Replaces the fixed per-run ceilings (3 / max 5 in structuredOpportunityDecision, 10 / max 30 in
 * structuredOpportunityJudge). Every ambiguous record is retained here with its full snapshot and a priority; each
 * run reviews as many as the currently available free AI capacity allows (adaptive, see capacity.ts), and the rest
 * wait — they are never dropped and resume automatically when capacity returns.
 *
 * Priority: urgent deadlines first, then records whose purchased scope is uncertain but plausibly relevant
 * (review band, close to the accept threshold), then everything else. Expired records leave the queue.
 */
import { randomUUID } from "node:crypto";
import { rcPool } from "./db";
import type { NormalizedOpportunity } from "../providers/types";
import { ensureReleaseCSchema } from "./schema";

export type QueueStatus = "queued" | "in_review" | "decided" | "held" | "expired";

export interface QueueItem {
  id: string;
  opportunityKey: string;
  provider: string;
  record: NormalizedOpportunity;
  contentHash: string;
  profileVersion: string | null;
  priority: number;
  status: QueueStatus;
  holdCode: string | null;
  reason: string | null;
  attempts: number;
  decision: Record<string, unknown> | null;
}

/** Deadline urgency (0-60) + scope uncertainty near the accept line (0-30) + provider authority (0-10). */
export function reviewPriority(
  record: NormalizedOpportunity,
  classifierScore: number,
  thresholds: { reviewMin: number; acceptMin: number },
  now = Date.now(),
): number {
  const deadline = record.responseDeadline instanceof Date ? record.responseDeadline.getTime() : Number.NaN;
  let urgency = 15; // unknown deadline: middle of the pack, never last
  if (Number.isFinite(deadline)) {
    const days = (deadline - now) / 86_400_000;
    if (days < 0) return -1;
    urgency = days <= 3 ? 60 : days <= 7 ? 50 : days <= 14 ? 40 : days <= 30 ? 28 : days <= 60 ? 18 : 10;
  }
  const span = Math.max(1, thresholds.acceptMin - thresholds.reviewMin);
  const closeness = Math.max(0, Math.min(1, (classifierScore - thresholds.reviewMin) / span));
  const uncertainty = classifierScore >= thresholds.acceptMin ? 22 : 8 + closeness * 22;
  const authority = /sam|tango|structured|official/i.test(String(record.source ?? "")) ? 10 : 5;
  return Math.round((urgency + uncertainty + authority) * 100) / 100;
}

/** JSON round-trip that restores Date fields of a NormalizedOpportunity snapshot. */
export function reviveRecord(value: unknown): NormalizedOpportunity {
  const record = value as Record<string, unknown>;
  for (const key of ["postedDate", "responseDeadline", "archiveDate"]) {
    if (typeof record[key] === "string") record[key] = new Date(record[key] as string);
  }
  return record as unknown as NormalizedOpportunity;
}

function toItem(row: Record<string, unknown>): QueueItem {
  return {
    id: String(row.id),
    opportunityKey: String(row.opportunity_key),
    provider: String(row.provider),
    record: reviveRecord(row.record),
    contentHash: String(row.content_hash),
    profileVersion: (row.profile_version as string | null) ?? null,
    priority: Number(row.priority),
    status: row.status as QueueStatus,
    holdCode: (row.hold_code as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    attempts: Number(row.attempts),
    decision: (row.decision as Record<string, unknown> | null) ?? null,
  };
}

export interface EnqueueInput {
  opportunityKey: string;
  provider: string;
  record: NormalizedOpportunity;
  contentHash: string;
  profileVersion: string | null;
  priority: number;
  holdCode: string;
  reason: string;
  /**
   * The content hash the caller started from (the review-queue drain passes the hash it claimed). When the row has
   * meanwhile moved to a different version, this write is stale and is skipped.
   */
  expectedHash?: string;
}

/**
 * Upserts a record into the queue. An unchanged record keeps its decision; a changed content hash (new text,
 * attachment, amendment, deadline or profile version) reopens it as queued, keeping the previous decision in the
 * audit log rather than silently overwriting it.
 */
export async function enqueueForReview(items: EnqueueInput[]): Promise<{ queued: number; reopened: number; unchanged: number }> {
  if (items.length === 0) return { queued: 0, reopened: 0, unchanged: 0 };
  await ensureReleaseCSchema();
  let queued = 0;
  let reopened = 0;
  let unchanged = 0;
  for (const item of items) {
    const existing = await (await rcPool()).query(
      `SELECT id, content_hash, status, decision FROM opportunity_review_queue WHERE opportunity_key = $1`,
      [item.opportunityKey],
    );
    const row = existing.rows[0] as { id: string; content_hash: string; status: string; decision: unknown } | undefined;
    if (!row) {
      await (await rcPool()).query(
        `INSERT INTO opportunity_review_queue (id, opportunity_key, provider, record, content_hash, profile_version, priority, status, hold_code, reason, response_deadline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10) ON CONFLICT (opportunity_key) DO NOTHING`,
        [randomUUID(), item.opportunityKey, item.provider, JSON.stringify(item.record), item.contentHash, item.profileVersion, item.priority, item.holdCode, item.reason.slice(0, 500), item.record.responseDeadline ?? null],
      );
      queued += 1;
      continue;
    }
    if (item.expectedHash && row.content_hash !== item.expectedHash && row.content_hash !== item.contentHash) {
      // A newer version reached the queue while this one was being reviewed; it is never overwritten.
      unchanged += 1;
      continue;
    }
    if (row.content_hash === item.contentHash) {
      await (await rcPool()).query(
        `UPDATE opportunity_review_queue SET priority = $2, updated_at = now() WHERE id = $1`,
        [row.id, item.priority],
      );
      unchanged += 1;
      continue;
    }
    if (row.decision) {
      await (await rcPool()).query(
        `INSERT INTO opportunity_audit_log (id, opportunity_key, event, details) VALUES ($1,$2,'review_reopened',$3)`,
        [randomUUID(), item.opportunityKey, JSON.stringify({ previousHash: row.content_hash, newHash: item.contentHash, previousDecision: row.decision })],
      );
    }
    await (await rcPool()).query(
      `UPDATE opportunity_review_queue SET record = $2, content_hash = $3, profile_version = $4, priority = $5, status = 'queued',
         hold_code = $6, reason = $7, response_deadline = $8, next_attempt_at = now(), decision = NULL, decided_at = NULL, updated_at = now()
       WHERE id = $1`,
      [row.id, JSON.stringify(item.record), item.contentHash, item.profileVersion, item.priority, item.holdCode, item.reason.slice(0, 500), item.record.responseDeadline ?? null],
    );
    reopened += 1;
  }
  return { queued, reopened, unchanged };
}

/** Claims due items in priority order. Expired records are retired first so they never consume capacity. */
export async function claimDueItems(limit: number): Promise<QueueItem[]> {
  if (limit <= 0) return [];
  await ensureReleaseCSchema();
  await (await rcPool()).query(
    `UPDATE opportunity_review_queue SET status = 'expired', updated_at = now()
     WHERE status IN ('queued','held') AND response_deadline IS NOT NULL AND response_deadline < now()`,
  );
  // Items stuck in_review by a crashed run are released after 30 minutes.
  await (await rcPool()).query(
    `UPDATE opportunity_review_queue SET status = 'queued', updated_at = now()
     WHERE status = 'in_review' AND updated_at < now() - interval '30 minutes'`,
  );
  const result = await (await rcPool()).query(
    `UPDATE opportunity_review_queue SET status = 'in_review', attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM opportunity_review_queue
       WHERE status = 'queued' AND next_attempt_at <= now()
       ORDER BY priority DESC, next_attempt_at ASC
       FOR UPDATE SKIP LOCKED LIMIT $1)
     RETURNING *`,
    [limit],
  );
  return result.rows.map((row) => toItem(row as Record<string, unknown>)).sort((a, b) => b.priority - a.priority);
}

export async function completeItem(
  id: string,
  outcome: { status: "decided" | "held" | "queued"; decision?: Record<string, unknown> | null; holdCode?: string | null; reason?: string; retryAt?: Date | null },
  contentHash: string | null = null,
): Promise<void> {
  // With a content hash, a row that has moved on to a newer version is left alone.
  await (await rcPool()).query(
    `UPDATE opportunity_review_queue SET status = $2, decision = coalesce($3, decision), hold_code = coalesce($4, hold_code),
       reason = coalesce($5, reason), next_attempt_at = coalesce($6, next_attempt_at),
       decided_at = CASE WHEN $2 = 'decided' THEN now() ELSE decided_at END, updated_at = now()
     WHERE id = $1 AND ($7::text IS NULL OR content_hash = $7)`,
    [id, outcome.status, outcome.decision ? JSON.stringify(outcome.decision) : null, outcome.holdCode ?? null, outcome.reason?.slice(0, 500) ?? null, outcome.retryAt ?? null, contentHash],
  );
}

/**
 * Closes queue rows for opportunities whose current version was decided outside AI review (deterministic approval
 * or a relevance reject), so a later drain never reviews or promotes the stale snapshot. Rows a drain is reviewing
 * right now (in_review) are closed too: they take the new version's hash, so the drain's result for the old
 * version no longer matches the row and is discarded (see settleByKey, completeItem and the drain's hash check).
 * With expectedHash (the drain's own call), a row that has moved on to another version is left alone.
 */
export async function closeQueuedByKeys(
  entries: Array<{ opportunityKey: string; contentHash: string; expectedHash?: string | null }>,
  decision: Record<string, unknown>,
  reason: string,
): Promise<void> {
  if (entries.length === 0) return;
  // The row takes the current version's hash, so its decision is never mistaken for one about the old snapshot.
  await (await rcPool()).query(
    `UPDATE opportunity_review_queue q SET status = 'decided', content_hash = v.hash, decision = $3, reason = $4,
       decided_at = now(), updated_at = now()
     FROM unnest($1::text[], $2::text[], $5::text[]) AS v(key, hash, expected)
     WHERE q.opportunity_key = v.key AND q.status IN ('queued','held','in_review')
       AND (v.expected IS NULL OR q.content_hash IN (v.expected, v.hash))`,
    [
      entries.map((e) => e.opportunityKey),
      entries.map((e) => e.contentHash),
      JSON.stringify(decision),
      reason.slice(0, 500),
      entries.map((e) => e.expectedHash ?? null),
    ],
  );
}

/** Reopens one opportunity (used when new document evidence arrives). */
export async function reopenOpportunity(opportunityKey: string, reason: string): Promise<void> {
  await ensureReleaseCSchema();
  await (await rcPool()).query(
    `UPDATE opportunity_review_queue SET status = 'queued', next_attempt_at = now(), reason = $2, updated_at = now()
     WHERE opportunity_key = $1 AND status IN ('held','decided','queued')`,
    [opportunityKey, reason.slice(0, 500)],
  );
}

export async function reviewQueueStats(): Promise<{ byStatus: Record<string, number>; dueNow: number; oldestQueuedHours: number | null }> {
  await ensureReleaseCSchema();
  const counts = await (await rcPool()).query(`SELECT status, count(*)::int AS n FROM opportunity_review_queue GROUP BY status`);
  const due = await (await rcPool()).query(
    `SELECT count(*)::int AS n, extract(epoch from (now() - min(enqueued_at))) / 3600 AS oldest
     FROM opportunity_review_queue WHERE status = 'queued' AND next_attempt_at <= now()`,
  );
  return {
    byStatus: Object.fromEntries(counts.rows.map((row) => [String(row.status), Number(row.n)])),
    dueNow: Number(due.rows[0]?.n ?? 0),
    oldestQueuedHours: due.rows[0]?.oldest == null ? null : Math.round(Number(due.rows[0].oldest) * 10) / 10,
  };
}

export interface CachedQueueDecision {
  opportunityKey: string;
  contentHash: string;
  status: QueueStatus;
  holdCode: string | null;
  decision: Record<string, unknown> | null;
}

/** Current queue rows for these opportunities, used to reuse a decision whose content hash is unchanged. */
export async function cachedQueueDecisions(keys: string[]): Promise<Map<string, CachedQueueDecision>> {
  const out = new Map<string, CachedQueueDecision>();
  if (keys.length === 0) return out;
  await ensureReleaseCSchema();
  const result = await (await rcPool()).query(
    `SELECT opportunity_key, content_hash, status, hold_code, decision FROM opportunity_review_queue WHERE opportunity_key = ANY($1::text[])`,
    [keys],
  );
  for (const row of result.rows) {
    out.set(String(row.opportunity_key), {
      opportunityKey: String(row.opportunity_key),
      contentHash: String(row.content_hash),
      status: row.status as QueueStatus,
      holdCode: (row.hold_code as string | null) ?? null,
      decision: (row.decision as Record<string, unknown> | null) ?? null,
    });
  }
  return out;
}

/** Sets the outcome for one opportunity's current content version (no-op if the content changed meanwhile). */
export async function settleByKey(
  opportunityKey: string,
  contentHash: string,
  outcome: { status: QueueStatus; decision?: Record<string, unknown> | null; holdCode?: string | null; reason?: string; retryAt?: Date | null; error?: string | null },
): Promise<void> {
  await (await rcPool()).query(
    `UPDATE opportunity_review_queue SET status = $3, decision = coalesce($4, decision), hold_code = coalesce($5, hold_code),
       reason = coalesce($6, reason), next_attempt_at = coalesce($7, next_attempt_at), last_error = $8,
       decided_at = CASE WHEN $3 = 'decided' THEN now() ELSE decided_at END, updated_at = now()
     WHERE opportunity_key = $1 AND content_hash = $2`,
    [
      opportunityKey,
      contentHash,
      outcome.status,
      outcome.decision ? JSON.stringify(outcome.decision) : null,
      outcome.holdCode ?? null,
      outcome.reason?.slice(0, 500) ?? null,
      outcome.retryAt ?? null,
      outcome.error?.slice(0, 500) ?? null,
    ],
  );
}
