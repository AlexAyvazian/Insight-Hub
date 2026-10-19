import "../../search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import test from "node:test";
import { rankGovConRecords, isOccuMedFit } from "../govconIntelligence";
import { HARD_NEGATIVES, HARD_POSITIVES } from "../../search/__tests__/support/opportunityAuditCorpus";

for (const mode of ["forecast", "recompete"] as const) {
  test(`${mode}: broad NAICS alone and physical-security scope are not Occu-Med fits`, async () => {
    const records = [
      { id: "finance", title: "Federal Financial Systems Support Services", description: "Financial reporting, accounting systems and programmatic support", naics: "541611", agency: "Example Agency" },
      { id: "security", title: "MISSION CRITICAL: SAFEGUARDING THE FEDERAL JUDICIAL PROCESS, PROVIDING PHYSICAL SECURITY IN COURTS", description: "Protect judges, attorneys and court personnel. Security officers provide screening and physical security services.", agency: "Example Agency" },
      ...HARD_NEGATIVES.map(record => ({ ...record, agency: "Example Agency" })),
    ];
    const ranked = await rankGovConRecords(records, mode);
    assert.deepEqual(ranked.filter(isOccuMedFit), []);
    assert.ok(ranked.every(record => record.relevance.profileSource === "neon"));
    assert.ok(ranked.every(record => record.relevance.profileVersion.length > 0));
  });
  test(`${mode}: legitimate purchased occupational-health services stay visible`, async () => {
    const ranked = await rankGovConRecords(HARD_POSITIVES.map(record => ({ ...record, agency: "Example Agency" })), mode);
    const missing = ranked.filter(record => !isOccuMedFit(record));
    assert.deepEqual(missing.map(record => ({ id: record.id, reasons: record.relevance.reasons })), []);
  });
}
