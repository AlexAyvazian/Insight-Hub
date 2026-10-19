import assert from "node:assert/strict";
import test from "node:test";
import { createResultStore, workspaceResult, type ResultStore, type SavedResult } from "../workspaceResults";

function memoryStore(): ResultStore {
  const rows = new Map<string, SavedResult<unknown>>();
  return {
    async read<T>(scope: string, key: string) { return (rows.get(scope + key) ?? null) as SavedResult<T> | null; },
    async write(scope, key, value, savedAt) { rows.set(scope + key, { value, savedAt }); },
  };
}

test("all four workspaces restore saved data without calling providers again", async () => {
  const store = memoryStore();
  for (const scope of ["company-news-v1", "relevant-news-v1", "forecasts-v2", "recompetes-v2"]) {
    const value = { records: [scope], fetchedAt: "2026-10-19T17:00:00Z" };
    const first = await workspaceResult(scope, "default", { store, ttlMs: 1000, now: () => 100, load: async () => value });
    const restored = await workspaceResult<typeof value>(scope, "default", { store, ttlMs: 1000, now: () => 200, load: async () => { throw Error("must not call a provider"); } });
    assert.deepEqual(restored.records, first.records);
    assert.equal(restored.savedResult, true);
    assert.equal(restored.stale, false);
  }
});

test("explicit refresh failure retains the prior successful result and its timestamp", async () => {
  const store = memoryStore();
  await workspaceResult("failure", "key", { store, ttlMs: 100, now: () => 100, load: async () => ({ records: ["saved"] }) });
  const fallback = await workspaceResult<{ records: string[] }>("failure", "key", { store, refresh: true, ttlMs: 100, now: () => 500, load: async () => { throw Error("HTTP 429"); } });
  assert.deepEqual(fallback.records, ["saved"]);
  assert.equal(fallback.stale, true);
  assert.match(fallback.refreshWarning!, /Refresh failed/);
  assert.equal(fallback.savedAt, new Date(100).toISOString());
});

test("an unusable all-provider failure cannot erase a saved result", async () => {
  const store = memoryStore();
  await store.write("partial", "key", { articles: ["previous"] }, 100);
  const result = await workspaceResult("partial", "key", { store, refresh: true, ttlMs: 100, now: () => 500, load: async () => ({ articles: [] as string[] }), usable: value => value.articles.length > 0 });
  assert.deepEqual(result.articles, ["previous"]);
  assert.equal(result.stale, true);
});

test("a partial empty first result is displayed with a warning but never saved as a complete result", async () => {
  const store = memoryStore();
  const result = await workspaceResult("first-partial", "key", { store, ttlMs: 100, load: async () => ({ articles: [] as string[] }), usable: () => false });
  assert.deepEqual(result.articles, []);
  assert.match(result.refreshWarning!, /No complete result/);
  assert.equal(await store.read("first-partial", "key"), null);
});

test("opening an expired result returns saved contents while refresh is in flight", async () => {
  const store = memoryStore();
  await store.write("background", "key", { records: ["old"] }, 100);
  let finish!: (value: { records: string[] }) => void;
  const pending = new Promise<{ records: string[] }>(resolve => { finish = resolve; });
  const result = await workspaceResult("background", "key", { store, ttlMs: 100, now: () => 500, load: () => pending });
  assert.deepEqual(result.records, ["old"]);
  assert.equal(result.stale, true);
  finish({ records: ["new"] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await store.read<{ records: string[] }>("background", "key"))!.value.records, ["new"]);
});

test("profile-version and filter keys do not restore results assessed under another profile", async () => {
  const store = memoryStore();
  await store.write("forecast", "old-profile", { records: ["old irrelevant item"] }, 100);
  const result = await workspaceResult("forecast", "new-profile", { store, ttlMs: 100, now: () => 150, load: async () => ({ records: ["current match"] }) });
  assert.deepEqual(result.records, ["current match"]);
});

test("storage failure is visible while successful provider results remain usable", async () => {
  const store: ResultStore = { read: async () => null, write: async () => { throw Error("database unavailable"); } };
  const result = await workspaceResult("write-failure", "key", { store, ttlMs: 100, load: async () => ({ articles: ["current"] }) });
  assert.deepEqual(result.articles, ["current"]);
  assert.match(result.persistenceWarning!, /could not be saved/);
});

test("SQL storage survives a new store instance and batches roster hydration", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const run = async (sql: string, params: unknown[] = []) => {
    const id = `${params[0]}:${params[1]}`;
    if (sql.startsWith("INSERT")) rows.set(id, { result_key: params[1], payload: JSON.parse(String(params[2])), saved_at: params[3] });
    if (sql.startsWith("SELECT result_key")) return [...rows.values()].filter(row => (params[1] as string[]).includes(String(row.result_key)));
    return sql.startsWith("SELECT payload") && rows.has(id) ? [rows.get(id)!] : [];
  };
  const first = createResultStore(run);
  await first.write("company", "Leidos", { articles: ["retained"] }, 100);
  const afterRestart = createResultStore(run);
  assert.deepEqual((await afterRestart.read<{ articles: string[] }>("company", "Leidos"))!.value.articles, ["retained"]);
  const roster = await afterRestart.readMany!("company", ["Leidos", "Missing"]);
  assert.equal(roster.length, 2);
  assert.equal(roster[1], null);
});
