/**
 * Opportunities wave 1: provider orchestration across workers. Shared work, reservations and cooldowns are
 * exercised against the real Release C tables (CI runs a Postgres service), with two ledgers / owners standing in
 * for two workers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rcPool } from "../../releaseC/db";
import { ensureReleaseCSchema } from "../../releaseC/schema";
import {
  AccountLedger,
  MemoryLedgerStore,
  PostgresLedgerStore,
  type AccountPolicy,
  type LedgerStore,
} from "../accountLedger";
import { clearFreeTierCredentialPoolState, FreeTierCredentialPool } from "../freeTierCredentialPool";
import { PostgresWorkStore, SharedWork, setSharedWorkStoreForTests } from "../../search/sharedWork";
import { mergeWebDiscoveryBatches, consolidatedDuplicateCount, type WebDiscoveryBatch } from "../../search/webIntelligence";
import { clearPurposeBudgetsForTests, purposeAllows, purposeForPool } from "../../purposeBudget";
import { clearLimitedProviderPoolState, runLimitedProviderPool } from "../../limitedProviderPool";

// Database-backed cases run only where Postgres is actually reachable (some CI jobs set the URL without a server).
const hasDb = await (async () => {
  if (!process.env.RFP_DATABASE_URL) return false;
  try {
    await Promise.race([
      (await rcPool()).query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000).unref()),
    ]);
    return true;
  } catch {
    return false;
  }
})();
const run = `t${Date.now().toString(36)}`;

async function sql(statement: string, params: unknown[] = []) {
  return (await rcPool()).query(statement, params);
}

function policy(slot: string, overrides: Partial<AccountPolicy> = {}): AccountPolicy {
  return {
    pool: `orchestration-${run}`,
    slot,
    provider: "test",
    allowanceKind: "recurring_daily",
    unit: "pages",
    periodLimit: 10,
    safetyFraction: 1,
    overageBillable: true,
    ...overrides,
  };
}

test("two workers share one page fetch through the durable store", { skip: !hasDb }, async () => {
  await ensureReleaseCSchema();
  setSharedWorkStoreForTests(new PostgresWorkStore());
  try {
    const kind = `test_enrichment_${run}`;
    let calls = 0;
    const work = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { value: "page text", provider: "jina" };
    };
    const keep = (value: { value: string | null }) => Boolean(value.value);
    const workerA = new SharedWork(60_000, 10, keep, { kind, owner: `${run}-a`, pollMs: 25, waitMs: 2_000 });
    const workerB = new SharedWork(60_000, 10, keep, { kind, owner: `${run}-b`, pollMs: 25, waitMs: 2_000 });
    const [a, b] = await Promise.all([workerA.run("https://example.gov/rfp", work), workerB.run("https://example.gov/rfp", work)]);
    assert.equal(calls, 1, "the page is fetched once across both workers");
    assert.deepEqual(a, b);
    assert.equal(workerA.durableHits + workerB.durableHits, 1);

    // A later deploy (a new, empty in-memory cache) reuses the stored result.
    const redeployed = new SharedWork(60_000, 10, keep, { kind, owner: `${run}-c` });
    await redeployed.run("https://example.gov/rfp", work);
    assert.equal(calls, 1);
    assert.equal(redeployed.durableHits, 1);
  } finally {
    setSharedWorkStoreForTests(undefined);
  }
});

test("a lease left by a worker that died is reclaimed after it expires", { skip: !hasDb }, async () => {
  await ensureReleaseCSchema();
  const store = new PostgresWorkStore();
  const kind = `test_lease_${run}`;
  const first = await store.claimMany(kind, ["k1"], `${run}-dead`, 50);
  assert.deepEqual([...first], ["k1"]);
  assert.equal((await store.claimMany(kind, ["k1"], `${run}-live`, 60_000)).size, 0, "a live lease is respected");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual([...(await store.claimMany(kind, ["k1"], `${run}-live`, 60_000))], ["k1"], "an expired lease is reclaimed");
  await store.completeMany(kind, [{ key: "k1", value: { ok: true } }], `${run}-live`, 60_000);
  assert.deepEqual((await store.getMany(kind, ["k1"])).get("k1"), { ok: true });
  assert.equal((await store.claimMany(kind, ["k1"], `${run}-other`, 60_000)).size, 0, "a finished result is not re-run");
});

test("concurrent workers cannot both reserve an allowance that fits only one call", { skip: !hasDb }, async () => {
  await ensureReleaseCSchema();
  const workerA = new AccountLedger(new PostgresLedgerStore());
  const workerB = new AccountLedger(new PostgresLedgerStore());
  const account = policy("reserve");
  const [a, b] = await Promise.all([workerA.reserve(account, 6, false), workerB.reserve(account, 6, false)]);
  assert.equal([a, b].filter((decision) => decision.ok).length, 1, "only one 6-page call fits a 10-page allowance");
  assert.ok([a, b].every((decision) => decision.durable));
  const winner = a.ok ? a : b;
  await workerA.recordUsage(account, 6, "success");
  winner.release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = await workerB.reserve(account, 6, false);
  assert.equal(after.ok, false, "recorded usage still blocks a second 6-page call");
  const small = await workerB.reserve(account, 4, false);
  assert.equal(small.ok, true);
  small.release();
});

test("a reservation held by a crashed worker expires instead of blocking the account", { skip: !hasDb }, async () => {
  await ensureReleaseCSchema();
  const previous = process.env.PROVIDER_RESERVATION_TTL_MS;
  process.env.PROVIDER_RESERVATION_TTL_MS = "10000";
  try {
    const account = policy("crash");
    const crashed = await new AccountLedger(new PostgresLedgerStore()).reserve(account, 8, false);
    assert.equal(crashed.ok, true);
    // Never released (the worker died). Another worker is blocked while the hold is live...
    assert.equal((await new AccountLedger(new PostgresLedgerStore()).reserve(account, 8, false)).ok, false);
    // ...and recovers once it expires.
    await sql(`UPDATE provider_account_reservations SET expires_at = now() - interval '1 second' WHERE account_id = $1`, [
      `${account.pool}:${account.slot}`,
    ]);
    const recovered = await new AccountLedger(new PostgresLedgerStore()).reserve(account, 8, false);
    assert.equal(recovered.ok, true);
    recovered.release();
  } finally {
    if (previous == null) delete process.env.PROVIDER_RESERVATION_TTL_MS;
    else process.env.PROVIDER_RESERVATION_TTL_MS = previous;
  }
});

test("billable-capable accounts fail closed when accounting is not durable", async () => {
  const memory = new MemoryLedgerStore();
  const offline: LedgerStore = {
    load: (id) => memory.load(id),
    save: (state) => memory.save(state),
    list: (pool) => memory.list(pool),
    atomic: (_id, work) => work({ load: (id) => memory.load(id), save: (state) => memory.save(state), durable: false }),
  };
  const ledger = new AccountLedger(offline);
  const billable = await ledger.reserve(policy("billable"), 1, false);
  assert.equal(billable.ok, false);
  assert.match(billable.reason, /durable accounting unavailable/);
  const freeOnly = await ledger.reserve(policy("free", { overageBillable: false }), 1, false);
  assert.equal(freeOnly.ok, true, "an account that cannot bill keeps working on in-process accounting");
  freeOnly.release();

  process.env.PROVIDER_ACCOUNTING_FAIL_CLOSED = "false";
  try {
    assert.equal((await ledger.reserve(policy("billable"), 1, false)).ok, true, "the flag can relax it explicitly");
  } finally {
    delete process.env.PROVIDER_ACCOUNTING_FAIL_CLOSED;
  }
});

test("in-process reservations still apply for stores without durable holds", async () => {
  const memory = new MemoryLedgerStore();
  const plain: LedgerStore = { load: (id) => memory.load(id), save: (state) => memory.save(state), list: (pool) => memory.list(pool) };
  const ledger = new AccountLedger(plain);
  const account = policy("plain", { overageBillable: false });
  const [a, b] = await Promise.all([ledger.reserve(account, 6, false), ledger.reserve(account, 6, false)]);
  assert.equal([a, b].filter((decision) => decision.ok).length, 1);
});

test("discovery candidates from several providers are consolidated before any page fetch or AI call", () => {
  const stats = (results: number) => ({ youResults: results, exaResults: 0, queryPlan: { keyword: 1, generated: 0, profile: 4 } }) as unknown as WebDiscoveryBatch["stats"];
  const batch = (candidates: WebDiscoveryBatch["candidates"], results: number): WebDiscoveryBatch => ({
    candidates,
    stats: stats(results),
    errors: [],
    publishedAfterMs: Date.parse("2026-09-01"),
  });
  const a = batch(
    [
      { title: "Medical exams RFP", url: "https://www.city.gov/bids/123/?utm_source=x", content: "short", sourceProvider: "you" },
      { title: "Other", url: "https://county.gov/rfp/9", content: "other", sourceProvider: "you" },
    ],
    2,
  );
  const b = batch([{ title: "Medical exams RFP", url: "https://city.gov/bids/123", content: "a much longer snippet with scope", sourceProvider: "exa" }], 1);
  const merged = mergeWebDiscoveryBatches([
    { provider: "you", batch: a },
    { provider: "exa", batch: b },
  ]);
  assert.equal(merged.candidates.length, 2);
  const shared = merged.candidates.find((candidate) => candidate.url.includes("city.gov/bids"))!;
  assert.deepEqual(shared.foundBy, ["you", "exa"]);
  assert.match(shared.content, /longer snippet/, "the richest snippet is kept");
  assert.equal(consolidatedDuplicateCount([{ batch: a }, { batch: b }], merged), 1);
  assert.equal(merged.stats.youResults, 3, "per-provider result counters are summed");
});

test("purpose budgets are separate and stop a pool when its purpose is used up", async () => {
  clearPurposeBudgetsForTests();
  clearLimitedProviderPoolState();
  assert.equal(purposeForPool("opportunity-web-discovery"), "search");
  assert.equal(purposeForPool("opportunity-page-enrichment"), "page_extraction");
  assert.equal(purposeForPool("opportunity-ai-extraction"), "ai_evaluation");
  assert.equal(purposeForPool("llmwhisperer"), "ocr");
  process.env.OPPORTUNITY_BUDGET_PAGE_EXTRACTION_DAILY_CALLS = "2";
  try {
    let calls = 0;
    const attempt = { name: "reader", isConfigured: async () => true, run: async () => `page ${++calls}` };
    for (let index = 0; index < 2; index += 1) {
      const result = await runLimitedProviderPool("opportunity-page-enrichment", [attempt]);
      assert.equal(result.provider, "reader");
    }
    const blocked = await runLimitedProviderPool("opportunity-page-enrichment", [attempt]);
    assert.equal(blocked.value, null);
    assert.match(blocked.recoveredErrors.join(" "), /page_extraction budget for today is used \(2\/2/);
    assert.equal(calls, 2);
    assert.equal((await purposeAllows("search")).ok, true, "search keeps its own budget");
  } finally {
    delete process.env.OPPORTUNITY_BUDGET_PAGE_EXTRACTION_DAILY_CALLS;
    clearPurposeBudgetsForTests();
    clearLimitedProviderPoolState();
  }
});

test("a rate-limit cooldown survives a restart when durable coordination is on", { skip: !hasDb }, async () => {
  await ensureReleaseCSchema();
  process.env.OPPORTUNITY_SHARED_WORK_DURABLE = "true";
  const poolId = `orchestration-cooldown-${run}`;
  try {
    clearLimitedProviderPoolState();
    let calls = 0;
    const attempt = {
      name: "searcher",
      isConfigured: async () => true,
      run: async () => {
        calls += 1;
        throw new Error("HTTP 429 Too Many Requests");
      },
    };
    await runLimitedProviderPool(poolId, [attempt]);
    assert.equal(calls, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    clearLimitedProviderPoolState(); // a restart loses every in-memory cooldown
    const afterRestart = await runLimitedProviderPool(poolId, [attempt]);
    assert.equal(calls, 1, "the provider is not re-hit after the restart");
    assert.deepEqual(afterRestart.skippedCooldown, ["searcher"]);
  } finally {
    delete process.env.OPPORTUNITY_SHARED_WORK_DURABLE;
    clearLimitedProviderPoolState();
    clearPurposeBudgetsForTests();
    await sql(`DELETE FROM provider_pool_cooldowns WHERE pool_provider LIKE $1`, [`${poolId}:%`]).catch(() => undefined);
  }
});

test("concurrent calls on a pool with a per-account limit go to different accounts", async () => {
  clearFreeTierCredentialPoolState();
  process.env.TEST_PARALLEL_KEY_1 = "account-one";
  process.env.TEST_PARALLEL_KEY_2 = "account-two";
  const pool = new FreeTierCredentialPool(
    "parallel-assignment-test",
    [{ envKey: "TEST_PARALLEL_KEY_1" }, { envKey: "TEST_PARALLEL_KEY_2" }],
    { rotateOnSuccess: false, maxConcurrentPerAccount: 1 },
  );
  const used = await Promise.all(
    [0, 1].map(() =>
      pool.run(async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return key;
      }),
    ),
  );
  assert.deepEqual(used.sort(), ["account-one", "account-two"]);
  // Sequential calls stay on the active account (sticky pools are unchanged).
  assert.equal(await pool.run(async (key) => key), "account-one");
});
