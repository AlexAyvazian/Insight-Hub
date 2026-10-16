import assert from "node:assert/strict";
import test from "node:test";
import { cacheableSamNotice, saveSamIntelligenceNotices } from "../samNoticeCache";
import type { SamOpportunity } from "../../providers/samGovQuality";

test("SAM captures early and named award notices but never changes the bid-ready RFP set", async () => {
  const raw: SamOpportunity[] = [
    { noticeId: "source-1", type: "Sources Sought", title: "Medical capability", postedDate: "2026-10-10" },
    { noticeId: "pre-1", type: "Presolicitation", title: "Future healthcare work" },
    { noticeId: "award-1", type: "Award", title: "Medical services award", award: { amount: 10000, awardee: { name: "Leidos Inc." } } },
    { noticeId: "bid-1", type: "Solicitation", title: "Open competition" },
    { noticeId: "award-no-name", type: "Award", title: "Anonymous award" },
  ];
  assert.deepEqual(raw.map(cacheableSamNotice), [true, true, true, false, false]);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const run = async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; };
  assert.equal(await saveSamIntelligenceNotices(run, raw), 3);
  const insert = calls.find(call => call.sql.startsWith("INSERT INTO sam_gov_intelligence_notices"));
  assert.ok(insert);
  assert.equal(insert.params.length, 3 * 14);
  assert.match(insert.sql, /ON CONFLICT \(notice_id\) DO UPDATE/);
  assert.doesNotMatch(insert.sql, /first_seen_at\s*=/);
  assert.ok(insert.params.includes("Leidos Inc."));
  assert.ok(!insert.params.includes("bid-1"));
  assert.equal((insert.sql.match(/\$\d+/g) ?? []).length, insert.params.length);
});
