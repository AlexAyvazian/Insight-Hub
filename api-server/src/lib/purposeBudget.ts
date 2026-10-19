/**
 * Separate daily budgets for the four kinds of provider spend in Opportunities Intelligence: search, page
 * extraction, OCR and AI evaluation. One purpose can no longer use up the calls another needs (for example a large
 * discovery run starving the AI evaluator of its share of a shared account).
 *
 *   OPPORTUNITY_BUDGET_<PURPOSE>_DAILY_CALLS   e.g. OPPORTUNITY_BUDGET_PAGE_EXTRACTION_DAILY_CALLS=400
 *
 * Unset means tracked but not capped (account allowances in accountLedger.ts still apply). Counts are kept per UTC
 * day; with durable coordination on they are shared by every worker through provider_purpose_usage (flushed in
 * small batches, so the database sees one write per flush rather than one per call).
 */
import type { SpendPurpose } from "./providers/accountLedger";
import { rcPool } from "./releaseC/db";
import { durableSharedWorkEnabled } from "./releaseC/flags";
import { ensureReleaseCSchema } from "./releaseC/schema";

export const SPEND_PURPOSES: readonly SpendPurpose[] = ["search", "page_extraction", "ocr", "ai_evaluation"];

const POOL_PURPOSES: Record<string, SpendPurpose> = {
  "opportunity-web-discovery": "search",
  "opportunity-page-enrichment": "page_extraction",
  "opportunity-ai-extraction": "ai_evaluation",
  "opportunity-structured-review": "ai_evaluation",
  llmwhisperer: "ocr",
  nutrient: "ocr",
  linkup: "search",
};

export function purposeForPool(poolId: string): SpendPurpose | null {
  return POOL_PURPOSES[poolId] ?? null;
}

export function purposeDailyLimit(purpose: SpendPurpose, env: Record<string, string | undefined> = process.env): number | null {
  const raw = env[`OPPORTUNITY_BUDGET_${purpose.toUpperCase()}_DAILY_CALLS`];
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

interface Counter {
  day: string;
  /** Calls already in the durable row when it was last read. */
  durableCalls: number;
  durableFailures: number;
  loadedAt: number;
  /** Calls and failures in this process not yet flushed. */
  pendingCalls: number;
  pendingFailures: number;
  /** Calls and failures this process counted today (flushed or not), for telemetry. */
  localCalls: number;
  localFailures: number;
}

const counters = new Map<SpendPurpose, Counter>();
const RELOAD_MS = 30_000;
const FLUSH_MS = 30_000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const today = (now = new Date()) => now.toISOString().slice(0, 10);

function counter(purpose: SpendPurpose, now = new Date()): Counter {
  const day = today(now);
  const existing = counters.get(purpose);
  if (existing && existing.day === day) return existing;
  const fresh: Counter = { day, durableCalls: 0, durableFailures: 0, loadedAt: 0, pendingCalls: 0, pendingFailures: 0, localCalls: 0, localFailures: 0 };
  counters.set(purpose, fresh);
  return fresh;
}

async function refresh(purpose: SpendPurpose, entry: Counter): Promise<void> {
  if (!durableSharedWorkEnabled() || Date.now() - entry.loadedAt < RELOAD_MS) return;
  try {
    await ensureReleaseCSchema();
    const result = await (await rcPool()).query(
      `SELECT calls, failures FROM provider_purpose_usage WHERE purpose = $1 AND day_key = $2`,
      [purpose, entry.day],
    );
    const row = result.rows[0] as { calls?: number; failures?: number } | undefined;
    entry.durableCalls = Number(row?.calls ?? 0);
    entry.durableFailures = Number(row?.failures ?? 0);
    entry.loadedAt = Date.now();
  } catch {
    // Unreadable: the local count still applies.
  }
}

function used(entry: Counter): number {
  return durableSharedWorkEnabled() ? entry.durableCalls + entry.pendingCalls : entry.localCalls;
}

export interface PurposeDecision {
  ok: boolean;
  purpose: SpendPurpose;
  used: number;
  limit: number | null;
  reason: string;
}

export async function purposeAllows(purpose: SpendPurpose, calls = 1): Promise<PurposeDecision> {
  const entry = counter(purpose);
  const limit = purposeDailyLimit(purpose);
  if (limit == null) return { ok: true, purpose, used: used(entry), limit, reason: "no daily cap configured" };
  await refresh(purpose, entry);
  const spent = used(entry);
  return spent + calls > limit
    ? { ok: false, purpose, used: spent, limit, reason: `${purpose} budget for today is used (${spent}/${limit} calls)` }
    : { ok: true, purpose, used: spent, limit, reason: "within daily budget" };
}

export function recordPurposeCall(purpose: SpendPurpose, outcome: "success" | "failure"): void {
  const entry = counter(purpose);
  entry.localCalls += 1;
  entry.pendingCalls += 1;
  if (outcome === "failure") {
    entry.localFailures += 1;
    entry.pendingFailures += 1;
  }
  if (durableSharedWorkEnabled() && !flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushPurposeUsage();
    }, FLUSH_MS);
    flushTimer.unref?.();
  } else if (!durableSharedWorkEnabled()) {
    entry.pendingCalls = 0;
    entry.pendingFailures = 0;
  }
}

/** Writes pending counts in one statement. Counts that cannot be written stay pending for the next flush. */
export async function flushPurposeUsage(): Promise<void> {
  const rows = [...counters.entries()]
    .filter(([, entry]) => entry.pendingCalls > 0 || entry.pendingFailures > 0)
    .map(([purpose, entry]) => ({ purpose, entry, calls: entry.pendingCalls, failures: entry.pendingFailures }));
  if (rows.length === 0 || !durableSharedWorkEnabled()) return;
  try {
    await ensureReleaseCSchema();
    await (await rcPool()).query(
      `INSERT INTO provider_purpose_usage (purpose, day_key, calls, failures, updated_at)
       SELECT r.purpose, r.day_key, r.calls, r.failures, now()
         FROM jsonb_to_recordset($1::jsonb) AS r(purpose text, day_key text, calls integer, failures integer)
       ON CONFLICT (purpose, day_key) DO UPDATE SET calls = provider_purpose_usage.calls + EXCLUDED.calls,
         failures = provider_purpose_usage.failures + EXCLUDED.failures, updated_at = now()`,
      [JSON.stringify(rows.map((row) => ({ purpose: row.purpose, day_key: row.entry.day, calls: row.calls, failures: row.failures })))],
    );
    for (const row of rows) {
      row.entry.pendingCalls -= row.calls;
      row.entry.pendingFailures -= row.failures;
      row.entry.durableCalls += row.calls;
      row.entry.durableFailures += row.failures;
    }
  } catch {
    // Kept pending.
  }
}

export interface PurposeBudgetSnapshot {
  purpose: SpendPurpose;
  day: string;
  calls: number;
  failures: number;
  limit: number | null;
  remaining: number | null;
  durable: boolean;
}

export async function purposeBudgetSnapshot(): Promise<PurposeBudgetSnapshot[]> {
  return Promise.all(
    SPEND_PURPOSES.map(async (purpose) => {
      const entry = counter(purpose);
      await refresh(purpose, entry);
      const limit = purposeDailyLimit(purpose);
      const calls = used(entry);
      const durable = durableSharedWorkEnabled();
      return {
        purpose,
        day: entry.day,
        calls,
        failures: durable ? entry.durableFailures + entry.pendingFailures : entry.localFailures,
        limit,
        remaining: limit == null ? null : Math.max(0, limit - calls),
        durable,
      };
    }),
  );
}

export function clearPurposeBudgetsForTests(): void {
  counters.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}
