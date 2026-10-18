import "./support/useFixtureProfile";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AI_EXTRACTION_PROVIDER_ORDER,
  MAX_EXTRACTION_CACHE_ENTRIES,
  extractOpportunitiesBatch,
  shouldCrossCheckExtraction,
  type AiExtraction,
} from "../aiExtract";
import {
  CloudflareWorkersAiClient,
  normalizeCloudflareRerankScore,
} from "../../providers/cloudflareWorkersAi";
import {
  applySourceFairness,
  cosineSimilarity,
  finalizeSemanticPriority,
  titleTokenJaccard,
} from "../candidateSemanticPriority";
import { occumedSemanticProfile } from "../semanticRerank";
import { getRelevanceProfile } from "../relevanceProfile";
import { profileClientTypes, profileServiceLabels } from "../profileText";

function accepted(overrides: Partial<AiExtraction> = {}): AiExtraction {
  return {
    isOpportunity: true,
    title: "Occupational Health Services RFP",
    agency: "State Procurement Office",
    description:
      "Open procurement for pre-employment physical examinations, drug testing, audiograms, and respiratory fit testing.",
    deadline: "2026-09-01",
    relevanceScore: 88,
    relevanceReason: "Direct fit for Occu-Med services.",
    ...overrides,
  };
}

describe("coordinated AI search intelligence stack", () => {
  it("keeps every configured trial AI available in the extraction fallback pool", () => {
    assert.deepEqual(AI_EXTRACTION_PROVIDER_ORDER, [
      "cloudflare-workers-ai",
      "cerebras",
      "groq",
      "gemini",
      "openrouter",
      "mistral",
      "deepseek",
      "nvidia",
      "minimax",
      "clod",
    ]);
  });

  it("keeps the long-lived extraction cache hard bounded", () => {
    assert.ok(MAX_EXTRACTION_CACHE_ENTRIES > 0);
    assert.ok(MAX_EXTRACTION_CACHE_ENTRIES <= 256);
  });

  it("stops AI extraction immediately when its parent run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("manual ingestion cancelled"));
    await assert.rejects(
      extractOpportunitiesBatch([], controller.signal),
      /manual ingestion cancelled/,
    );
  });

  it("propagates cancellation into every AI extraction transport", async () => {
    const providerFiles = [
      "groq.ts",
      "gemini.ts",
      "openrouter.ts",
      "openAiCompatible.ts",
      "minimax.ts",
      "clod.ts",
    ];
    for (const file of providerFiles) {
      const source = await readFile(
        path.resolve(process.cwd(), `src/lib/providers/${file}`),
        "utf8",
      );
      assert.match(source, /signal\??:\s*AbortSignal/);
      assert.match(source, /AbortSignal\.(?:any|timeout)/);
    }

    const extractionSource = await readFile(
      path.resolve(process.cwd(), "src/lib/search/aiExtract.ts"),
      "utf8",
    );
    assert.match(extractionSource, /provider\.complete\(prompt, maxTokens, attemptSignal\)/);
  });

  it("cross-checks only ambiguous accepted records", () => {
    assert.equal(shouldCrossCheckExtraction(accepted()), false);
    assert.equal(
      shouldCrossCheckExtraction(accepted({ relevanceScore: 62 })),
      true,
    );
    assert.equal(
      shouldCrossCheckExtraction(accepted({ agency: undefined })),
      true,
    );
    assert.equal(
      shouldCrossCheckExtraction({
        isOpportunity: false,
        reason: "Award notice",
      }),
      false,
    );
  });

  it("normalizes Cloudflare reranker output to a stable 0..1 range", () => {
    assert.equal(normalizeCloudflareRerankScore(0.75), 0.75);
    assert.ok(normalizeCloudflareRerankScore(5) > 0.99);
    assert.ok(normalizeCloudflareRerankScore(-5) < 0.01);
    assert.equal(normalizeCloudflareRerankScore("not-a-number"), 0);
  });

  it("stops Cloudflare calls after a 401 and leaves fallbacks available", async () => {
    const originalFetch = globalThis.fetch;
    const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
    let calls = 0;

    process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
    process.env.CLOUDFLARE_API_TOKEN = "invalid-token";
    globalThis.fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
        { status: 401 },
      );
    };

    try {
      const client = new CloudflareWorkersAiClient();
      await assert.rejects(
        client.rerank("occupational health", ["open RFP"]),
        /disabled until the service restarts/,
      );
      assert.equal(await client.isConfigured(), false);
      assert.equal(await client.embed(["second call"]), null);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAccountId === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
      }
      if (originalApiToken === undefined) {
        delete process.env.CLOUDFLARE_API_TOKEN;
      } else {
        process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
      }
    }
  });

  it("computes semantic similarity and removes near-identical duplicate notices", () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.ok(
      titleTokenJaccard(
        "Occupational Health Services Request for Proposals",
        "Request for Proposals - Occupational Health Services",
      ) > 0.8,
    );

    const result = finalizeSemanticPriority(
      [
        {
          title: "Occupational Health Services Request for Proposals",
          url: "https://example.gov/rfp/1",
          content: "Open RFP for employee medical surveillance and testing.",
          sourceProvider: "serper",
        },
        {
          title: "Request for Proposals Occupational Health Services",
          url: "https://mirror.example.gov/rfp/1",
          content: "Open RFP for employee medical surveillance and testing.",
          sourceProvider: "exa",
        },
        {
          title: "Fleet Vehicle Maintenance Bid",
          url: "https://example.gov/rfp/2",
          content: "Maintenance services for municipal vehicles.",
          sourceProvider: "serper",
        },
      ],
      [
        [1, 0],
        [0.999, 0.001],
        [0, 1],
      ],
      [1, 0],
      new Map([[0, 0.98]]),
      20,
    );

    assert.equal(result.applied, true);
    // Resemblance alone is not identity: the mirror is kept as a potential match, not discarded.
    assert.equal(result.duplicatesRemoved, 0);
    assert.equal(result.potentialDuplicates, 1);
    assert.equal(result.candidates.length, 3);
    assert.ok(
      [
        "Occupational Health Services Request for Proposals",
        "Request for Proposals Occupational Health Services",
      ].includes(result.candidates[0]?.title ?? ""),
    );
    assert.ok((result.candidates[0]?.cloudflareSemanticScore ?? 0) > 95);
  });

  it("removes a near-identical candidate only when it states the same solicitation number", () => {
    const result = finalizeSemanticPriority(
      [
        {
          title: "Occupational Health Services Request for Proposals",
          url: "https://example.gov/rfp/1",
          content: "Solicitation No. 36C26226Q0042. Open RFP for employee medical surveillance.",
          sourceProvider: "serper",
        },
        {
          title: "Request for Proposals Occupational Health Services",
          url: "https://mirror.example.gov/rfp/1",
          content: "Solicitation No. 36C26226Q0042. Open RFP for employee medical surveillance.",
          sourceProvider: "exa",
        },
        {
          title: "Request for Proposals Occupational Health Services",
          url: "https://example.gov/rfp/9",
          content: "Solicitation No. 36C26226Q0077. Open RFP for employee medical surveillance.",
          sourceProvider: "exa",
        },
      ],
      [
        [1, 0],
        [0.999, 0.001],
        [0.998, 0.002],
      ],
      [1, 0],
      new Map(),
      20,
    );
    assert.equal(result.duplicatesRemoved, 1);
    assert.equal(result.candidates.length, 2);
    assert.ok(result.candidates.some((c) => c.url === "https://example.gov/rfp/9"), "a different solicitation number is a separate procurement");
  });

  it("prevents one close-scoring source from monopolizing the AI budget", () => {
    const ordered = applySourceFairness([
      ...Array.from({ length: 5 }, (_, index) => ({
        candidate: {
          title: `Serper ${index}`,
          url: `https://serper.example/${index}`,
          content: "occupational health procurement",
          sourceProvider: "serper",
        },
        finalScore: 0.99 - index * 0.01,
      })),
      {
        candidate: {
          title: "Exa candidate",
          url: "https://exa.example/1",
          content: "occupational health procurement",
          sourceProvider: "exa",
        },
        finalScore: 0.94,
      },
    ]);

    assert.equal(ordered[4]?.candidate.sourceProvider, "exa");
  });

  it("renders the semantic search profile from the relevance profile's service lines and buyers", () => {
    const profile = getRelevanceProfile();
    const text = occumedSemanticProfile(profile);
    for (const label of profileServiceLabels(profile)) assert.ok(text.includes(label), label);
    for (const buyer of profileClientTypes(profile)) assert.ok(text.includes(buyer), buyer);
  });

  it("cross-checks accepted records scoring below the canonical accept threshold", () => {
    const { acceptMin } = getRelevanceProfile().thresholds;
    assert.equal(shouldCrossCheckExtraction(accepted({ relevanceScore: acceptMin - 1 })), true);
    assert.equal(shouldCrossCheckExtraction(accepted({ relevanceScore: acceptMin })), false);
  });
});
