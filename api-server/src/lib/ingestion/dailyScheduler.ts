/**
 * Daily procurement run.
 *
 * Starts the same persisted ingestion run the "Fetch Intelligence" button starts, once per day at a fixed UTC slot.
 * It reuses `startManualIngestion`, so every existing protection applies unchanged: the database advisory lock that
 * allows only one active run, stale-run recovery, per-provider deadlines, quota-aware provider selection, and the
 * canonical relevance decision.
 *
 * Durability: the last handled slot is stored in the settings table, so a restart, a deploy at 10:00, or a second
 * instance cannot cause a duplicate run for the same slot, and a server that was down at the slot catches up on boot
 * (within the configured window).
 */
import { eq } from "drizzle-orm";
import { rfpDb, settingsTable } from "@workspace/db";
import { logger } from "../logger";
import { getRelevanceProfile } from "../search/relevanceProfile";
import {
  ActiveIngestionRunError,
  getIngestionRun,
  startManualIngestion,
  type IngestionRunView,
  type StartIngestionRequest,
} from "./manualIngestion";
import {
  EXTRA_PORTAL_PASS_PROVIDERS,
  decideSlot,
  nextSlot,
  readDailyScheduleConfig,
  type DailyScheduleConfig,
} from "./dailySchedule";

const STATE_KEY = "ingestion-schedule:v1";
const FIRST_CHECK_DELAY_MS = 90_000;
const EXTRA_PASS_POLL_MS = 15_000;
const EXTRA_PASS_MAX_WAIT_MS = 25 * 60_000;
const TERMINAL_EXCLUDED = new Set(["queued", "running"]);

export interface ScheduleState {
  lastSlot: string | null;
  lastOutcome: "started" | "skipped" | "completed" | null;
  lastRunId: string | null;
  lastStartedAt: string | null;
  note: string | null;
}

const BLANK_STATE: ScheduleState = {
  lastSlot: null,
  lastOutcome: null,
  lastRunId: null,
  lastStartedAt: null,
  note: null,
};

export interface SchedulerDependencies {
  now: () => Date;
  loadState: () => Promise<ScheduleState>;
  saveState: (state: ScheduleState) => Promise<void>;
  startRun: (request: StartIngestionRequest) => Promise<IngestionRunView>;
  getRun: (runId: string) => Promise<IngestionRunView | null>;
  profileReady: () => boolean;
  sleep: (ms: number) => Promise<void>;
}

async function loadPersistedState(): Promise<ScheduleState> {
  const [row] = await rfpDb
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, STATE_KEY))
    .limit(1);
  if (!row) return { ...BLANK_STATE };
  try {
    const parsed = JSON.parse(row.value) as Partial<ScheduleState>;
    return { ...BLANK_STATE, ...parsed };
  } catch {
    return { ...BLANK_STATE };
  }
}

async function savePersistedState(state: ScheduleState): Promise<void> {
  const value = JSON.stringify(state);
  await rfpDb
    .insert(settingsTable)
    .values({ key: STATE_KEY, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
}

export const defaultSchedulerDependencies: SchedulerDependencies = {
  now: () => new Date(),
  loadState: loadPersistedState,
  saveState: savePersistedState,
  startRun: (request) => startManualIngestion(request),
  getRun: (runId) => getIngestionRun(runId),
  // Running while the Neon relevance profile is unavailable would quarantine every record, so wait instead.
  profileReady: () => getRelevanceProfile().source !== "unavailable",
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type TickResult =
  | { status: "disabled" }
  | { status: "idle"; reason: string }
  | { status: "waiting"; reason: string }
  | { status: "skipped"; slot: string }
  | { status: "started"; slot: string; runId: string };

/** One scheduler check. Exported so the behavior is testable with injected dependencies. */
export async function runSchedulerTick(
  config: DailyScheduleConfig,
  deps: SchedulerDependencies,
): Promise<TickResult> {
  if (!config.enabled) return { status: "disabled" };
  const now = deps.now();
  const state = await deps.loadState();
  const decision = decideSlot(now, state.lastSlot, config);

  if (decision.action === "wait") {
    return { status: "idle", reason: decision.reason };
  }

  const slotIso = decision.slot.toISOString();

  if (decision.action === "skip") {
    await deps.saveState({
      ...state,
      lastSlot: slotIso,
      lastOutcome: "skipped",
      note: "Slot missed and the catch-up window had passed.",
    });
    logger.warn({ slot: slotIso }, "Scheduled ingestion slot skipped");
    return { status: "skipped", slot: slotIso };
  }

  if (!deps.profileReady()) {
    return { status: "waiting", reason: "relevance_profile_unavailable" };
  }

  let run: IngestionRunView;
  try {
    run = await deps.startRun({});
  } catch (error) {
    if (error instanceof ActiveIngestionRunError) {
      // A manual run is in progress. Leave the slot unhandled so the next check starts the scheduled run.
      return { status: "waiting", reason: "ingestion_run_active" };
    }
    throw error;
  }

  await deps.saveState({
    lastSlot: slotIso,
    lastOutcome: "started",
    lastRunId: run.id,
    lastStartedAt: deps.now().toISOString(),
    note: null,
  });
  logger.info({ slot: slotIso, runId: run.id }, "Scheduled ingestion run started");

  if (config.extraPortalPasses > 0) {
    void runExtraPortalPasses(config, deps, run.id).catch((error) => {
      logger.error({ error }, "Scheduled extra portal passes failed");
    });
  }
  return { status: "started", slot: slotIso, runId: run.id };
}

async function waitForRun(
  deps: SchedulerDependencies,
  runId: string,
): Promise<void> {
  const deadline = deps.now().getTime() + EXTRA_PASS_MAX_WAIT_MS;
  while (deps.now().getTime() < deadline) {
    const run = await deps.getRun(runId);
    if (!run || !TERMINAL_EXCLUDED.has(run.status)) return;
    await deps.sleep(EXTRA_PASS_POLL_MS);
  }
}

/**
 * Each public-portal run only visits one rotation batch of the verified portal catalog, so extra passes widen the
 * daily coverage. They run the rotating portal source only, never the quota-limited federal APIs again.
 */
async function runExtraPortalPasses(
  config: DailyScheduleConfig,
  deps: SchedulerDependencies,
  firstRunId: string,
): Promise<void> {
  let previousRunId = firstRunId;
  for (let pass = 1; pass <= config.extraPortalPasses; pass += 1) {
    await waitForRun(deps, previousRunId);
    try {
      const run = await deps.startRun({
        providers: [...EXTRA_PORTAL_PASS_PROVIDERS],
      });
      previousRunId = run.id;
      logger.info({ pass, runId: run.id }, "Scheduled extra portal pass started");
    } catch (error) {
      if (error instanceof ActiveIngestionRunError) {
        logger.warn({ pass }, "Extra portal pass stopped: another run is active");
        return;
      }
      throw error;
    }
  }
}

export interface DailySchedulerHandle {
  stop: () => void;
}

export function startDailyIngestionScheduler(
  config: DailyScheduleConfig = readDailyScheduleConfig(),
  deps: SchedulerDependencies = defaultSchedulerDependencies,
): DailySchedulerHandle {
  if (!config.enabled) {
    logger.info(
      "Daily ingestion scheduler disabled (set SCHEDULED_INGESTION_ENABLED=true to enable)",
    );
    return { stop: () => undefined };
  }

  logger.info(
    {
      hourUtc: config.hourUtc,
      minuteUtc: config.minuteUtc,
      extraPortalPasses: config.extraPortalPasses,
      nextSlot: nextSlot(deps.now(), config).toISOString(),
    },
    "Daily ingestion scheduler enabled",
  );

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runSchedulerTick(config, deps);
    } catch (error) {
      logger.error({ error }, "Daily ingestion scheduler check failed");
    } finally {
      busy = false;
    }
  };

  const first = setTimeout(() => void tick(), FIRST_CHECK_DELAY_MS);
  first.unref?.();
  const interval = setInterval(() => void tick(), config.checkIntervalMs);
  interval.unref?.();

  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(interval);
    },
  };
}

export interface SchedulerStatus {
  enabled: boolean;
  hourUtc: number;
  minuteUtc: number;
  extraPortalPasses: number;
  nextSlot: string;
  state: ScheduleState;
}

export async function getDailySchedulerStatus(
  config: DailyScheduleConfig = readDailyScheduleConfig(),
  deps: Pick<SchedulerDependencies, "now" | "loadState"> =
    defaultSchedulerDependencies,
): Promise<SchedulerStatus> {
  return {
    enabled: config.enabled,
    hourUtc: config.hourUtc,
    minuteUtc: config.minuteUtc,
    extraPortalPasses: config.extraPortalPasses,
    nextSlot: nextSlot(deps.now(), config).toISOString(),
    state: await deps.loadState(),
  };
}
