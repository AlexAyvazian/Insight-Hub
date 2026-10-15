/**
 * Pure scheduling rules for the daily procurement run.
 *
 * Kept free of database and network imports so the timing logic can be unit tested without any environment.
 * The runtime that applies these rules lives in `dailyScheduler.ts`.
 */

export interface DailyScheduleConfig {
  /** Whether the scheduler runs at all. */
  enabled: boolean;
  /** UTC hour of the daily slot (0-23). */
  hourUtc: number;
  /** UTC minute of the daily slot (0-59). */
  minuteUtc: number;
  /**
   * How long after a slot began a missed slot may still be caught up (server was down or a manual run was active).
   * Past this window the slot is skipped and the next one is awaited, so a late boot never fires a stale run.
   */
  catchUpWindowMs: number;
  /** Extra back-to-back portal-rotation passes after the main run (0 disables). Each pass advances the portal rotation. */
  extraPortalPasses: number;
  /** How often the scheduler checks whether a slot is due. */
  checkIntervalMs: number;
}

const HOUR_MS = 60 * 60_000;

function boundedInt(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

/**
 * Reads the schedule from the environment.
 *
 *   SCHEDULED_INGESTION_ENABLED          "true" | "false"  (default: on in production, off elsewhere)
 *   SCHEDULED_INGESTION_HOUR_UTC         0-23              (default 10, about 6am US Eastern)
 *   SCHEDULED_INGESTION_MINUTE_UTC       0-59              (default 17)
 *   SCHEDULED_INGESTION_CATCH_UP_HOURS   1-23              (default 12)
 *   SCHEDULED_INGESTION_EXTRA_PORTAL_PASSES 0-6            (default 0)
 */
export function readDailyScheduleConfig(
  env: Record<string, string | undefined> = process.env,
): DailyScheduleConfig {
  const flag = env.SCHEDULED_INGESTION_ENABLED?.trim().toLowerCase();
  const enabled =
    flag === "true" || flag === "1"
      ? true
      : flag === "false" || flag === "0"
        ? false
        : env.NODE_ENV === "production";
  return {
    enabled,
    hourUtc: boundedInt(env.SCHEDULED_INGESTION_HOUR_UTC, 10, 0, 23),
    minuteUtc: boundedInt(env.SCHEDULED_INGESTION_MINUTE_UTC, 17, 0, 59),
    catchUpWindowMs:
      boundedInt(env.SCHEDULED_INGESTION_CATCH_UP_HOURS, 12, 1, 23) * HOUR_MS,
    extraPortalPasses: boundedInt(
      env.SCHEDULED_INGESTION_EXTRA_PORTAL_PASSES,
      0,
      0,
      6,
    ),
    checkIntervalMs: 5 * 60_000,
  };
}

/** The most recent slot start at or before `now` (today's slot once it has passed, otherwise yesterday's). */
export function mostRecentSlot(now: Date, config: DailyScheduleConfig): Date {
  const today = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      config.hourUtc,
      config.minuteUtc,
      0,
      0,
    ),
  );
  if (today.getTime() <= now.getTime()) return today;
  return new Date(today.getTime() - 24 * HOUR_MS);
}

/** The first slot start strictly after `now`. */
export function nextSlot(now: Date, config: DailyScheduleConfig): Date {
  return new Date(mostRecentSlot(now, config).getTime() + 24 * HOUR_MS);
}

export type SlotDecision =
  | { action: "wait"; slot: Date; reason: "disabled" | "already_handled" }
  | { action: "skip"; slot: Date; reason: "catch_up_window_passed" }
  | { action: "run"; slot: Date };

/**
 * Decides what to do for the current moment.
 *
 * `lastHandledSlotIso` is the slot the scheduler last started (or deliberately skipped), persisted durably so a
 * restart, a second instance, or a deploy in the middle of the day cannot cause a second run for the same slot.
 */
export function decideSlot(
  now: Date,
  lastHandledSlotIso: string | null,
  config: DailyScheduleConfig,
): SlotDecision {
  const slot = mostRecentSlot(now, config);
  if (!config.enabled) return { action: "wait", slot, reason: "disabled" };
  const last = lastHandledSlotIso ? Date.parse(lastHandledSlotIso) : NaN;
  if (Number.isFinite(last) && last >= slot.getTime()) {
    return { action: "wait", slot, reason: "already_handled" };
  }
  if (now.getTime() - slot.getTime() > config.catchUpWindowMs) {
    return { action: "skip", slot, reason: "catch_up_window_passed" };
  }
  return { action: "run", slot };
}

/** Providers for each extra portal-rotation pass: only the rotating portal source, never the quota-limited federal APIs. */
export const EXTRA_PORTAL_PASS_PROVIDERS = ["aiDiscovery"] as const;
