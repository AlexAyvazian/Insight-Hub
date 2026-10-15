import "./support/useFixtureProfile";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyTestingTypes } from "../testingTypes";
import { getRelevanceProfile } from "../relevanceProfile";
import { matchedServiceLines } from "../profileServiceLines";

function primary(title: string, body = ""): string | null {
  return classifyTestingTypes({ title, body }).primary;
}

describe("testing-type grouping", () => {
  it("splits distinct testing types into distinct groups", () => {
    const cases: Array<[string, string, string]> = [
      ["Drug and alcohol testing services for municipal employees", "", "Drug / alcohol"],
      ["Respirator fit testing and medical evaluations", "OSHA respiratory protection program", "Respiratory"],
      ["Audiometric testing for hearing conservation program", "", "Hearing"],
      ["Pre-employment physical examinations for new hires", "", "Pre-employment"],
    ];
    const groups = new Set<string>();
    for (const [title, body, expectedFragment] of cases) {
      const result = primary(title, body);
      assert.ok(result, `no testing type for: ${title}`);
      assert.ok(
        result!.toLowerCase().includes(expectedFragment.toLowerCase()),
        `"${title}" grouped as "${result}", expected a type containing "${expectedFragment}"`,
      );
      groups.add(result!);
    }
    assert.equal(groups.size, cases.length, "each testing type must land in its own group");
  });

  it("does not let the umbrella category swallow specific records", () => {
    const umbrella = getRelevanceProfile().categories[0]?.label;
    assert.ok(umbrella);
    const specific = [
      "Drug and alcohol testing services",
      "Respirator fit testing",
      "Audiometric testing for hearing conservation program",
      "Pre-employment physical examinations",
      "Immunization services and mobile vaccination clinic for employees",
      "Medical surveillance program for hazardous exposure",
      "Fitness for duty evaluations",
    ];
    const landedInUmbrella = specific.filter((title) => primary(title) === umbrella);
    assert.deepEqual(landedInUmbrella, []);
  });

  it("keeps the umbrella category for genuinely general occupational health notices", () => {
    assert.equal(
      primary("Occupational health services"),
      getRelevanceProfile().categories[0]?.label,
    );
  });

  it("returns every evidenced type, best first, and primary is the first", () => {
    const result = classifyTestingTypes({
      title: "Drug and alcohol testing and pre-employment physicals",
    });
    assert.ok(result.all.length >= 2, "a multi-service notice evidences more than one type");
    assert.equal(result.primary, result.all[0]);
  });

  it("returns null when the text evidences no service", () => {
    const result = classifyTestingTypes({ title: "Lawn mowing and landscaping services" });
    assert.deepEqual(result, { primary: null, all: [] });
  });

  it("is a refinement of the existing service-line evidence, never a new vocabulary", () => {
    const text = "Drug and alcohol testing services for municipal employees";
    const lines = new Set(matchedServiceLines(text));
    const result = classifyTestingTypes({ title: text });
    for (const label of result.all) {
      assert.ok(lines.has(label), `"${label}" is not an evidenced service line`);
    }
  });
});
