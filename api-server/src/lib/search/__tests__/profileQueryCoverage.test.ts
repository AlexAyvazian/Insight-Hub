/**
 * Task 07 (F-11, F-24): every bundle term and every profile service family must be searched over a bounded,
 * reproducible cycle; AI-generated queries may not crowd out canonical profile coverage. Vocabulary comes only
 * from the profile; these builders only schedule it.
 */
import { fixtureProfile } from "./support/useFixtureProfile";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coverageGapCategories,
  profileBooleanQueries,
  profileNaturalQueries,
  queryRotationCursor,
  queryRotationCycleDays,
  rotatingWindow,
  spreadSample,
} from "../profileWebQueries";
import { profileServiceQueryGroups } from "../profileQueries";
import { MAX_DISCOVERY_QUERIES, MAX_GENERATED_QUERIES, planDiscoveryQueries } from "../webIntelligence";

const profile = fixtureProfile();
const plain = (t: string) => t.replace(/"/g, "").toLowerCase().trim();

describe("rotating profile query coverage", () => {
  const cycle = queryRotationCycleDays(profile);

  it("the cycle is bounded (days) and every bundle term is queried within it", () => {
    assert.ok(cycle >= 1 && cycle <= 14, `cycle ${cycle}`);
    const issued = plain(Array.from({ length: cycle }, (_, day) => profileBooleanQueries(2026, profile, day).join(" ")).join(" "));
    for (const bundle of profile.searchBundles.filter((b) => b.serviceTerms.length > 0)) {
      for (const term of bundle.serviceTerms) {
        assert.ok(issued.includes(plain(term)), `${bundle.key}: "${term}" never queried`);
      }
    }
  });

  it("terms after position 3 are no longer permanently excluded", () => {
    const longBundle = profile.searchBundles.find((b) => b.serviceTerms.length > 3)!;
    const late = plain(longBundle.serviceTerms[longBundle.serviceTerms.length - 1]!);
    assert.ok(!profileBooleanQueries(2026, profile, 0).join(" ").toLowerCase().includes(late) ||
      profileBooleanQueries(2026, profile, 1).join(" ").toLowerCase().includes(late));
    const anyDay = Array.from({ length: cycle }, (_, d) => profileBooleanQueries(2026, profile, d).join(" ").toLowerCase());
    assert.ok(anyDay.some((q) => q.includes(late)));
  });

  it("service families with no search bundle get coverage queries from their own profile phrases", () => {
    const gaps = coverageGapCategories(profile);
    assert.ok(gaps.length > 0, "fixture profile has unbundled families (audit F-11)");
    const ids = gaps.map((g) => g.id);
    for (const expected of ["hearing_audiometry", "respiratory_fit_testing", "immunizations_travel", "lab_diagnostic_components"]) {
      assert.ok(ids.includes(expected), `${expected} should be detected as a gap`);
    }
    const issued = Array.from({ length: cycle }, (_, d) => profileNaturalQueries(2026, profile, d).join(" ").toLowerCase()).join(" ");
    for (const gap of gaps) {
      assert.ok(gap.explicit.some((t) => issued.includes(plain(t))), `${gap.id} never searched`);
    }
  });

  it("every non-adjacent service family is represented by a bundle or a coverage query", () => {
    const gaps = new Set(coverageGapCategories(profile).map((g) => g.id));
    const bundleText = profile.searchBundles.flatMap((b) => b.serviceTerms).map(plain).join(" | ");
    for (const category of profile.categories.filter((c) => !c.adjacentOnly && c.id !== profile.networkCategoryId && c.explicit.length > 0)) {
      const bundled = [...category.explicit, ...category.component].map(plain).some((p) => p.length >= 5 && bundleText.includes(p));
      assert.ok(bundled || gaps.has(category.id), `${category.id} has no executable query family`);
    }
  });

  it("Bonfire-style OR groups rotate too", () => {
    const day0 = profileServiceQueryGroups(profile, 3, 0).join(" ");
    const day1 = profileServiceQueryGroups(profile, 3, 1).join(" ");
    assert.notEqual(day0, day1);
  });

  it("rotation is deterministic for a date and windows wrap", () => {
    const now = Date.UTC(2026, 9, 18);
    assert.equal(queryRotationCursor(now), queryRotationCursor(now + 3_600_000));
    assert.deepEqual(rotatingWindow([1, 2, 3, 4, 5], 2, 2), [5, 1]);
  });

  it("spreadSample with a cursor reaches every item over the cycle", () => {
    const items = Array.from({ length: 14 }, (_, i) => i);
    const seen = new Set<number>();
    for (let c = 0; c < items.length; c++) for (const x of spreadSample(items, 4, c)) seen.add(x);
    assert.equal(seen.size, items.length);
    assert.deepEqual(spreadSample(items, 4), spreadSample(items, 4, 0), "default behavior unchanged");
  });
});

describe("bounded discovery query plan", () => {
  const profileQueries = profileNaturalQueries(2026, profile, 0);

  it("AI-generated queries are capped and cannot starve profile coverage", () => {
    const generated = Array.from({ length: 20 }, (_, i) => `generated query ${i}`);
    const plan = planDiscoveryQueries([], generated, profileQueries, 0);
    assert.ok(plan.length <= MAX_DISCOVERY_QUERIES);
    assert.equal(plan.filter((q) => q.startsWith("generated")).length, MAX_GENERATED_QUERIES);
    assert.equal(plan.filter((q) => profileQueries.includes(q)).length, MAX_DISCOVERY_QUERIES - MAX_GENERATED_QUERIES);
  });

  it("user keyword queries come first and the per-run total is unchanged", () => {
    const plan = planDiscoveryQueries(["kw a", "kw b"], ["g1"], profileQueries, 3);
    assert.deepEqual(plan.slice(0, 3), ["kw a", "kw b", "g1"]);
    assert.equal(plan.length, MAX_DISCOVERY_QUERIES);
  });

  it("profile queries rotate across runs so all bundles are reached", () => {
    const seen = new Set<string>();
    for (let c = 0; c < profileQueries.length; c++) for (const q of planDiscoveryQueries([], [], profileQueries, c)) seen.add(q);
    assert.equal(seen.size, profileQueries.length);
  });
});
