/**
 * Work shared across the discovery providers that run in parallel, across worker processes and across redeploys.
 *
 * Several search providers often surface the same solicitation URL in the same ingestion run. Each provider used to
 * enrich and AI-extract it on its own, paying page-fetch credits and model requests per provider before the records
 * were merged. A page is now fetched once per canonical URL (concurrent callers wait for the fetch in flight, later
 * callers reuse the result within its TTL), and the AI extraction cache is keyed by the canonical URL and content
 * rather than by each provider's own title wording.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { durableSharedWorkEnabled } from "../releaseC/flags";
import { rcPool } from "../releaseC/db";
import { ensureReleaseCSchema } from "../releaseC/schema";

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|_ga|ref|ref_src|srsltid)$/i;

/** Lower-case host, no fragment, no tracking parameters, sorted query, no trailing slash. */
export function canonicalCandidateUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAM.test(key)).sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    for (const [key, val] of kept) url.searchParams.append(key, val);
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value.trim();
  }
}

interface Entry<T> {
  value: T;
  expires: number;
}

/**
 * Durable coordination for shared work (shared_work_results). A finished result is reused by every worker until it
 * expires; a key being worked on carries a lease, so another worker waits for that result instead of paying for the
 * same page fetch or AI extraction. A lease whose owner died (redeploy, crash) expires and the work is claimed again.
 * Every call is best effort: if the database is unavailable the work simply runs in this process.
 */
export interface DurableWorkStore {
  getMany(kind: string, keys: string[]): Promise<Map<string, unknown>>;
  /** Keys this owner now holds a lease on; keys leased by another live owner (or already done) are left out. */
  claimMany(kind: string, keys: string[], owner: string, leaseMs: number): Promise<Set<string>>;
  completeMany(kind: string, entries: Array<{ key: string; value: unknown }>, owner: string, ttlMs: number): Promise<void>;
  abandonMany(kind: string, keys: string[], owner: string): Promise<void>;
}

export const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export class PostgresWorkStore implements DurableWorkStore {
  private completions = 0;

  async getMany(kind: string, keys: string[]): Promise<Map<string, unknown>> {
    const found = new Map<string, unknown>();
    if (keys.length === 0) return found;
    await ensureReleaseCSchema();
    const result = await (await rcPool()).query(
      `SELECT work_key, value FROM shared_work_results
        WHERE kind = $1 AND work_key = ANY($2::text[]) AND status = 'done' AND expires_at > now()`,
      [kind, keys],
    );
    for (const row of result.rows as Array<{ work_key: string; value: unknown }>) found.set(row.work_key, row.value);
    return found;
  }

  async claimMany(kind: string, keys: string[], owner: string, leaseMs: number): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    await ensureReleaseCSchema();
    const result = await (await rcPool()).query(
      `INSERT INTO shared_work_results (kind, work_key, status, owner, lease_until, updated_at)
       SELECT $1, k, 'running', $2, now() + ($3::bigint * interval '1 millisecond'), now() FROM unnest($4::text[]) AS k
       ON CONFLICT (kind, work_key) DO UPDATE SET status = 'running', owner = EXCLUDED.owner,
         lease_until = EXCLUDED.lease_until, value = NULL, expires_at = NULL, updated_at = now()
       WHERE shared_work_results.owner = EXCLUDED.owner
          OR (shared_work_results.status = 'running' AND shared_work_results.lease_until < now())
          OR (shared_work_results.status <> 'running'
              AND (shared_work_results.expires_at IS NULL OR shared_work_results.expires_at <= now()))
       RETURNING work_key`,
      [kind, owner, Math.round(leaseMs), keys],
    );
    return new Set((result.rows as Array<{ work_key: string }>).map((row) => row.work_key));
  }

  async completeMany(kind: string, entries: Array<{ key: string; value: unknown }>, owner: string, ttlMs: number): Promise<void> {
    if (entries.length === 0) return;
    await ensureReleaseCSchema();
    const pool = await rcPool();
    await pool.query(
      `INSERT INTO shared_work_results (kind, work_key, status, value, owner, lease_until, expires_at, updated_at)
       SELECT $1, e.key, 'done', e.value, $2, NULL, now() + ($3::bigint * interval '1 millisecond'), now()
         FROM jsonb_to_recordset($4::jsonb) AS e(key text, value jsonb)
       ON CONFLICT (kind, work_key) DO UPDATE SET status = 'done', value = EXCLUDED.value, owner = EXCLUDED.owner,
         lease_until = NULL, expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [kind, owner, Math.round(ttlMs), JSON.stringify(entries)],
    );
    this.completions += 1;
    if (this.completions % 50 === 1) {
      // Bounded housekeeping: drop results that expired more than a day ago.
      await pool
        .query(
          `DELETE FROM shared_work_results WHERE ctid IN (
             SELECT ctid FROM shared_work_results WHERE expires_at < now() - interval '1 day' LIMIT 500)`,
        )
        .catch(() => undefined);
    }
  }

  async abandonMany(kind: string, keys: string[], owner: string): Promise<void> {
    if (keys.length === 0) return;
    await ensureReleaseCSchema();
    await (await rcPool()).query(
      `UPDATE shared_work_results SET status = 'abandoned', lease_until = NULL, updated_at = now()
        WHERE kind = $1 AND work_key = ANY($2::text[]) AND owner = $3 AND status = 'running'`,
      [kind, keys, owner],
    );
  }
}

let durableStore: DurableWorkStore | null | undefined;

/** The durable store in production (OPPORTUNITY_SHARED_WORK_DURABLE), none in tests unless one is injected. */
export function sharedWorkStore(): DurableWorkStore | null {
  if (durableStore !== undefined) return durableStore;
  return durableSharedWorkEnabled() ? (durableStore = new PostgresWorkStore()) : null;
}

export function setSharedWorkStoreForTests(store: DurableWorkStore | null | undefined): void {
  durableStore = store;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface DurableOptions {
  kind: string;
  /** How long a claimed key stays leased to a worker that has not finished it. */
  leaseMs?: number;
  /** How long to wait for another worker's lease before doing the work here. */
  waitMs?: number;
  pollMs?: number;
  /** Worker identity (defaults to this process); tests use it to stand in for a second worker. */
  owner?: string;
}

/**
 * Waits for keys another worker holds, returning the results that arrived. Keys still missing afterwards are the
 * caller's to run.
 */
export async function awaitOtherWorkers(
  store: DurableWorkStore,
  kind: string,
  keys: string[],
  waitMs: number,
  pollMs: number,
): Promise<Map<string, unknown>> {
  const found = new Map<string, unknown>();
  let missing = keys;
  const deadline = Date.now() + waitMs;
  while (missing.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    const arrived = await store.getMany(kind, missing).catch(() => new Map<string, unknown>());
    for (const [key, value] of arrived) found.set(key, value);
    missing = missing.filter((key) => !found.has(key));
  }
  return found;
}

export class SharedWork<T> {
  private readonly done = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  hits = 0;
  joins = 0;
  runs = 0;
  /** Results another worker (or an earlier deploy) produced. */
  durableHits = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    /** Only results that pass are cached; a miss is retried by the next caller. */
    private readonly keep: (value: T) => boolean,
    private readonly durable?: DurableOptions,
  ) {}

  peek(key: string, now = Date.now()): T | undefined {
    const entry = this.done.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.done.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * The cached value, the result of the identical call already in flight (in this process or, with a durable store,
   * in another worker), or a fresh run. A failed or discarded shared run is not inherited: the waiter runs its own
   * attempt.
   */
  async run(key: string, work: () => Promise<T>): Promise<T> {
    const cached = this.peek(key);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.joins += 1;
      try {
        const value = await pending;
        if (this.keep(value)) return value;
      } catch {
        // fall through to an own attempt
      }
    }
    const promise = this.coordinated(key, work);
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      if (this.keep(value)) this.store(key, value);
      return value;
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    }
  }

  private async coordinated(key: string, work: () => Promise<T>): Promise<T> {
    const store = this.durable ? sharedWorkStore() : null;
    if (!store || !this.durable) {
      this.runs += 1;
      return work();
    }
    const { kind, leaseMs = 120_000, waitMs = 20_000, pollMs = 1_000, owner = WORKER_ID } = this.durable;
    const existing = await store.getMany(kind, [key]).catch(() => new Map<string, unknown>());
    if (existing.has(key) && this.keep(existing.get(key) as T)) {
      this.durableHits += 1;
      return existing.get(key) as T;
    }
    // A database failure while claiming means "run here": coordination never blocks the work.
    const claimed = await store.claimMany(kind, [key], owner, leaseMs).catch(() => new Set([key]));
    if (!claimed.has(key)) {
      const arrived = await awaitOtherWorkers(store, kind, [key], waitMs, pollMs);
      if (arrived.has(key) && this.keep(arrived.get(key) as T)) {
        this.durableHits += 1;
        return arrived.get(key) as T;
      }
    }
    this.runs += 1;
    let value: T;
    try {
      value = await work();
    } catch (error) {
      await store.abandonMany(kind, [key], owner).catch(() => undefined);
      throw error;
    }
    if (this.keep(value)) await store.completeMany(kind, [{ key, value }], owner, this.ttlMs).catch(() => undefined);
    else await store.abandonMany(kind, [key], owner).catch(() => undefined);
    return value;
  }

  store(key: string, value: T): void {
    this.done.delete(key);
    this.done.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.done.size > this.maxEntries) {
      const oldest = this.done.keys().next().value as string | undefined;
      if (!oldest) break;
      this.done.delete(oldest);
    }
  }

  clear(): void {
    this.done.clear();
    this.inflight.clear();
    this.hits = 0;
    this.joins = 0;
    this.runs = 0;
    this.durableHits = 0;
  }
}
