import { fixtureProfile, installFixtureProfile } from "./support/useFixtureProfile";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { occumedDefaultQueries, occumedProfileView, occumedScopeSummary, geminiProvider } from "../../providers/gemini";
import { groqProvider } from "../../providers/groq";
import { openrouterProvider } from "../../providers/openrouter";
import { minimaxProvider } from "../../providers/minimax";
import { clodProvider } from "../../providers/clod";
import { scoreWithMultipleAIs } from "../multiScorer";
import { buildBatchPrompt } from "../aiExtract";
import { matchedServiceLines } from "../profileServiceLines";
import {
  keywordQueries,
  coverageGapCategories,
  profileBooleanQueries,
  profileExclusionOperators,
  profileNaturalQueries,
  spreadSample,
} from "../profileWebQueries";
import { judgeScopeBlock, profileClientTypes, profileDefaultQueries, profileServiceLabels } from "../profileText";
import { getRelevanceProfile, setRelevanceProfile, type RelevanceProfile } from "../relevanceProfile";

afterEach(() => {
  installFixtureProfile();
});

function withThresholds(acceptMin: number, reviewMin: number): RelevanceProfile {
  const base = fixtureProfile();
  return { ...base, thresholds: { acceptMin, reviewMin } };
}

describe("provider prompts are rendered from the relevance profile", () => {
  it("occumedProfileView and default queries mirror the profile helpers", () => {
    const view = occumedProfileView();
    assert.deepEqual(view.services, profileServiceLabels());
    assert.deepEqual(view.clientTypes, profileClientTypes());
    assert.deepEqual(occumedDefaultQueries(2031), profileDefaultQueries(2031));
    assert.ok(occumedDefaultQueries(2031).every((q) => q.includes("2031")));
  });

  it("scope summary carries every service label and the profile scope rules", () => {
    const summary = occumedScopeSummary();
    for (const label of profileServiceLabels()) assert.ok(summary.includes(label), label);
    assert.ok(summary.includes(judgeScopeBlock()));
  });

  it("reads the profile at call time, not at module load", () => {
    const base = fixtureProfile();
    const custom: RelevanceProfile = {
      ...base,
      categories: base.categories.map((c, i) => (i === 0 ? { ...c, label: "Zebra Wellness Line" } : c)),
    };
    assert.equal(setRelevanceProfile(custom).applied, true);
    assert.ok(occumedScopeSummary().includes("Zebra Wellness Line"));
    assert.ok(buildBatchPrompt([], "2026-01-01").includes("Zebra Wellness Line"));
  });

  it("provider extraction prompts carry the scope block and canonical score guidance", async () => {
    const captured: string[] = [];
    const providers = [geminiProvider, groqProvider, openrouterProvider, minimaxProvider, clodProvider] as unknown as Array<{
      complete: (prompt: string) => Promise<string>;
      isConfigured: () => Promise<boolean>;
      extractOpportunityFromWebResult: (t: string, u: string, c: string) => Promise<unknown>;
    }>;
    const originals = providers.map((p) => ({ complete: p.complete, isConfigured: p.isConfigured }));
    providers.forEach((p) => {
      p.complete = async (prompt: string) => {
        captured.push(prompt);
        return "{}";
      };
      p.isConfigured = async () => true;
    });
    try {
      for (const p of providers) await p.extractOpportunityFromWebResult("t", "https://x.example", "c");
    } finally {
      providers.forEach((p, i) => Object.assign(p, originals[i]));
    }
    assert.equal(captured.length, providers.length);
    const { acceptMin } = getRelevanceProfile().thresholds;
    for (const prompt of captured) {
      assert.ok(prompt.includes(judgeScopeBlock()));
      assert.ok(prompt.includes(`${acceptMin} or above`));
    }
  });
});

describe("multi-scorer uses the canonical thresholds", () => {
  function stubScorers(scores: Array<number | null>) {
    const targets = [geminiProvider, groqProvider, openrouterProvider, minimaxProvider] as unknown as Array<{ scoreRelevance: unknown }>;
    const originals = targets.map((t) => t.scoreRelevance);
    targets.forEach((t, i) => {
      const score = scores[i];
      t.scoreRelevance = async () => (score === null || score === undefined ? null : { score, explanation: "stub" });
    });
    return () => targets.forEach((t, i) => (t.scoreRelevance = originals[i]));
  }

  it("a vote passes exactly at acceptMin and not below it", async () => {
    setRelevanceProfile(withThresholds(70, 45));
    const restore = stubScorers([70, 69, null, null]);
    try {
      const result = await scoreWithMultipleAIs("t", "d", "union");
      assert.deepEqual(result.votes.map((v) => [v.scorer, v.passed]), [["gemini", true], ["groq", false]]);
      assert.equal(result.passed, true);
    } finally {
      restore();
    }
  });

  it("has no second averaged-score gate: majority votes decide", async () => {
    setRelevanceProfile(withThresholds(70, 45));
    const restore = stubScorers([95, 71, 0, null]);
    try {
      const result = await scoreWithMultipleAIs("t", "d", "majority");
      assert.equal(result.passed, true);
      assert.ok(result.finalScore < 70);
    } finally {
      restore();
    }
  });

  it("falls back to reviewMin when every scorer fails", async () => {
    setRelevanceProfile(withThresholds(80, 52));
    const restore = stubScorers([null, null, null, null]);
    try {
      const result = await scoreWithMultipleAIs("t", "d");
      assert.equal(result.finalScore, 52);
      assert.equal(result.winnerScorer, "fallback");
    } finally {
      restore();
    }
  });
});

describe("service lines and web queries come from the profile", () => {
  it("detects service lines as profile category labels", () => {
    const labels = new Set(profileServiceLabels());
    const category = fixtureProfile().categories.find((c) => !c.adjacentOnly && c.explicit.length > 0)!;
    const lines = matchedServiceLines(`Request for the ${category.explicit[0]} for county employees`);
    assert.ok(lines.includes(category.label));
    assert.ok(lines.every((l) => labels.has(l)));
    assert.deepEqual(matchedServiceLines("Janitorial supplies and paving"), []);
  });

  it("matches plurals but not mid-word hits", () => {
    const p = fixtureProfile();
    const custom: RelevanceProfile = {
      ...p,
      categories: [{ id: "x", label: "Audio line", adjacentOnly: false, explicit: ["audiogram"], component: [], regulatory: [] }],
    };
    assert.deepEqual(matchedServiceLines("annual audiograms", { profile: custom }), ["Audio line"]);
    assert.deepEqual(matchedServiceLines("megaaudiogram", { profile: custom }), []);
  });

  it("builds one boolean and one natural query per service bundle (plus unbundled families) from the profile", () => {
    const profile = fixtureProfile();
    const bundles = profile.searchBundles.filter((b) => b.serviceTerms.length > 0);
    // Cursor 0 starts every bundle's rotation at its first term; unbundled families follow the bundles.
    const boolean = profileBooleanQueries(2030, undefined, 0);
    const natural = profileNaturalQueries(2030, undefined, 0);
    const gaps = coverageGapCategories(profile).length;
    assert.equal(boolean.length, bundles.length + gaps);
    assert.equal(natural.length, bundles.length + gaps);
    bundles.forEach((b, i) => {
      assert.ok(boolean[i]!.includes(b.serviceTerms[0]!));
      assert.ok(boolean[i]!.includes("2030"));
      assert.ok(natural[i]!.includes(b.serviceTerms[0]!.replace(/"/g, "")));
    });
  });

  it("derives exclusion operators from the profile's exclusion rules", () => {
    const ops = profileExclusionOperators();
    const postAward = getRelevanceProfile().rules.find((r) => r.action === "reject_post_award_notice")!;
    assert.ok(ops.includes(`-"${postAward.triggers[0]}"`));
  });

  it("keyword queries keep the keyword and spreadSample covers the list", () => {
    assert.ok(keywordQueries("zzz keyword", 2030).every((q) => q.includes("zzz keyword")));
    assert.deepEqual(spreadSample([1, 2, 3, 4, 5, 6, 7, 8], 4), [1, 3, 5, 7]);
    assert.deepEqual(spreadSample([1, 2], 4), [1, 2]);
  });
});
