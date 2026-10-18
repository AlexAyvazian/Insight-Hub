import "./support/useFixtureProfile";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OccuMedReferenceModel } from "../../occumedAware/types";
import {
  buildExamplesBlock,
  buildProfileBlock,
  renderPromptContext,
} from "../occumedPromptContext";
import { buildReviewPrompt, reviewPromptCharLimit } from "../structuredOpportunityDecision";
import { buildPrompt } from "../structuredOpportunityJudge";

const ref = (overrides: Partial<OccuMedReferenceModel> = {}): OccuMedReferenceModel => ({
  builtAt: new Date().toISOString(),
  awareLoaded: true,
  legalName: "OCCU-MED, LTD.",
  dba: "Occu-Med Health Solutions",
  uei: "", cage: "", headquarters: "Fresno, CA",
  networkLocations: "", countriesCovered: "", employeesEvaluatedAnnually: "", publicSafetyClients: "",
  primaryNaics: "541612",
  additionalNaics: ["621111"],
  productServiceCodes: ["Q301"],
  documentedCapabilities: ["Pre-employment physicals"],
  arrangeableCapabilities: ["Overseas clinic coordination"],
  allActiveCapabilities: [],
  rfpDirectPhrases: ["fitness for duty evaluation"],
  rfpReviewPhrases: ["medical support services"],
  rfpRegulatoryRefs: ["OSHA 1910.1020"],
  hardRules: [{
    rule_key: "no_fuel_testing", category: "scope", title: "No equipment or fuel",
    rule_text: "Reject purchases of testing kits, fuel and equipment.", machine_action: null,
    hard_rule: true, priority: 1, status: "active", authority_level: "official",
  }],
  allRules: [],
  agentPolicies: [{
    policy_key: "p1", applies_to: "judge", title: "Open only",
    instruction: "Only approve notices currently accepting responses.", must_follow: true, priority: 1,
  }],
  semanticProfile: "", promptServiceList: ["Occupational medicine"], promptClientTypes: [],
  promptCompanyContext: "", workersCompInstruction: "Workers comp treatment is out of scope.",
  imeInstruction: "IME only in an employment context.",
  ...overrides,
});

const record = {
  externalId: "x", title: "Testing kit", agency: "DEPT OF THE ARMY", type: "Solicitation",
  status: "active" as const, postedDate: new Date(), source: "tango" as const,
};

describe("Occu-Med prompt context", () => {
  it("renders the live profile: phrases, codes, hard rules and must-follow policies", () => {
    const block = buildProfileBlock(ref());
    assert.match(block, /fitness for duty evaluation/);
    assert.match(block, /541612/);
    assert.match(block, /Q301/);
    // Rules and policies are rendered once, from the Neon profile, by judgeScopeBlock (not from the legacy reference model).
    assert.doesNotMatch(block, /HARD RULES:/);
    assert.doesNotMatch(block, /No equipment or fuel/);
    assert.match(block, /Overseas clinic coordination/);
  });

  it("renders nothing when the live profile is not loaded, so prompts fall back", () => {
    assert.equal(buildProfileBlock(ref({ awareLoaded: false })), "");
  });

  it("renders team-graded examples as wanted and unwanted", () => {
    const block = buildExamplesBlock([
      { title: "Occupational Health Services", agency: "VA", grade: "excellent" },
      { title: "TESTING KIT, AVIATION PETROLEUM", agency: "ARMY", grade: "spam" },
    ]);
    assert.match(block, /Relevant, wanted:[\s\S]*Occupational Health Services/);
    assert.match(block, /Not relevant, unwanted:[\s\S]*AVIATION PETROLEUM/);
    assert.equal(buildExamplesBlock([]), "");
  });

  it("puts the profile and examples into the judge prompts, and not when empty", () => {
    const context = renderPromptContext({
      profileBlock: buildProfileBlock(ref()),
      examplesBlock: "EXAMPLES GRADED BY THE OCCU-MED TEAM: x",
      profileLoaded: true,
    });
    for (const prompt of [buildReviewPrompt([record], context), buildPrompt("tango", [record], context)]) {
      assert.match(prompt, /OCCU-MED REFERENCE PROFILE/);
      assert.match(prompt, /EXAMPLES GRADED BY THE OCCU-MED TEAM/);
      assert.match(prompt, /ITEMS:/);
      assert.equal((prompt.match(/OCCU-MED SCOPE RULES AND POLICIES/g) ?? []).length, 1);
      assert.match(prompt, /HARD RULES:[\s\S]*POLICIES YOU MUST FOLLOW:/);
    }
    for (const prompt of [buildReviewPrompt([record]), buildPrompt("tango", [record])]) {
      assert.doesNotMatch(prompt, /OCCU-MED REFERENCE PROFILE/);
      assert.match(prompt, /Workers[’']? compensation/);
      assert.equal((prompt.match(/OCCU-MED SCOPE RULES AND POLICIES/g) ?? []).length, 1);
    }
  });

  it("states the workers' comp scope rule once in the decision prompt", () => {
    const occurrences = buildReviewPrompt([record]).match(/IMPORTANT: Workers/g) ?? [];
    assert.equal(occurrences.length, 0);
  });
  it("fits a size-limited judge's prompt by trimming record text, keeping every record and the instructions", () => {
    const long = (n: number) => `Statement of work. ${"Occupational health physicals for employees. ".repeat(n)}END-OF-TEXT`;
    const records = [0, 1, 2].map((i) => ({ ...record, externalId: `x${i}`, title: `Physicals ${i}`, description: long(400) }));
    const full = buildReviewPrompt(records);
    const limit = reviewPromptCharLimit("groq")!;
    assert.ok(full.length > limit, "fixture must exceed the Groq limit");
    const fitted = buildReviewPrompt(records, "", limit);
    assert.ok(fitted.length <= limit, `fitted prompt ${fitted.length} > ${limit}`);
    for (const i of [0, 1, 2]) assert.match(fitted, new RegExp(`\\[${i}\\]\\nTitle: Physicals ${i}`));
    assert.match(fitted, /Return only JSON/);
    // Fences carry a random id, so compare sizes: a prompt under the limit is not trimmed.
    assert.equal(buildReviewPrompt([record], "", limit).length, buildReviewPrompt([record]).length);
    assert.equal(reviewPromptCharLimit("cerebras"), undefined);
  });
});
