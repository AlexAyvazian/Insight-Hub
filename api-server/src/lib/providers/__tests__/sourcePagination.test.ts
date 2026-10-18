import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { paginateOffsets } from "../sourcePagination";
import { CHECKPOINT_MAX_AGE_MS, resumePoint, type QueryCheckpoint } from "../../releaseC/queryCheckpoints";

function source(total: number) {
  const offsets: number[] = [];
  return {
    offsets,
    fetchPage: async (offset: number) => {
      offsets.push(offset);
      const rows = Array.from({ length: Math.max(0, Math.min(10, total - offset)) }, (_, i) => offset + i);
      return { records: rows.filter((n) => n % 2 === 0), rawReturned: rows.length, totalRecords: total };
    },
  };
}

describe("offset pagination with completeness accounting", () => {
  it("reads every page up to the source total and reports the query complete", async () => {
    const s = source(25);
    const outcome = await paginateOffsets({ pageSize: 10, maxPages: 5, fetchPage: s.fetchPage });
    assert.deepEqual(s.offsets, [0, 10, 20]);
    assert.equal(outcome.complete, true);
    assert.equal(outcome.rawReturned, 25);
    assert.equal(outcome.nextOffset, 25);
  });

  it("advances by rows returned, not rows kept after filtering", async () => {
    const s = source(30);
    const outcome = await paginateOffsets({ pageSize: 10, maxPages: 3, fetchPage: s.fetchPage });
    assert.deepEqual(s.offsets, [0, 10, 20]);
    assert.equal(outcome.records.length, 15);
  });

  it("stops at the page budget and says where to resume instead of claiming completeness", async () => {
    const s = source(45);
    const outcome = await paginateOffsets({ pageSize: 10, maxPages: 2, fetchPage: s.fetchPage });
    assert.equal(outcome.complete, false);
    assert.equal(outcome.nextOffset, 20);
    const next = await paginateOffsets({ pageSize: 10, maxPages: 5, startOffset: outcome.nextOffset, fetchPage: s.fetchPage });
    assert.equal(next.complete, true);
    assert.deepEqual(s.offsets, [0, 10, 20, 30, 40]);
  });

  it("keeps pages fetched before a failure and reports the failed offset", async () => {
    const s = source(50);
    const outcome = await paginateOffsets({
      pageSize: 10,
      maxPages: 5,
      fetchPage: async (offset) => {
        if (offset === 20) throw new Error("SAM.gov API error 429: quota/throttle reached.");
        return s.fetchPage(offset);
      },
    });
    assert.equal(outcome.complete, false);
    assert.equal(outcome.nextOffset, 20);
    assert.equal(outcome.records.length, 10);
    assert.match(String((outcome.error as Error).message), /429/);
  });
});

describe("query checkpoint resume point", () => {
  const base: QueryCheckpoint = {
    source: "samGov",
    queryKey: "ncode:621111",
    nextOffset: 2000,
    totalRecords: 3100,
    windowFrom: "09/18/2026",
    windowTo: "10/18/2026",
    complete: false,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };

  it("resumes an unfinished query at its offset and original date window", () => {
    assert.deepEqual(resumePoint(base), { offset: 2000, windowFrom: "09/18/2026", windowTo: "10/18/2026", resumed: true });
  });

  it("starts fresh after a complete query, a stale checkpoint, or none", () => {
    assert.equal(resumePoint(null).offset, 0);
    assert.equal(resumePoint({ ...base, complete: true }).resumed, false);
    const stale = { ...base, updatedAt: new Date(Date.now() - CHECKPOINT_MAX_AGE_MS - 1000).toISOString() };
    assert.equal(resumePoint(stale).resumed, false);
  });
});
