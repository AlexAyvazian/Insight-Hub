import { eq } from "drizzle-orm";
import { rfpDb, settingsTable } from "@workspace/db";
import { resolveCredential } from "../config/providerConfig";
import { purposeAllows, recordPurposeCall } from "../purposeBudget";
import {
  ProviderQuotaError,
  sharedAccountLedger,
  type SpendPurpose,
  type AccountLedger,
  type AccountPolicy,
  type QuotaSnapshot,
} from "./accountLedger";

export interface CredentialSlot {
  dbKey?: string;
  envKey: string;
}

export interface FreeTierCredentialPoolOptions {
  /**
   * When true (default), move to the next key after every successful call.
   * When false, keep using the current account until it becomes unavailable,
   * then fail over to the next account and stay there.
   */
  rotateOnSuccess?: boolean;
  /**
   * Opt-in per-account quota accounting (Release C). Pools without it behave exactly as before.
   * Each slot gets its own allowance kind, unit, usage, reset time and exhaustion state; exhausted accounts are
   * skipped until a probe (when provided) or the documented reset confirms capacity.
   */
  accounts?: PoolAccountAccounting;
  /**
   * Controlled parallel assignment across independent accounts: at most this many calls run on one account at a
   * time, and a concurrent call goes to the next account with capacity instead of piling onto the active one. Only
   * for pools whose accounts are separately permitted and whose free allowances were verified. Unset: unlimited.
   */
  maxConcurrentPerAccount?: number;
}

export interface SlotProbe {
  slot: string;
  configured: boolean;
  /** Earlier slot holding the same key; the pool uses it once. */
  duplicateOf: string | null;
  /** null when not probed (unconfigured, duplicate, or the pool has no probe). */
  ok: boolean | null;
  limit?: number | null;
  remaining?: number | null;
  usedToday?: number | null;
  resetAt?: string | null;
  source?: string | null;
  error?: string;
}

export interface PoolAccountAccounting {
  policyFor(slot: string): AccountPolicy;
  /** Free capacity probe (usage/balance endpoint). Must not consume billable units. */
  probe?: (apiKey: string, slot: string) => Promise<QuotaSnapshot | null>;
  /** Units a call consumes when the operation does not report its own usage (default 1). */
  unitsPerCall?: number;
  /** Refresh capacity with the free probe before every call (for allowances shared with other users of the key). */
  probeBeforeEachRun?: boolean;
  ledger?: AccountLedger;
  /** The spend purpose this pool's calls count against (see purposeBudget.ts); reservations carry it too. */
  purpose?: SpendPurpose;
}

export interface CredentialRunContext {
  /** Report the real units this call consumed (pages, credits, tokens) instead of the default per-call estimate. */
  reportUsage(units: number, quality?: "good" | "poor"): void;
  /** Report provider-stated capacity seen in the response. */
  reportSnapshot(snapshot: QuotaSnapshot): void;
  /** Planned units for this call (lets the pool refuse a call that would exceed a free allowance). */
  plannedUnits: number;
}

export type CredentialSlotOutcome =
  | "success"
  | "empty"
  | "rate_limited"
  | "quota"
  | "auth"
  | "timeout"
  | "budget_exhausted"
  | "error";

export interface CredentialPoolSlotSnapshot {
  slot: string;
  configured: boolean;
  active: boolean;
  coolingDown: boolean;
  cooldownUntil: string | null;
  attempts: number;
  successes: number;
  failures: number;
  lastOutcome: CredentialSlotOutcome | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  quotaLimit: number | null;
  quotaRemaining: number | null;
  quotaResetAt: string | null;
}

export interface CredentialPoolSnapshot {
  id: string;
  rotateOnSuccess: boolean;
  configuredAccounts: number;
  activeSlot: string | null;
  slots: CredentialPoolSlotSnapshot[];
}

type SlotRuntimeState = {
  attempts: number;
  successes: number;
  failures: number;
  lastOutcome: CredentialSlotOutcome | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  quotaLimit: number | null;
  quotaRemaining: number | null;
  quotaResetAt: string | null;
};

const cursors = new Map<string, number>();
const cooldowns = new Map<string, number>();
const slotStates = new Map<string, SlotRuntimeState>();
const poolInstances = new Map<string, FreeTierCredentialPool>();
/** Calls currently running per account (runtimeKey), for maxConcurrentPerAccount. */
const inflight = new Map<string, number>();
const ACCOUNT_WAIT_MS = 30_000;

function runtimeKey(poolId: string, slot: string): string {
  return `${poolId}:${slot}`;
}

function durableCooldownKey(poolId: string, slot: string): string {
  return `credential-pool:v1:${poolId}:${slot}:cooldown`;
}

async function loadDurableCooldown(poolId: string, slot: string): Promise<number> {
  try {
    const [row] = await rfpDb
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, durableCooldownKey(poolId, slot)))
      .limit(1);
    const parsed = Number(row?.value ?? 0);
    return Number.isFinite(parsed) && parsed > Date.now() ? parsed : 0;
  } catch {
    return 0;
  }
}

async function persistDurableCooldown(
  poolId: string,
  slot: string,
  cooldownUntil: number,
): Promise<void> {
  try {
    await rfpDb
      .insert(settingsTable)
      .values({
        key: durableCooldownKey(poolId, slot),
        value: String(cooldownUntil),
      })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: String(cooldownUntil) },
      });
  } catch {
    // Runtime memory still protects the key if persistence is temporarily unavailable.
  }
}

function logAccountingFailure(poolId: string, slot: string, error: unknown): void {
  console.warn(JSON.stringify({ event: "account_usage_record_failed", pool: poolId, slot, error: error instanceof Error ? error.message : String(error) }));
}

async function clearDurableCooldown(poolId: string, slot: string): Promise<void> {
  try {
    await rfpDb
      .delete(settingsTable)
      .where(eq(settingsTable.key, durableCooldownKey(poolId, slot)));
  } catch {
    // Best effort only.
  }
}

function emptySlotState(): SlotRuntimeState {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    lastOutcome: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    quotaLimit: null,
    quotaRemaining: null,
    quotaResetAt: null,
  };
}

function slotState(poolId: string, slot: string): SlotRuntimeState {
  const key = runtimeKey(poolId, slot);
  const state = slotStates.get(key) ?? emptySlotState();
  slotStates.set(key, state);
  return state;
}

function failureOutcome(error: unknown): CredentialSlotOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(401|403)\b|invalid api.?key|unauthori[sz]ed|forbidden/i.test(message)) {
    return "auth";
  }
  // A transport-level 429 is rate limiting even when the message also says
  // "limit exceeded". Reserve quota for explicit credit/team/budget exhaustion.
  if (/\b429\b|rate.?limit|too many requests|throttl/i.test(message)) {
    return "rate_limited";
  }
  if (/team_budget_exceeded|no_more_credits|api_key_budget_exceeded|quota|credit|balance|budget|exhaust/i.test(message)) {
    return "quota";
  }
  if (/\b408\b|timeout|timed out|ECONN|fetch failed|\b5\d\d\b/i.test(message)) {
    return "timeout";
  }
  return "error";
}

function explicitCooldownUntilMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/SAM_GOV_COOLDOWN_UNTIL=([^\s|]+)/i);
  if (!match?.[1]) return null;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) && parsed > Date.now() ? parsed : null;
}

function cooldownMs(error: unknown): number {
  if (error instanceof ProviderQuotaError && error.resetAt && error.resetAt.getTime() > Date.now()) {
    return error.resetAt.getTime() - Date.now();
  }
  const outcome = failureOutcome(error);
  if (outcome === "auth") return 6 * 60 * 60 * 1_000;
  if (outcome === "quota") return 24 * 60 * 60 * 1_000;
  if (outcome === "rate_limited") return 30 * 60 * 1_000;
  if (outcome === "timeout") return 60_000;
  return 60_000;
}

function isCredentialRetryable(error: unknown): boolean {
  // An operation can mark its error as final for the run (for example, a remote job already accepted and charged).
  if ((error as { credentialRetryable?: boolean } | null)?.credentialRetryable === false) return false;
  if (error instanceof ProviderQuotaError) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(400|404|405|413|422)\b/.test(message)) return false;
  return /\b(401|403|408|409|429|5\d\d)\b|quota|rate.?limit|credit|balance|budget|exceed|exhaust|timeout|ECONN|fetch failed/i.test(
    message,
  );
}

function numericHeader(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function resetHeader(headers: Headers): string | null {
  const raw =
    headers.get("x-ratelimit-reset") ??
    headers.get("ratelimit-reset") ??
    headers.get("x-rate-limit-reset");
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const timestamp =
      numeric > 1_000_000_000_000
        ? numeric
        : numeric > 1_000_000_000
          ? numeric * 1_000
          : Date.now() + numeric * 1_000;
    return new Date(timestamp).toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export class FreeTierCredentialPool {
  private readonly rotateOnSuccess: boolean;
  private readonly accounts: PoolAccountAccounting | undefined;
  private readonly maxConcurrentPerAccount: number | null;

  constructor(
    private readonly id: string,
    private readonly slots: readonly CredentialSlot[],
    options: FreeTierCredentialPoolOptions = {},
  ) {
    this.rotateOnSuccess = options.rotateOnSuccess ?? true;
    this.accounts = options.accounts;
    this.maxConcurrentPerAccount = options.maxConcurrentPerAccount && options.maxConcurrentPerAccount > 0 ? Math.floor(options.maxConcurrentPerAccount) : null;
    poolInstances.set(id, this);
  }

  private async credentials(): Promise<Array<{ slot: string; value: string }>> {
    const resolved = await Promise.all(
      this.slots.map(async ({ dbKey, envKey }) => ({
        slot: envKey,
        value: dbKey
          ? await resolveCredential(dbKey, envKey)
          : (process.env[envKey] ?? null),
      })),
    );
    const seen = new Set<string>();
    return resolved.flatMap(({ slot, value }) => {
      const normalized = value?.trim();
      if (!normalized || seen.has(normalized)) return [];
      seen.add(normalized);
      return [{ slot, value: normalized }];
    });
  }

  async isConfigured(): Promise<boolean> {
    return (await this.credentials()).length > 0;
  }

  /**
   * Read-only check of every slot with the pool's free capacity probe (or `probe`). Never returns key material;
   * a slot holding the same key as an earlier slot is reported as a duplicate and not probed.
   */
  async probeSlots(probe?: (apiKey: string, slot: string) => Promise<QuotaSnapshot | null>): Promise<SlotProbe[]> {
    const check = probe ?? this.accounts?.probe;
    const seen = new Map<string, string>();
    const results: SlotProbe[] = [];
    for (const { dbKey, envKey } of this.slots) {
      const value = (dbKey ? await resolveCredential(dbKey, envKey) : (process.env[envKey] ?? null))?.trim();
      if (!value) {
        results.push({ slot: envKey, configured: false, duplicateOf: null, ok: null });
        continue;
      }
      const duplicateOf = seen.get(value) ?? null;
      seen.set(value, duplicateOf ?? envKey);
      if (duplicateOf || !check) {
        results.push({ slot: envKey, configured: true, duplicateOf, ok: null });
        continue;
      }
      try {
        const snapshot = await check(value, envKey);
        results.push({
          slot: envKey,
          configured: true,
          duplicateOf: null,
          ok: snapshot !== null,
          limit: snapshot?.limit ?? null,
          remaining: snapshot?.remaining ?? null,
          usedToday: snapshot?.usedToday ?? null,
          resetAt: snapshot?.resetAt ? snapshot.resetAt.toISOString() : null,
          source: snapshot?.source ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ slot: envKey, configured: true, duplicateOf: null, ok: false, error: message.split(value).join("[redacted]").slice(0, 200) });
      }
    }
    return results;
  }

  recordRateLimitHeaders(slot: string, headers: Headers): void {
    const state = slotState(this.id, slot);
    const limit = numericHeader(headers, [
      "x-ratelimit-limit",
      "ratelimit-limit",
      "x-rate-limit-limit",
    ]);
    const remaining = numericHeader(headers, [
      "x-ratelimit-remaining",
      "ratelimit-remaining",
      "x-rate-limit-remaining",
    ]);
    const resetAt = resetHeader(headers);
    if (limit != null) state.quotaLimit = limit;
    if (remaining != null) state.quotaRemaining = remaining;
    if (resetAt) state.quotaResetAt = resetAt;

    if (remaining === 0 && resetAt) {
      const resetMs = Date.parse(resetAt);
      if (Number.isFinite(resetMs) && resetMs > Date.now()) {
        cooldowns.set(runtimeKey(this.id, slot), resetMs);
        void persistDurableCooldown(this.id, slot, resetMs);
      }
    }
  }

  async snapshot(): Promise<CredentialPoolSnapshot> {
    const credentials = await this.credentials();
    await Promise.all(
      this.slots.map(async ({ envKey }) => {
        const key = runtimeKey(this.id, envKey);
        const memoryUntil = cooldowns.get(key) ?? 0;
        if (memoryUntil > Date.now()) return;
        const durableUntil = await loadDurableCooldown(this.id, envKey);
        if (durableUntil > Date.now()) cooldowns.set(key, durableUntil);
      }),
    );
    const cursor = credentials.length > 0
      ? (cursors.get(this.id) ?? 0) % credentials.length
      : 0;
    const activeSlot = credentials[cursor]?.slot ?? null;
    const configuredSlots = new Set(credentials.map((credential) => credential.slot));
    const now = Date.now();
    return {
      id: this.id,
      rotateOnSuccess: this.rotateOnSuccess,
      configuredAccounts: credentials.length,
      activeSlot,
      slots: this.slots.map(({ envKey }) => {
        const until = cooldowns.get(runtimeKey(this.id, envKey)) ?? 0;
        const state = slotState(this.id, envKey);
        return {
          slot: envKey,
          configured: configuredSlots.has(envKey),
          active: envKey === activeSlot,
          coolingDown: until > now,
          cooldownUntil: until > now ? new Date(until).toISOString() : null,
          attempts: state.attempts,
          successes: state.successes,
          failures: state.failures,
          lastOutcome: state.lastOutcome,
          lastAttemptAt: state.lastAttemptAt,
          lastSuccessAt: state.lastSuccessAt,
          quotaLimit: state.quotaLimit,
          quotaRemaining: state.quotaRemaining,
          quotaResetAt: state.quotaResetAt,
        };
      }),
    };
  }

  /** Per-account ledger states for telemetry (empty when accounting is not enabled for this pool). */
  async accountStates() {
    if (!this.accounts) return [];
    const ledger = this.accounts.ledger ?? sharedAccountLedger();
    return Promise.all(this.slots.map(({ envKey }) => ledger.state(this.accounts!.policyFor(envKey))));
  }

  /** Capacity check that also reserves the planned units; call the returned release() once usage is recorded. */
  private async accountAllows(
    candidate: { slot: string; value: string },
    plannedUnits: number,
    skipped: string[],
  ): Promise<(() => void) | null> {
    if (!this.accounts) return () => undefined;
    const ledger = this.accounts.ledger ?? sharedAccountLedger();
    const policy = this.accounts.policyFor(candidate.slot);
    let decision = await ledger.canSpend(policy, plannedUnits, Boolean(this.accounts.probe));
    const cooling = !decision.ok && !decision.needsProbe && decision.reason.startsWith("cooling down");
    // An account whose capacity has never been confirmed is probed (free) before its first request, so an account
    // that is already empty (e.g. used up elsewhere) never receives a billable call.
    const unconfirmed = Boolean(this.accounts.probe) && !(await ledger.state(policy)).lastConfirmedAt;
    if (this.accounts.probe && !cooling && (this.accounts.probeBeforeEachRun || unconfirmed || (!decision.ok && decision.needsProbe))) {
      const required = Boolean(this.accounts.probeBeforeEachRun) || unconfirmed;
      let confirmed = false;
      try {
        const snapshot = await this.accounts.probe(candidate.value, candidate.slot);
        if (snapshot) {
          await ledger.recordSnapshot(policy, snapshot);
          confirmed = true;
        }
      } catch (error) {
        await ledger.recordFailure(policy, error);
      }
      // A required probe that fails or returns nothing fails closed: stale or unknown capacity never authorises a
      // billable call.
      if (required && !confirmed) {
        skipped.push(`${candidate.slot}: capacity probe failed; account skipped`);
        return null;
      }
      decision = await ledger.canSpend(policy, plannedUnits, false);
    }
    if (decision.ok) {
      const reservation = await ledger.reserve(policy, plannedUnits, false, { purpose: this.accounts.purpose });
      if (reservation.ok) return reservation.release;
      decision = reservation;
    }
    skipped.push(`${candidate.slot}: ${decision.reason}${decision.retryAt ? ` (retry after ${decision.retryAt})` : ""}`);
    return null;
  }

  /**
   * Runs on one named account without selection or a capacity check: for collecting work that account already
   * accepted (and was charged for). Usage the operation reports is still recorded.
   */
  async runOnSlot<T>(
    slot: string,
    operation: (apiKey: string, slot: string, context: CredentialRunContext) => Promise<T>,
  ): Promise<T> {
    const credential = (await this.credentials()).find((entry) => entry.slot === slot);
    if (!credential) throw new Error(`${this.id} credential ${slot} is not configured`);
    let reportedUnits = 0;
    let reportedQuality: "good" | "poor" | undefined;
    const context: CredentialRunContext = {
      plannedUnits: 0,
      reportUsage(units, quality) {
        reportedUnits += Math.max(0, units);
        reportedQuality = quality ?? reportedQuality;
      },
      reportSnapshot() {
        // Snapshots come from the normal probe path.
      },
    };
    const ledger = this.accounts ? (this.accounts.ledger ?? sharedAccountLedger()) : null;
    const policy = this.accounts?.policyFor(slot);
    let value: T;
    try {
      value = await operation(credential.value, slot, context);
    } catch (error) {
      if (ledger && policy) {
        if (reportedUnits > 0) await ledger.recordUsage(policy, reportedUnits, "failure", reportedQuality).catch(() => undefined);
        if ((error as { accountHealthy?: boolean } | null)?.accountHealthy !== true) {
          await ledger.recordFailure(policy, error).catch(() => undefined);
        }
      }
      throw error;
    }
    // The provider call succeeded (and was charged); a bookkeeping failure must never turn it into a retry.
    if (ledger && policy && reportedUnits > 0) {
      await ledger.recordUsage(policy, reportedUnits, "success", reportedQuality).catch((error) => logAccountingFailure(this.id, slot, error));
    }
    return value;
  }

  /**
   * With a per-account concurrency limit: accounts with a free place first, in the pool's order. When every
   * account is at its limit, waits (bounded) for a place rather than overloading one account.
   */
  private async accountsWithRoom<C extends { slot: string }>(available: C[]): Promise<C[]> {
    const limit = this.maxConcurrentPerAccount;
    if (!limit) return available;
    const free = () => available.filter(({ slot }) => (inflight.get(runtimeKey(this.id, slot)) ?? 0) < limit);
    const deadline = Date.now() + ACCOUNT_WAIT_MS;
    while (free().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const room = free();
    return room.length > 0 ? room : available;
  }

  async run<T>(
    operation: (apiKey: string, slot: string, context: CredentialRunContext) => Promise<T>,
    runOptions: { plannedUnits?: number } = {},
  ): Promise<T> {
    const credentials = await this.credentials();
    if (credentials.length === 0) {
      throw new Error(`${this.id} API key not configured`);
    }
    await Promise.all(
      credentials.map(async ({ slot }) => {
        const key = runtimeKey(this.id, slot);
        const memoryUntil = cooldowns.get(key) ?? 0;
        if (memoryUntil > Date.now()) return;
        const durableUntil = await loadDurableCooldown(this.id, slot);
        if (durableUntil > Date.now()) cooldowns.set(key, durableUntil);
      }),
    );
    const start = (cursors.get(this.id) ?? 0) % credentials.length;
    const ordered = [
      ...credentials.slice(start),
      ...credentials.slice(0, start),
    ];
    const now = Date.now();
    const available = ordered.filter(
      ({ slot }) => (cooldowns.get(runtimeKey(this.id, slot)) ?? 0) <= now,
    );
    if (available.length === 0) {
      const nextReset = ordered
        .map(({ slot }) => cooldowns.get(runtimeKey(this.id, slot)) ?? 0)
        .filter((value) => value > now)
        .sort((a, b) => a - b)[0];
      throw new Error(
        `${this.id} credential pool exhausted: all configured credentials cooling down${nextReset ? ` until ${new Date(nextReset).toISOString()}` : ""}`,
      );
    }
    const candidates = await this.accountsWithRoom(available);
    const errors: string[] = [];
    const plannedUnits = runOptions.plannedUnits ?? this.accounts?.unitsPerCall ?? 1;
    const purpose = this.accounts?.purpose;
    if (purpose) {
      const allowed = await purposeAllows(purpose);
      if (!allowed.ok) throw new Error(`${this.id} credential pool exhausted: ${allowed.reason}`);
    }
    // A call placed on another account only because the active one was busy does not move a sticky pool's cursor.
    let overflow = candidates.length < available.length;
    for (const candidate of candidates) {
      const busyKey = runtimeKey(this.id, candidate.slot);
      if (this.maxConcurrentPerAccount && (inflight.get(busyKey) ?? 0) >= this.maxConcurrentPerAccount) {
        overflow = true;
        errors.push(`${candidate.slot}: account busy (${this.maxConcurrentPerAccount} concurrent calls)`);
        continue;
      }
      const release = await this.accountAllows(candidate, plannedUnits, errors);
      if (!release) continue;
      inflight.set(busyKey, (inflight.get(busyKey) ?? 0) + 1);
      const done = () => {
        const left = (inflight.get(busyKey) ?? 1) - 1;
        if (left > 0) inflight.set(busyKey, left);
        else inflight.delete(busyKey);
      };
      const state = slotState(this.id, candidate.slot);
      state.attempts += 1;
      state.lastAttemptAt = new Date().toISOString();
      let reportedUnits: number | null = null;
      let reportedQuality: "good" | "poor" | undefined;
      let reportedSnapshot: QuotaSnapshot | null = null;
      const context: CredentialRunContext = {
        plannedUnits,
        reportUsage(units, quality) {
          reportedUnits = (reportedUnits ?? 0) + Math.max(0, units);
          reportedQuality = quality ?? reportedQuality;
        },
        reportSnapshot(snapshot) {
          reportedSnapshot = snapshot;
        },
      };
      try {
        const value = await operation(candidate.value, candidate.slot, context);
        if (this.accounts) {
          const ledger = this.accounts.ledger ?? sharedAccountLedger();
          const policy = this.accounts.policyFor(candidate.slot);
          // The provider call succeeded (and was charged); a bookkeeping failure must never turn it into a retry.
          try {
            await ledger.recordUsage(policy, reportedUnits ?? plannedUnits, "success", reportedQuality);
            if (reportedSnapshot) await ledger.recordSnapshot(policy, reportedSnapshot);
          } catch (accountingError) {
            logAccountingFailure(this.id, candidate.slot, accountingError);
          }
        }
        release();
        done();
        if (purpose) recordPurposeCall(purpose, "success");
        state.successes += 1;
        state.lastOutcome = "success";
        state.lastSuccessAt = new Date().toISOString();
        const index = credentials.findIndex(
          ({ slot }) => slot === candidate.slot,
        );
        if (this.rotateOnSuccess || !overflow) {
          cursors.set(
            this.id,
            this.rotateOnSuccess ? (index + 1) % credentials.length : index,
          );
        }
        const configuredReset = state.quotaResetAt
          ? Date.parse(state.quotaResetAt)
          : Number.NaN;
        if (state.quotaRemaining !== 0 || !Number.isFinite(configuredReset)) {
          cooldowns.delete(runtimeKey(this.id, candidate.slot));
          await clearDurableCooldown(this.id, candidate.slot);
        }
        return value;
      } catch (error) {
        state.failures += 1;
        state.lastOutcome = failureOutcome(error);
        if (this.accounts) {
          const ledger = this.accounts.ledger ?? sharedAccountLedger();
          const policy = this.accounts.policyFor(candidate.slot);
          // Usage the operation reported before failing was already charged by the provider.
          if (reportedUnits !== null && reportedUnits > 0) {
            await ledger.recordUsage(policy, reportedUnits, "failure", reportedQuality).catch(() => undefined);
          }
          // An error that says the account is healthy (e.g. waiting on an accepted job) is not an account failure.
          if ((error as { accountHealthy?: boolean } | null)?.accountHealthy !== true) {
            await ledger.recordFailure(policy, error).catch(() => undefined);
          }
        }
        release();
        done();
        if (purpose) recordPurposeCall(purpose, "failure");
        if (!isCredentialRetryable(error)) throw error;
        const explicitReset = explicitCooldownUntilMs(error);
        const cooldownUntil = explicitReset ?? (Date.now() + cooldownMs(error));
        cooldowns.set(runtimeKey(this.id, candidate.slot), cooldownUntil);
        await persistDurableCooldown(this.id, candidate.slot, cooldownUntil);
        if (explicitReset) {
          state.quotaResetAt = new Date(explicitReset).toISOString();
          if (state.lastOutcome === "quota" || state.lastOutcome === "rate_limited") {
            state.quotaRemaining = 0;
          }
        }
        errors.push(
          `${candidate.slot}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new Error(
      `${this.id} credential pool exhausted: ${errors.join(" | ")}`,
    );
  }
}

/**
 * Safe telemetry boundary. Runtime values are sanitized snapshot objects only;
 * no credential value is present. The broad array return avoids leaking the
 * pool's internal generic implementation into dynamic consumers.
 */
export async function credentialPoolTelemetry(): Promise<any[]> {
  const snapshots: CredentialPoolSnapshot[] = await Promise.all(
    [...poolInstances.values()].map((pool) => pool.snapshot()),
  );
  return snapshots;
}

export function clearFreeTierCredentialPoolState(): void {
  cursors.clear();
  inflight.clear();
  cooldowns.clear();
  slotStates.clear();
}
