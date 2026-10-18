/**
 * Per-account quota accounting for independently permitted free-tier accounts.
 *
 * Each credential slot is tracked separately: its allowance kind (recurring daily/monthly allowance, one-time
 * trial credit, or a temporary rate limit), the unit it is metered in (requests, pages, credits, tokens), real
 * usage, the provider-reported remaining capacity and reset time, cooldowns and success/quality statistics.
 *
 * Rules that matter:
 * - An exhausted account receives no further requests until its capacity is confirmed: by a free probe
 *   (usage/balance endpoint) when the provider has one, or — for recurring allowances without a probe — only after
 *   the documented reset has passed.
 * - One-time trial credits never "renew tomorrow": an exhausted trial stays exhausted until a probe shows credit.
 * - A rate limit is a cooldown, not exhaustion: it clears at the provider's reset time or Retry-After.
 * - A usage cap below the provider's free allowance (safety margin) stops spending before any paid overage.
 */
import { rcPool } from "../releaseC/db";
import { ensureReleaseCSchema } from "../releaseC/schema";

export type AllowanceKind =
  | "recurring_daily"
  | "recurring_monthly"
  | "one_time_trial"
  | "rate_limited"
  | "unknown";

export type UsageUnit = "requests" | "pages" | "credits" | "tokens";

export interface AccountPolicy {
  pool: string;
  slot: string;
  provider: string;
  /** Underlying model family (AI providers). Two accounts on one family are never independent judges. */
  modelFamily?: string | null;
  allowanceKind: AllowanceKind;
  unit: UsageUnit;
  /** Free allowance per period in `unit` (null when unknown; then only provider-reported capacity is used). */
  periodLimit: number | null;
  /** Never plan to spend beyond this fraction of the allowance (default 0.9) so a paid overage is impossible. */
  safetyFraction?: number;
  /** Whether the provider can bill beyond the free allowance (true => hard stop at the cap, never "try and see"). */
  overageBillable?: boolean;
}

export interface QuotaSnapshot {
  limit?: number | null;
  remaining?: number | null;
  usedToday?: number | null;
  usedMonth?: number | null;
  resetAt?: Date | null;
  source: string;
}

export interface AccountState {
  id: string;
  pool: string;
  slot: string;
  provider: string;
  modelFamily: string | null;
  allowanceKind: AllowanceKind;
  unit: UsageUnit;
  quotaLimit: number | null;
  quotaRemaining: number | null;
  usedToday: number;
  usedMonth: number;
  usedTotal: number;
  requestsTotal: number;
  dayKey: string;
  monthKey: string;
  resetAt: string | null;
  resetSource: string | null;
  exhausted: boolean;
  exhaustedReason: string | null;
  needsConfirmation: boolean;
  cooldownUntil: string | null;
  lastOutcome: string | null;
  successes: number;
  failures: number;
  qualityGood: number;
  qualityPoor: number;
  lastConfirmedAt: string | null;
  updatedAt: string;
}

export interface SpendDecision {
  ok: boolean;
  reason: string;
  retryAt: string | null;
  /** True when the account is blocked only until a probe confirms capacity. */
  needsProbe: boolean;
  remaining: number | null;
}

export interface LedgerStoreIO {
  load(id: string): Promise<AccountState | null>;
  save(state: AccountState): Promise<void>;
}

export interface LedgerStore extends LedgerStoreIO {
  list(pool?: string): Promise<AccountState[]>;
  /** Runs one read-modify-write for an account so concurrent processes cannot lose each other's updates. */
  atomic?<T>(id: string, work: (io: LedgerStoreIO) => Promise<T>): Promise<T>;
}

const dayKey = (now: Date) => now.toISOString().slice(0, 10);
const monthKey = (now: Date) => now.toISOString().slice(0, 7);

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function nextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function accountId(pool: string, slot: string): string {
  return `${pool}:${slot}`;
}

function blank(policy: AccountPolicy, now: Date): AccountState {
  return {
    id: accountId(policy.pool, policy.slot),
    pool: policy.pool,
    slot: policy.slot,
    provider: policy.provider,
    modelFamily: policy.modelFamily ?? null,
    allowanceKind: policy.allowanceKind,
    unit: policy.unit,
    quotaLimit: policy.periodLimit,
    quotaRemaining: null,
    usedToday: 0,
    usedMonth: 0,
    usedTotal: 0,
    requestsTotal: 0,
    dayKey: dayKey(now),
    monthKey: monthKey(now),
    resetAt: null,
    resetSource: null,
    exhausted: false,
    exhaustedReason: null,
    needsConfirmation: false,
    cooldownUntil: null,
    lastOutcome: null,
    successes: 0,
    failures: 0,
    qualityGood: 0,
    qualityPoor: 0,
    lastConfirmedAt: null,
    updatedAt: now.toISOString(),
  };
}

/** Rolls usage windows forward. Exhaustion is never cleared here: a reset only makes the account probe-eligible. */
export function rollWindows(state: AccountState, now: Date): AccountState {
  const next = { ...state };
  const today = dayKey(now);
  const month = monthKey(now);
  const resetPassed = Boolean(next.resetAt && Date.parse(next.resetAt) <= now.getTime());
  if (next.dayKey !== today) {
    next.usedToday = 0;
    next.dayKey = today;
    if (next.allowanceKind === "recurring_daily" && next.exhausted) next.needsConfirmation = true;
  }
  if (next.monthKey !== month) {
    next.usedMonth = 0;
    next.monthKey = month;
    if (next.allowanceKind === "recurring_monthly" && next.exhausted) next.needsConfirmation = true;
  }
  if (resetPassed && next.exhausted && next.allowanceKind !== "one_time_trial") next.needsConfirmation = true;
  if (next.cooldownUntil && Date.parse(next.cooldownUntil) <= now.getTime()) next.cooldownUntil = null;
  return next;
}

function cap(policy: AccountPolicy, state: AccountState): number | null {
  const limit = state.quotaLimit ?? policy.periodLimit;
  if (limit == null || limit < 0) return null;
  return Math.floor(limit * (policy.safetyFraction ?? 0.9));
}

function periodUsed(policy: AccountPolicy, state: AccountState): number {
  return policy.allowanceKind === "recurring_monthly" ? state.usedMonth : policy.allowanceKind === "recurring_daily" ? state.usedToday : state.usedTotal;
}

/** Pure spend rule, unit tested directly. */
export function decideSpend(
  policy: AccountPolicy,
  state: AccountState,
  units: number,
  now: Date,
  hasProbe: boolean,
): SpendDecision {
  const s = rollWindows(state, now);
  if (s.cooldownUntil && Date.parse(s.cooldownUntil) > now.getTime()) {
    return { ok: false, reason: `cooling down (${s.lastOutcome ?? "rate limit"})`, retryAt: s.cooldownUntil, needsProbe: false, remaining: s.quotaRemaining };
  }
  if (s.exhausted) {
    if (s.allowanceKind === "one_time_trial") {
      return hasProbe
        ? { ok: false, reason: "trial credit exhausted; only a balance probe can re-enable it", retryAt: null, needsProbe: true, remaining: 0 }
        : { ok: false, reason: "trial credit exhausted; one-time credits do not renew", retryAt: null, needsProbe: false, remaining: 0 };
    }
    if (!s.needsConfirmation) {
      return { ok: false, reason: `exhausted: ${s.exhaustedReason ?? "quota"}`, retryAt: s.resetAt ?? nextResetGuess(s, now).toISOString(), needsProbe: false, remaining: 0 };
    }
    if (hasProbe) {
      return { ok: false, reason: "allowance may have reset; confirm with usage probe first", retryAt: null, needsProbe: true, remaining: s.quotaRemaining };
    }
    // No probe exists: after the documented reset the next real request is the confirmation. Allow exactly that.
  }
  const limitCap = cap(policy, s);
  if (limitCap != null && periodUsed(policy, s) + units > limitCap) {
    return {
      ok: false,
      reason: `would exceed ${Math.round((policy.safetyFraction ?? 0.9) * 100)}% of the free ${policy.unit} allowance (${periodUsed(policy, s)}+${units} > ${limitCap})`,
      retryAt: nextResetGuess(s, now).toISOString(),
      needsProbe: false,
      remaining: Math.max(0, limitCap - periodUsed(policy, s)),
    };
  }
  if (s.quotaRemaining != null && s.quotaRemaining < units) {
    // Provider-reported capacity is authoritative when present.
    return { ok: false, reason: `provider reports ${s.quotaRemaining} ${policy.unit} remaining`, retryAt: s.resetAt, needsProbe: hasProbe, remaining: s.quotaRemaining };
  }
  return { ok: true, reason: "capacity available", retryAt: null, needsProbe: false, remaining: s.quotaRemaining ?? (limitCap != null ? limitCap - periodUsed(policy, s) : null) };
}

function nextResetGuess(state: AccountState, now: Date): Date {
  if (state.resetAt && Date.parse(state.resetAt) > now.getTime()) return new Date(state.resetAt);
  if (state.allowanceKind === "recurring_monthly") return nextUtcMonth(now);
  return nextUtcMidnight(now);
}

export class MemoryLedgerStore implements LedgerStore {
  private readonly rows = new Map<string, AccountState>();
  async load(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async save(state: AccountState) {
    this.rows.set(state.id, { ...state });
  }
  async list(pool?: string) {
    return [...this.rows.values()].filter((row) => !pool || row.pool === pool).map((row) => ({ ...row }));
  }
}

type Row = Record<string, unknown>;

function fromRow(row: Row): AccountState {
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value == null ? null : String(value));
  const num = (value: unknown) => (value == null ? null : Number(value));
  return {
    id: String(row.id),
    pool: String(row.pool),
    slot: String(row.slot),
    provider: String(row.provider),
    modelFamily: (row.model_family as string | null) ?? null,
    allowanceKind: row.allowance_kind as AllowanceKind,
    unit: row.unit as UsageUnit,
    quotaLimit: num(row.quota_limit),
    quotaRemaining: num(row.quota_remaining),
    usedToday: Number(row.used_today ?? 0),
    usedMonth: Number(row.used_month ?? 0),
    usedTotal: Number(row.used_total ?? 0),
    requestsTotal: Number(row.requests_total ?? 0),
    dayKey: String(row.day_key ?? ""),
    monthKey: String(row.month_key ?? ""),
    resetAt: iso(row.reset_at),
    resetSource: (row.reset_source as string | null) ?? null,
    exhausted: Boolean(row.exhausted),
    exhaustedReason: (row.exhausted_reason as string | null) ?? null,
    needsConfirmation: Boolean(row.needs_confirmation),
    cooldownUntil: iso(row.cooldown_until),
    lastOutcome: (row.last_outcome as string | null) ?? null,
    successes: Number(row.successes ?? 0),
    failures: Number(row.failures ?? 0),
    qualityGood: Number(row.quality_good ?? 0),
    qualityPoor: Number(row.quality_poor ?? 0),
    lastConfirmedAt: iso(row.last_confirmed_at),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
  };
}

const UPSERT_ACCOUNT_SQL = `INSERT INTO provider_account_usage (id, pool, slot, provider, model_family, allowance_kind, unit, quota_limit,
     quota_remaining, used_today, used_month, used_total, requests_total, day_key, month_key, reset_at, reset_source,
     exhausted, exhausted_reason, needs_confirmation, cooldown_until, last_outcome, successes, failures,
     quality_good, quality_poor, last_confirmed_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,now())
   ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider, model_family=EXCLUDED.model_family,
     allowance_kind=EXCLUDED.allowance_kind, unit=EXCLUDED.unit, quota_limit=EXCLUDED.quota_limit,
     quota_remaining=EXCLUDED.quota_remaining, used_today=EXCLUDED.used_today, used_month=EXCLUDED.used_month,
     used_total=EXCLUDED.used_total, requests_total=EXCLUDED.requests_total, day_key=EXCLUDED.day_key,
     month_key=EXCLUDED.month_key, reset_at=EXCLUDED.reset_at, reset_source=EXCLUDED.reset_source,
     exhausted=EXCLUDED.exhausted, exhausted_reason=EXCLUDED.exhausted_reason,
     needs_confirmation=EXCLUDED.needs_confirmation, cooldown_until=EXCLUDED.cooldown_until,
     last_outcome=EXCLUDED.last_outcome, successes=EXCLUDED.successes, failures=EXCLUDED.failures,
     quality_good=EXCLUDED.quality_good, quality_poor=EXCLUDED.quality_poor,
     last_confirmed_at=EXCLUDED.last_confirmed_at, updated_at=now()`;

function upsertParams(state: AccountState): unknown[] {
  return [
    state.id, state.pool, state.slot, state.provider, state.modelFamily, state.allowanceKind, state.unit,
    state.quotaLimit, state.quotaRemaining, state.usedToday, state.usedMonth, state.usedTotal, state.requestsTotal,
    state.dayKey, state.monthKey, state.resetAt, state.resetSource, state.exhausted, state.exhaustedReason,
    state.needsConfirmation, state.cooldownUntil, state.lastOutcome, state.successes, state.failures,
    state.qualityGood, state.qualityPoor, state.lastConfirmedAt,
  ];
}

export class PostgresLedgerStore implements LedgerStore {
  private readonly fallback = new MemoryLedgerStore();

  async load(id: string): Promise<AccountState | null> {
    try {
      await ensureReleaseCSchema();
      const result = await (await rcPool()).query(`SELECT * FROM provider_account_usage WHERE id = $1`, [id]);
      return result.rows[0] ? fromRow(result.rows[0] as Row) : this.fallback.load(id);
    } catch {
      return this.fallback.load(id);
    }
  }

  async save(state: AccountState): Promise<void> {
    await this.fallback.save(state);
    try {
      await ensureReleaseCSchema();
      await (await rcPool()).query(UPSERT_ACCOUNT_SQL, upsertParams(state));
    } catch {
      // Memory still protects the account in this process if the database is briefly unavailable.
    }
  }

  async atomic<T>(id: string, work: (io: LedgerStoreIO) => Promise<T>): Promise<T> {
    type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>; release: () => void };
    const holder: { client: Client | null } = { client: null };
    try {
      await ensureReleaseCSchema();
      holder.client = (await (await rcPool()).connect()) as unknown as Client;
      await holder.client.query("BEGIN");
      await holder.client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`provider-account:${id}`]);
    } catch {
      if (holder.client) {
        await holder.client.query("ROLLBACK").catch(() => undefined);
        holder.client.release();
      }
      // Database unavailable: the in-process queue still serialises this account.
      return work(this.fallback);
    }
    const tx = holder.client;
    try {
      const result = await work({
        load: async (accountId) => {
          const rows = (await tx.query(`SELECT * FROM provider_account_usage WHERE id = $1`, [accountId])).rows;
          return rows[0] ? fromRow(rows[0]) : this.fallback.load(accountId);
        },
        save: async (state) => {
          await this.fallback.save(state);
          await tx.query(UPSERT_ACCOUNT_SQL, upsertParams(state));
        },
      });
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      tx.release();
    }
  }

  async list(pool?: string): Promise<AccountState[]> {
    try {
      await ensureReleaseCSchema();
      const result = pool
        ? await (await rcPool()).query(`SELECT * FROM provider_account_usage WHERE pool = $1 ORDER BY id`, [pool])
        : await (await rcPool()).query(`SELECT * FROM provider_account_usage ORDER BY id`);
      return result.rows.map((row) => fromRow(row as Row));
    } catch {
      return this.fallback.list(pool);
    }
  }
}

export function isAccountLevelError(message: string): boolean {
  return /\b(408|5\d\d)\b|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(message) && !/abort/i.test(message);
}

/** Thrown by provider adapters when the HTTP response proves a quota or rate-limit condition. */
export class ProviderQuotaError extends Error {
  constructor(
    message: string,
    readonly kind: "rate_limited" | "quota_exhausted" | "trial_exhausted" | "auth",
    readonly resetAt: Date | null = null,
  ) {
    super(message);
    this.name = "ProviderQuotaError";
  }
}

/** Parses Retry-After / x-ratelimit-reset style headers into an absolute time. */
export function resetFromHeaders(headers: Headers, now = Date.now()): Date | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(now + seconds * 1_000);
    const parsed = Date.parse(retryAfter);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  const raw = headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset") ?? headers.get("x-rate-limit-reset");
  if (raw) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1_000 : now + numeric * 1_000);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return null;
}

export class AccountLedger {
  constructor(
    private readonly store: LedgerStore = new PostgresLedgerStore(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly reservations = new Map<string, number>();

  /** Serialises work per account in this process; the store's atomic() also locks across processes. */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tail = next.catch(() => undefined);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return next;
  }

  private mutate(policy: AccountPolicy, change: (state: AccountState, now: Date) => void): Promise<AccountState> {
    const id = accountId(policy.pool, policy.slot);
    return this.serial(id, () => {
      const run = async (io: LedgerStoreIO) => {
        const now = this.clock();
        const state = this.normalise(policy, await io.load(id), now);
        change(state, now);
        state.updatedAt = now.toISOString();
        await io.save(state);
        return state;
      };
      return this.store.atomic ? this.store.atomic(id, run) : run(this.store);
    });
  }

  private normalise(policy: AccountPolicy, loaded: AccountState | null, now: Date): AccountState {
    const base = loaded ?? blank(policy, now);
    return rollWindows(
      {
        ...base,
        provider: policy.provider,
        modelFamily: policy.modelFamily ?? base.modelFamily,
        allowanceKind: policy.allowanceKind,
        unit: policy.unit,
        quotaLimit: base.quotaLimit ?? policy.periodLimit,
      },
      now,
    );
  }

  /** Units planned by in-flight calls in this process count against capacity until they settle. */
  private withReservations(state: AccountState): AccountState {
    const reserved = this.reservations.get(state.id) ?? 0;
    if (reserved <= 0) return state;
    return {
      ...state,
      usedToday: state.usedToday + reserved,
      usedMonth: state.usedMonth + reserved,
      usedTotal: state.usedTotal + reserved,
      quotaRemaining: state.quotaRemaining == null ? null : Math.max(0, state.quotaRemaining - reserved),
    };
  }

  /**
   * Checks capacity and reserves the planned units in one step, so concurrent callers cannot all pass a check that
   * has room for only one of them. release() must be called once the real usage has been recorded.
   */
  async reserve(policy: AccountPolicy, units: number, hasProbe: boolean): Promise<SpendDecision & { release: () => void }> {
    const id = accountId(policy.pool, policy.slot);
    return this.serial(id, async () => {
      const decision = decideSpend(policy, this.withReservations(await this.state(policy)), units, this.clock(), hasProbe);
      if (!decision.ok || units <= 0) return { ...decision, release: () => undefined };
      this.reservations.set(id, (this.reservations.get(id) ?? 0) + units);
      let released = false;
      return {
        ...decision,
        release: () => {
          if (released) return;
          released = true;
          const left = (this.reservations.get(id) ?? 0) - units;
          if (left > 0) this.reservations.set(id, left);
          else this.reservations.delete(id);
        },
      };
    });
  }

  async state(policy: AccountPolicy): Promise<AccountState> {
    const now = this.clock();
    const loaded = await this.store.load(accountId(policy.pool, policy.slot));
    const base = loaded ?? blank(policy, now);
    return rollWindows(
      {
        ...base,
        provider: policy.provider,
        modelFamily: policy.modelFamily ?? base.modelFamily,
        allowanceKind: policy.allowanceKind,
        unit: policy.unit,
        quotaLimit: base.quotaLimit ?? policy.periodLimit,
      },
      now,
    );
  }

  async canSpend(policy: AccountPolicy, units: number, hasProbe: boolean): Promise<SpendDecision> {
    return decideSpend(policy, this.withReservations(await this.state(policy)), units, this.clock(), hasProbe);
  }

  /** Records a provider-reported capacity snapshot (from a free probe or response headers/body). */
  async recordSnapshot(policy: AccountPolicy, snapshot: QuotaSnapshot): Promise<AccountState> {
    return this.mutate(policy, (state, now) => {
      if (snapshot.limit != null && snapshot.limit >= 0) state.quotaLimit = snapshot.limit;
      if (snapshot.usedToday != null && snapshot.usedToday >= 0) state.usedToday = snapshot.usedToday;
      if (snapshot.usedMonth != null && snapshot.usedMonth >= 0) state.usedMonth = snapshot.usedMonth;
      if (snapshot.resetAt) {
        state.resetAt = snapshot.resetAt.toISOString();
        state.resetSource = snapshot.source;
      }
      if (snapshot.remaining != null) state.quotaRemaining = Math.max(0, snapshot.remaining);
      const remaining = state.quotaRemaining;
      const limitCap = cap(policy, state);
      const usedUp = (remaining != null && remaining <= 0) || (limitCap != null && periodUsed(policy, state) >= limitCap);
      state.exhausted = usedUp;
      state.exhaustedReason = usedUp ? `${snapshot.source}: no remaining ${policy.unit}` : null;
      state.needsConfirmation = false;
      state.lastConfirmedAt = now.toISOString();
    });
  }

  async recordUsage(
    policy: AccountPolicy,
    units: number,
    outcome: "success" | "empty" | "failure",
    quality?: "good" | "poor",
  ): Promise<AccountState> {
    return this.mutate(policy, (state, now) => {
      state.usedToday += units;
      state.usedMonth += units;
      state.usedTotal += units;
      state.requestsTotal += 1;
      if (state.quotaRemaining != null) state.quotaRemaining = Math.max(0, state.quotaRemaining - units);
      if (outcome === "failure") state.failures += 1;
      else {
        state.successes += 1;
        // A real successful request after a reset is itself the capacity confirmation.
        if (state.exhausted && state.needsConfirmation) {
          state.exhausted = false;
          state.exhaustedReason = null;
          state.needsConfirmation = false;
          state.lastConfirmedAt = now.toISOString();
        }
      }
      if (quality === "good") state.qualityGood += 1;
      if (quality === "poor") state.qualityPoor += 1;
      state.lastOutcome = outcome;
      const limitCap = cap(policy, state);
      if (limitCap != null && periodUsed(policy, state) >= limitCap) {
        state.exhausted = true;
        state.exhaustedReason = `local cap reached (${periodUsed(policy, state)}/${limitCap} ${policy.unit})`;
        state.needsConfirmation = false;
        state.resetAt = (state.resetAt && Date.parse(state.resetAt) > now.getTime()) ? state.resetAt : nextResetGuess(state, now).toISOString();
        state.resetSource = state.resetSource ?? "documented-period";
      }
    });
  }

  async recordFailure(policy: AccountPolicy, error: unknown): Promise<AccountState> {
    return this.mutate(policy, (state, now) => {
      state.failures += 1;
      state.requestsTotal += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ProviderQuotaError) {
        state.lastOutcome = error.kind;
        if (error.kind === "rate_limited") {
          state.cooldownUntil = (error.resetAt ?? new Date(now.getTime() + 60_000)).toISOString();
        } else if (error.kind === "auth") {
          state.cooldownUntil = new Date(now.getTime() + 6 * 3_600_000).toISOString();
        } else {
          state.exhausted = true;
          state.exhaustedReason = message.slice(0, 200);
          state.needsConfirmation = false;
          state.quotaRemaining = 0;
          if (error.kind === "trial_exhausted") state.allowanceKind = "one_time_trial";
          state.resetAt = error.resetAt?.toISOString() ?? (state.allowanceKind === "one_time_trial" ? null : nextResetGuess(state, now).toISOString());
          state.resetSource = error.resetAt ? "provider" : "documented-period";
        }
      } else {
        state.lastOutcome = "error";
        // Only errors about the account or provider (timeouts, 5xx, network) cool it down; a bad request or a
        // cancelled call says nothing about the account.
        if (isAccountLevelError(message)) state.cooldownUntil = new Date(now.getTime() + 60_000).toISOString();
      }
    });
  }

  async list(pool?: string): Promise<AccountState[]> {
    return this.store.list(pool);
  }
}

let sharedLedger: AccountLedger | null = null;

export function sharedAccountLedger(): AccountLedger {
  if (!sharedLedger) sharedLedger = new AccountLedger();
  return sharedLedger;
}

export function setSharedAccountLedgerForTests(ledger: AccountLedger | null): void {
  sharedLedger = ledger;
}
