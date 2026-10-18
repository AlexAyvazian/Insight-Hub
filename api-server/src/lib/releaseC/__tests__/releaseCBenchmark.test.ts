/**
 * Release C benchmark gate. Runs the deterministic Opportunities pipeline over benchmark/dataset.json (repository
 * fixtures, adversarial cases and production records with two blind AI reference labels) and fails when:
 * - any synthetic fixture or adversarial case misses its exact expectation;
 * - any gate-eligible case fails that is not a recorded pre-existing failure;
 * - any gate metric drops below the recorded baseline.
 *
 * AI reference labels are model output. They are never treated as human-validated, and only cases where both
 * blind reviewers agreed at high confidence AND an independent signal supports the label are gate-eligible.
 */
import "../../search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { getRelevanceProfile } from "../../search/relevanceProfile";
import { runBenchmark, type BenchmarkCase, type GroupMetrics } from "../benchmark/harness";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = <T>(name: string): T => JSON.parse(fs.readFileSync(path.resolve(here, "../benchmark", name), "utf8")) as T;
const dataset = read<{ version: string; cases: BenchmarkCase[] }>("dataset.json");
const baseline = read<{
  gate: Partial<Record<keyof GroupMetrics, number>>;
  knownGateFailures: string[];
  knownMissedOpportunities: string[];
}>("baseline.json");
const { report, results } = runBenchmark(dataset.cases, dataset.version, getRelevanceProfile().version);

describe("Release C benchmark dataset", () => {
  it("has about 350 cases, each with label provenance and no human-validated claim", () => {
    assert.ok(dataset.cases.length >= 340, `only ${dataset.cases.length} cases`);
    const allowed = new Set(["synthetic_fixture", "synthetic_adversarial", "ai_reference_agreed", "ai_reference_adjudicated"]);
    for (const c of dataset.cases) {
      assert.ok(allowed.has(c.provenance), `${c.caseId} provenance ${c.provenance}`);
      assert.doesNotMatch(c.explanation, /human[- ]validated|gold label/i, c.caseId);
    }
    assert.equal(new Set(dataset.cases.map((c) => c.caseId)).size, dataset.cases.length);
  });

  it("only gates AI-labelled cases with two agreeing high-confidence reviewers and independent support", () => {
    for (const c of dataset.cases.filter((x) => x.provenance.startsWith("ai_reference") && x.gateEligible)) {
      assert.equal(c.provenance, "ai_reference_agreed", c.caseId);
      assert.equal(c.confidence, "high", c.caseId);
      assert.ok(c.independentSupport.length > 0, c.caseId);
    }
  });
});

describe("Release C benchmark gate", () => {
  it("meets every synthetic fixture and adversarial expectation", () => {
    const failed = results.filter((r) => r.provenance.startsWith("synthetic") && !r.meetsExpectation).map((r) => `${r.caseId}:${r.expectation}->${r.verdict}`);
    assert.deepEqual(failed, []);
  });

  it("introduces no new gate failure or missed opportunity", () => {
    const known = new Set(baseline.knownGateFailures);
    assert.deepEqual(report.gate.expectationFailures.filter((id) => !known.has(id)), []);
    const knownMissed = new Set(baseline.knownMissedOpportunities);
    assert.deepEqual(report.gate.missedOpportunities.filter((id) => !knownMissed.has(id)), []);
  });

  it("keeps every gate metric at or above the recorded baseline", () => {
    for (const [metric, floor] of Object.entries(baseline.gate)) {
      const value = report.gate[metric as keyof GroupMetrics] as number | null;
      assert.ok(value !== null && value + 0.001 >= (floor as number), `${metric} ${value} < baseline ${floor}`);
    }
  });
});
