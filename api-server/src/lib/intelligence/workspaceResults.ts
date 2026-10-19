import { createHash } from "node:crypto";
import { logger } from "../logger";

type SqlRunner = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
export interface SavedResult<T> { value: T; savedAt: number }
export interface ResultStore {
  read<T>(scope: string, key: string): Promise<SavedResult<T> | null>;
  readMany?<T>(scope: string, keys: string[]): Promise<Array<SavedResult<T> | null>>;
  write<T>(scope: string, key: string, value: T, savedAt: number): Promise<void>;
}

/** Public intelligence only. Separate from credentials and from OCCU_MED_AWARE's read-only profile. */
export function createResultStore(run: SqlRunner): ResultStore {
  let ready: Promise<void> | null = null;
  const ensure = () => ready ??= run(`CREATE TABLE IF NOT EXISTS workspace_results (
    scope text NOT NULL, result_key text NOT NULL, payload jsonb NOT NULL,
    saved_at timestamptz NOT NULL, PRIMARY KEY (scope, result_key)
  )`).then(() => {}).catch(error => { ready = null; throw error; });
  const hash = (key: string) => createHash("sha256").update(key).digest("hex");
  return {
    async readMany<T>(scope: string, keys: string[]) {
      await ensure();
      const rows = await run("SELECT result_key, payload, saved_at FROM workspace_results WHERE scope = $1 AND result_key = ANY($2::text[]) AND saved_at > now() - interval '30 days'", [scope, keys.map(hash)]);
      const byKey = new Map(rows.map(row => [row.result_key, row]));
      return keys.map(key => {
        const row = byKey.get(hash(key));
        const savedAt = row ? (row.saved_at instanceof Date ? row.saved_at.getTime() : new Date(String(row.saved_at)).getTime()) : NaN;
        return row && Number.isFinite(savedAt) ? { value: row.payload as T, savedAt } : null;
      });
    },
    async read<T>(scope: string, key: string) {
      await ensure();
      const [row] = await run("SELECT payload, saved_at FROM workspace_results WHERE scope = $1 AND result_key = $2 AND saved_at > now() - interval '30 days'", [scope, hash(key)]);
      if (!row) return null;
      const savedAt = (row.saved_at instanceof Date ? row.saved_at.getTime() : new Date(String(row.saved_at)).getTime());
      return Number.isFinite(savedAt) ? { value: row.payload as T, savedAt } : null;
    },
    async write(scope, key, value, savedAt) {
      await ensure();
      await run(`INSERT INTO workspace_results (scope, result_key, payload, saved_at) VALUES ($1,$2,$3::jsonb,$4)
        ON CONFLICT (scope, result_key) DO UPDATE SET payload = EXCLUDED.payload, saved_at = EXCLUDED.saved_at
        WHERE workspace_results.saved_at <= EXCLUDED.saved_at`, [scope, hash(key), JSON.stringify(value), new Date(savedAt).toISOString()]);
      // Bound storage, including obsolete profile-version keys and abandoned filter combinations.
      await run(`DELETE FROM workspace_results WHERE scope = $1 AND result_key NOT IN
        (SELECT result_key FROM workspace_results WHERE scope = $1 AND saved_at > now() - interval '30 days' ORDER BY saved_at DESC LIMIT 500)`, [scope]);
    },
  };
}

let defaultStore: ResultStore | null = null;
async function store(): Promise<ResultStore> {
  if (!defaultStore) {
    const { rfpPool } = await import("@workspace/db");
    defaultStore = createResultStore(async (sql, params) => (await rfpPool.query(sql, params)).rows);
  }
  return defaultStore;
}

export type ResultMetadata = { savedResult?: boolean; stale?: boolean; savedAt?: string; refreshWarning?: string; persistenceWarning?: string };
const pending = new Map<string, Promise<object>>();

/** Restore the last successful result, refresh only when due, and keep it on provider failures. */
export async function workspaceResult<T extends object>(scope: string, key: string, options: {
  ttlMs: number; refresh?: boolean; load: () => Promise<T>; usable?: (value: T) => boolean;
  store?: ResultStore; now?: () => number;
}): Promise<T & ResultMetadata> {
  const now = options.now ?? Date.now;
  let backend: ResultStore | null = options.store ?? null;
  let saved: SavedResult<T> | null = null;
  let persistenceWarning: string | undefined;
  try {
    backend ??= await store();
    saved = await backend.read<T>(scope, key);
  } catch (error) {
    logger.warn({ err: error, scope }, "Workspace saved results unavailable");
    persistenceWarning = "Saved results are temporarily unavailable; current results may not survive a restart.";
  }
  const restore = (stale: boolean): T & ResultMetadata => ({ ...saved!.value, savedResult: true, stale, savedAt: new Date(saved!.savedAt).toISOString() });
  if (saved && !options.refresh && now() - saved.savedAt < options.ttlMs) return restore(false);
  const refresh = async (): Promise<T & ResultMetadata> => {
    const id = scope + ":" + key;
    let job = pending.get(id) as Promise<T & ResultMetadata> | undefined;
    if (!job) {
      job = (async () => {
        const startedAt = now();
        const value = await options.load();
        if (options.usable && !options.usable(value)) {
          if (saved) throw new Error("Providers could not supply a complete result; previous results retained.");
          return { ...value, refreshWarning: "Some sources are unavailable. No complete result has been saved yet." };
        }
        if (backend) {
          try { await backend.write(scope, key, value, startedAt); }
          catch (error) {
            logger.warn({ err: error, scope }, "Workspace results could not be saved");
            persistenceWarning = "Current results could not be saved; the previous saved result is retained.";
          }
        }
        return { ...value, savedAt: new Date(startedAt).toISOString(), ...(persistenceWarning ? { persistenceWarning } : {}) };
      })().finally(() => pending.delete(id));
      pending.set(id, job);
    }
    return job;
  };
  // Opening a workspace restores its saved contents immediately; refreshing runs in the background.
  if (saved && !options.refresh) {
    void refresh().catch(error => logger.warn({ err: error, scope }, "Background workspace refresh failed; saved results retained"));
    return { ...restore(true), refreshWarning: "Showing saved results while refreshing. Refresh to check the latest result." };
  }
  try { return await refresh(); }
  catch (error) {
    if (!saved) throw error;
    logger.warn({ err: error, scope }, "Workspace refresh failed; saved results retained");
    return { ...restore(true), refreshWarning: "Refresh failed. Showing the last successful saved results." };
  }
}

/** Read-only hydration never triggers a paid provider search. */
export async function savedWorkspaceResults<T>(scope: string, keys: string[]): Promise<Array<SavedResult<T> | null>> {
  const backend = await store();
  return backend.readMany ? backend.readMany<T>(scope, keys) : Promise.all(keys.map(key => backend.read<T>(scope, key)));
}
