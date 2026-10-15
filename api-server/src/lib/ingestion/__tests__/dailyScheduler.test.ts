import assert from "node:assert/strict";
import test from "node:test";

process.env.RFP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.INTEL_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.AUTH_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.APP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const {
  decideSlot,
  mostRecentSlot,
  nextSlot,
  readDailyScheduleConfig,
} = await import("../dailySchedule");
const { runSchedulerTick } = await import("../dailyScheduler");
const { ActiveIngestionRunError } = await import("../manualIngestion");

const config = readDailyScheduleConfig({
  SCHEDULED_INGESTION_ENABLED: "true",
  SCHEDULED_INGESTION_HOUR_UTC: "10",
  SCHEDULED_INGESTION_MINUTE_UTC: "0",
});

test("configuration defaults: on only in production, bounded values", () => {
  assert.equal(readDailyScheduleConfig({}).enabled, false);
  assert.equal(readDailyScheduleConfig({ NODE_ENV: "production" }).enabled, true);
  assert.equal(
    readDailyScheduleConfig({
      NODE_ENV: "production",
      SCHEDULED_INGESTION_ENABLED: "false",
    }).enabled,
    false,
  );
  const bounded = readDailyScheduleConfig({
    SCHEDULED_INGESTION_HOUR_UTC: "99",
    SCHEDULED_INGESTION_MINUTE_UTC: "-4",
    SCHEDULED_INGESTION_EXTRA_PORTAL_PASSES: "50",
    SCHEDULED_INGESTION_CATCH_UP_HOURS: "abc",
  });
  assert.equal(bounded.hourUtc, 23);
  assert.equal(bounded.minuteUtc, 0);
  assert.equal(bounded.extraPortalPasses, 6);
  assert.equal(bounded.catchUpWindowMs, 12 * 60 * 60_000);
});

test("slot math: before the slot uses yesterday's, after it uses today's", () => {
  assert.equal(
    mostRecentSlot(new Date("2026-10-14T09:59:00Z"), config).toISOString(),
    "2026-10-13T10:00:00.000Z",
  );
  assert.equal(
    mostRecentSlot(new Date("2026-10-14T10:00:00Z"), config).toISOString(),
    "2026-10-14T10:00:00.000Z",
  );
  assert.equal(
    nextSlot(new Date("2026-10-14T12:00:00Z"), config).toISOString(),
    "2026-10-15T10:00:00.000Z",
  );
});

test("runs once per slot, catches up after downtime, skips stale slots", () => {
  const due = decideSlot(new Date("2026-10-14T10:05:00Z"), null, config);
  assert.equal(due.action, "run");

  const handled = decideSlot(
    new Date("2026-10-14T10:30:00Z"),
    "2026-10-14T10:00:00.000Z",
    config,
  );
  assert.deepEqual(
    { action: handled.action, reason: (handled as any).reason },
    { action: "wait", reason: "already_handled" },
  );

  // Server was down at the slot and came back 6 hours later: still within the 12h window.
  const catchUp = decideSlot(
    new Date("2026-10-14T16:00:00Z"),
    "2026-10-13T10:00:00.000Z",
    config,
  );
  assert.equal(catchUp.action, "run");

  // Came back 13.5 hours after the slot (window is 12h): skip rather than fire a stale run.
  const stale = decideSlot(
    new Date("2026-10-14T23:30:00Z"),
    "2026-10-13T10:00:00.000Z",
    config,
  );
  assert.equal(stale.action, "skip");

  assert.equal(
    decideSlot(new Date("2026-10-14T10:05:00Z"), null, { ...config, enabled: false })
      .action,
    "wait",
  );
});

function makeDeps(overrides: Record<string, unknown> = {}) {
  let saved: any = null;
  const started: any[] = [];
  const deps = {
    now: () => new Date("2026-10-14T10:05:00Z"),
    loadState: async () =>
      saved ?? {
        lastSlot: null,
        lastOutcome: null,
        lastRunId: null,
        lastStartedAt: null,
        note: null,
      },
    saveState: async (state: any) => {
      saved = state;
    },
    startRun: async (request: any) => {
      started.push(request);
      return { id: `run-${started.length}`, status: "queued" } as any;
    },
    getRun: async () => ({ status: "completed" }) as any,
    profileReady: () => true,
    sleep: async () => undefined,
    ...overrides,
  };
  return { deps: deps as any, started, getSaved: () => saved };
}

test("tick starts one run and records the slot so a second tick does nothing", async () => {
  const { deps, started, getSaved } = makeDeps();
  const first = await runSchedulerTick(config, deps);
  assert.equal(first.status, "started");
  assert.equal(started.length, 1);
  assert.deepEqual(started[0], {});
  assert.equal(getSaved().lastSlot, "2026-10-14T10:00:00.000Z");
  assert.equal(getSaved().lastRunId, "run-1");

  const second = await runSchedulerTick(config, deps);
  assert.equal(second.status, "idle");
  assert.equal(started.length, 1);
});

test("tick waits (without consuming the slot) when a manual run is active", async () => {
  const { deps, getSaved } = makeDeps({
    startRun: async () => {
      throw new ActiveIngestionRunError("manual-run");
    },
  });
  const result = await runSchedulerTick(config, deps);
  assert.deepEqual(result, { status: "waiting", reason: "ingestion_run_active" });
  assert.equal(getSaved(), null);
});

test("tick waits when the relevance profile is unavailable", async () => {
  const { deps, started } = makeDeps({ profileReady: () => false });
  const result = await runSchedulerTick(config, deps);
  assert.deepEqual(result, {
    status: "waiting",
    reason: "relevance_profile_unavailable",
  });
  assert.equal(started.length, 0);
});

test("tick records a skipped slot instead of running a stale one", async () => {
  const { deps, started, getSaved } = makeDeps({
    now: () => new Date("2026-10-14T23:00:00Z"),
  });
  const result = await runSchedulerTick(config, deps);
  assert.equal(result.status, "skipped");
  assert.equal(started.length, 0);
  assert.equal(getSaved().lastOutcome, "skipped");
});

test("extra portal passes run only the rotating portal source", async () => {
  const withPasses = { ...config, extraPortalPasses: 2 };
  const { deps, started } = makeDeps();
  await runSchedulerTick(withPasses, deps);
  // The extra passes are chained in the background; let them settle.
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(started[0], {});
  assert.deepEqual(started.slice(1), [
    { providers: ["aiDiscovery"] },
    { providers: ["aiDiscovery"] },
  ]);
});
