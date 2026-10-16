import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPIRING_OFFICIAL_AWARDS_SQL, SAM_EARLY_NOTICE_SQL,
  loadLocalOfficialSignals, normalizeExpiringAward, normalizeSamEarlyNotice,
} from "../localOfficialSignals";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const early = {
  id: "sam-notice-1", notice_id: "SAM001", title: "Upcoming base medical services",
  agency: "Department of Defense", type: "Sources Sought", status: "active",
  posted_date: "2026-10-14", response_deadline: "2026-11-15",
  description: "Military workforce medical examinations", naics_code: "621111",
  sam_url: "https://sam.gov/opp/SAM001/view",
};
const award = {
  award_key: "usaspending:123", source: "usaspending", recipient_text: "Leidos Inc.",
  awarding_agency: "Department of Defense", amount: 5000000,
  action_date: "2026-09-15", completion_date: "2027-08-30",
  description: "Deployment support services", source_url: "https://www.usaspending.gov/award/123",
};

test("SAM early notices stay labeled as early signals with no invented forecast or award date", () => {
  const record = normalizeSamEarlyNotice(early, NOW);
  assert.ok(record);
  assert.equal(record.source, "sam.gov early notice");
  assert.equal(record.estimatedSolicitationDate, null, "sources sought response deadline is not forecast solicitation date");
  assert.equal(record.estimatedAwardFiscalYear, null);
  assert.match(String(record.description), /not a formal agency acquisition forecast/i);
  assert.equal(normalizeSamEarlyNotice({ ...early, type: "Award Notice" }, NOW), null);
  assert.equal(normalizeSamEarlyNotice({ ...early, response_deadline: "2026-01-01" }, NOW), null);
});

test("only official awards naming an incumbent with a real near-future end date become possible recompete signals", () => {
  const record = normalizeExpiringAward(award, NOW);
  assert.ok(record);
  assert.equal(record.incumbentName, "Leidos Inc.");
  assert.equal((record.incumbentAward as { expires: string }).expires, "2027-08-30");
  assert.equal(record.recompeteEvidence, "incumbent-award");
  assert.match(String(record.description), /rebid or solicitation has NOT been confirmed/i);
  assert.equal(normalizeExpiringAward({ ...award, recipient_text: null }, NOW), null);
  assert.equal(normalizeExpiringAward({ ...award, completion_date: null }, NOW), null);
  assert.equal(normalizeExpiringAward({ ...award, completion_date: "2019-01-01" }, NOW), null);
  assert.equal(normalizeExpiringAward({ ...award, completion_date: "2035-01-01" }, NOW), null);
});

test("both portals reuse database statements only, with no network calls", async () => {
  const sqls: string[] = [];
  const run = async (sql: string) => {
    sqls.push(sql);
    return sql === SAM_EARLY_NOTICE_SQL ? [early] : [award];
  };
  const forecasts = await loadLocalOfficialSignals("forecast", run, NOW);
  const recompetes = await loadLocalOfficialSignals("recompete", run, NOW);
  assert.equal(forecasts.records.length, 1);
  assert.equal(recompetes.records.length, 1);
  assert.equal(sqls.filter(sql => sql === SAM_EARLY_NOTICE_SQL).length, 1);
  assert.equal(sqls.filter(sql => sql === EXPIRING_OFFICIAL_AWARDS_SQL).length, 1);
  assert.match(SAM_EARLY_NOTICE_SQL, /FROM sam_gov_intelligence_notices/);
  assert.match(EXPIRING_OFFICIAL_AWARDS_SQL, /company_watch_awards/);
  const unavailable = await loadLocalOfficialSignals("forecast", async () => { throw new Error("secret"); }, NOW);
  assert.equal(unavailable.records.length, 0);
  assert.ok(unavailable.errors[0]?.includes("Neon"));
  assert.ok(!JSON.stringify(unavailable).includes("secret"));
});
