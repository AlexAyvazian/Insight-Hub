/**
 * Lazy access to the RFP pool for Release C modules, so importing them (for pure helpers such as review priority or
 * the requirement ledger) never requires a database URL at module load. Tests and pure callers stay DB-free.
 */
import type { rfpPool as RfpPool } from "@workspace/db";

let pool: typeof RfpPool | null = null;

export async function rcPool(): Promise<typeof RfpPool> {
  if (!pool) pool = (await import("@workspace/db")).rfpPool;
  return pool;
}
