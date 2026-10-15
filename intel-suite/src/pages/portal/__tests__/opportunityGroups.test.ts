import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UNCATEGORIZED_GROUP,
  additionalTestingTypes,
  groupByTestingType,
  primaryTestingType,
} from "../opportunityGroups";

const opp = (id: string, category?: string | null, testingTypes?: string[]) => ({
  id,
  relevance: category === undefined ? null : { category, testingTypes },
});

describe("testing-type grouping", () => {
  it("groups by the server-assigned primary type, largest group first", () => {
    const groups = groupByTestingType([
      opp("1", "Audiometry"),
      opp("2", "Drug / alcohol testing"),
      opp("3", "Drug / alcohol testing"),
      opp("4", "Immunizations"),
      opp("5", "Drug / alcohol testing"),
      opp("6", "Immunizations"),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.type, g.items.length]),
      [
        ["Drug / alcohol testing", 3],
        ["Immunizations", 2],
        ["Audiometry", 1],
      ],
    );
  });

  it("keeps server rank order inside a group and first-seen order on ties", () => {
    const groups = groupByTestingType([
      opp("a", "Immunizations"),
      opp("b", "Audiometry"),
      opp("c", "Immunizations"),
      opp("d", "Audiometry"),
    ]);
    assert.deepEqual(groups.map((g) => g.type), ["Immunizations", "Audiometry"]);
    assert.deepEqual(groups[0].items.map((o) => o.id), ["a", "c"]);
  });

  it("always puts Uncategorized last, even when it is the largest group", () => {
    const groups = groupByTestingType([
      opp("1", null),
      opp("2", null),
      opp("3", undefined),
      opp("4", "Audiometry"),
    ]);
    assert.deepEqual(groups.map((g) => g.type), ["Audiometry", UNCATEGORIZED_GROUP]);
    assert.equal(groups[1].items.length, 3);
  });

  it("filters to one testing type without disturbing the others' data", () => {
    const list = [opp("1", "Audiometry"), opp("2", "Immunizations")];
    const filtered = groupByTestingType(list, "Immunizations");
    assert.deepEqual(filtered.map((g) => g.type), ["Immunizations"]);
    assert.equal(groupByTestingType(list, "Does not exist").length, 0);
  });

  it("lists the other types a notice covers, excluding the primary", () => {
    const multi = opp("m", "Drug / alcohol testing", [
      "Drug / alcohol testing",
      "Pre-employment exams",
      "Audiometry",
    ]);
    assert.equal(primaryTestingType(multi), "Drug / alcohol testing");
    assert.deepEqual(additionalTestingTypes(multi), ["Pre-employment exams", "Audiometry"]);
    assert.deepEqual(additionalTestingTypes(opp("x", "Audiometry")), []);
    assert.deepEqual(additionalTestingTypes({ relevance: { testingTypes: "bad" } }), []);
  });
});
