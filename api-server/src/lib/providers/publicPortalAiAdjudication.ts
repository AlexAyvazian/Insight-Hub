import { getRelevanceProfile } from "../search/relevanceProfile";
import type { NormalizedOpportunity, ProviderFetchResult } from "./types";
import { extractOpportunitiesBatch, type AiExtraction } from "../search/aiExtract";
import {
  prioritizeCandidatesWithCloudflare,
  type PrioritizedCandidate,
  type SemanticPriorityCandidate,
} from "../search/candidateSemanticPriority";

const DEFAULT_AI_LIMIT = 160;
const MAX_AI_LIMIT = 300;

type PortalAiCandidate = SemanticPriorityCandidate & {
  record: NormalizedOpportunity;
};

function positiveIntegerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function stringTags(record: NormalizedOpportunity): string[] {
  return Array.isArray(record.rawData?.tags)
    ? record.rawData.tags.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
}

function recordText(record: NormalizedOpportunity): string {
  return [
    record.title,
    record.type,
    record.solicitationNumber,
    record.agency,
    record.subAgency,
    record.description,
    record.naicsDescription,
    record.placeOfPerformance,
  ]
    .filter(Boolean)
    .join(". ")
    .slice(0, 12_000);
}

function candidateFor(record: NormalizedOpportunity): PortalAiCandidate {
  return {
    title: record.title,
    url: record.sourceUrl ?? `urn:opportunity:${record.externalId}`,
    content: recordText(record),
    sourceProvider:
      typeof record.rawData?.sourceId === "string"
        ? record.rawData.sourceId
        : record.providerName ?? String(record.source),
    record,
  };
}

function validDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function applyAiExtraction(
  candidate: PrioritizedCandidate<PortalAiCandidate>,
  extraction: AiExtraction,
): NormalizedOpportunity {
  const record = candidate.record;
  const rawData = { ...(record.rawData ?? {}) };
  delete rawData.manualQueryMismatch;
  delete rawData.manualQuery;
  delete rawData.queryMatchDeferred;
  delete rawData.queryDeferralReason;

  const tags = stringTags(record).filter(
    (tag) => tag !== "manual-query-mismatch" && tag !== "query-deferred",
  );
  const recovered = record.rawData?.manualQueryMismatch === true;

  return {
    ...record,
    title: extraction.title?.trim() || record.title,
    agency: extraction.agency?.trim() || record.agency,
    description: extraction.description?.trim() || record.description,
    responseDeadline:
      validDate(extraction.deadline) ?? record.responseDeadline,
    placeOfPerformance:
      extraction.location?.trim() || record.placeOfPerformance,
    estimatedValue:
      extraction.estimatedValue ?? record.estimatedValue,
    rawData: {
      ...rawData,
      tags: Array.from(
        new Set([
          ...tags,
          "cloudflare-semantic-priority",
          "ai-opportunity-adjudicated",
          ...(recovered ? ["ai-semantic-recovered"] : []),
        ]),
      ),
      cloudflareSemanticScore: candidate.cloudflareSemanticScore,
      cloudflareSemanticRank: candidate.cloudflareSemanticRank,
      aiOpportunityAdjudicated: true,
      aiSemanticRecovered: recovered,
      aiRelevanceScore: extraction.relevanceScore,
      aiRelevanceReason: extraction.relevanceReason,
      winnerScorer: extraction.winnerScorer,
      validatedBy: extraction.validatedBy,
      validationReason: extraction.validationReason,
    },
  };
}

function preserveDeterministicMatch(
  candidate: PrioritizedCandidate<PortalAiCandidate>,
  extraction: AiExtraction | null,
): NormalizedOpportunity {
  return {
    ...candidate.record,
    rawData: {
      ...(candidate.record.rawData ?? {}),
      cloudflareSemanticScore: candidate.cloudflareSemanticScore,
      cloudflareSemanticRank: candidate.cloudflareSemanticRank,
      aiAdjudicationUnavailable: extraction == null,
      aiAdjudicationDisagreed:
        extraction != null &&
        (!extraction.isOpportunity || (extraction.relevanceScore ?? 0) < getRelevanceProfile().thresholds.acceptMin),
      aiRejectionReason:
        extraction && !extraction.isOpportunity ? extraction.reason : undefined,
      aiRelevanceScore: extraction?.relevanceScore,
      aiRelevanceReason: extraction?.relevanceReason,
      winnerScorer: extraction?.winnerScorer,
    },
  };
}

function stableKey(record: NormalizedOpportunity): string {
  return record.sourceUrl?.trim().toLowerCase() || record.externalId.toLowerCase();
}

/**
 * Run direct portal output through the same Cloudflare -> Cerebras -> fallback
 * intelligence path used by web discovery. Deterministic query matches remain
 * authoritative and AI may enrich them, while AI can recover semantic matches
 * that the lexical query boundary marked as diagnostic mismatches.
 */
export async function adjudicatePublicPortalResult(
  result: ProviderFetchResult,
  focus?: string,
): Promise<ProviderFetchResult> {
  if (result.records.length === 0) return result;

  const aiLimit = positiveIntegerEnv(
    "PUBLIC_PORTAL_AI_CANDIDATE_LIMIT",
    DEFAULT_AI_LIMIT,
    20,
    MAX_AI_LIMIT,
  );

  const priority = await prioritizeCandidatesWithCloudflare(
    result.records.map(candidateFor),
    focus,
    aiLimit,
  );
  for (const error of priority.errors) {
    console.warn(`[publicPortalAiAdjudication] ${error}`);
  }

  const candidates = priority.candidates;
  let extractions: (AiExtraction | null)[] = new Array(candidates.length).fill(
    null,
  );
  let usedScorers: string[] = [];
  try {
    const batch = await extractOpportunitiesBatch(
      candidates.map((candidate) => ({
        title: candidate.title,
        url: candidate.url,
        content: [
          candidate.content,
          `Cloudflare semantic score: ${candidate.cloudflareSemanticScore}.`,
          `Cloudflare semantic rank: ${candidate.cloudflareSemanticRank}.`,
        ].join("\n"),
      })),
    );
    extractions = batch.extractions;
    usedScorers = batch.usedScorers;
  } catch (error) {
    console.warn(
      `[publicPortalAiAdjudication] AI adjudication failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const kept: NormalizedOpportunity[] = [];
  // Lexical mismatches the AI did not recover. Missing keywords alone never drop a record: these stay flagged
  // (queryMatchDeferred) behind the kept records and the quality decision holds them for review or rejects them on
  // the canonical relevance decision.
  const deferred: NormalizedOpportunity[] = [];

  candidates.forEach((candidate, index) => {
    const record = candidate.record;
    const extraction = extractions[index];
    const mismatch = record.rawData?.manualQueryMismatch === true;
    const aiAccepted =
      extraction?.isOpportunity === true &&
      (extraction.relevanceScore ?? 0) >= getRelevanceProfile().thresholds.acceptMin;

    // A record that already passed the deterministic portal query boundary is
    // authoritative. AI can enrich it, but a model disagreement must never make
    // that direct official record disappear.
    if (!mismatch) {
      kept.push(
        aiAccepted && extraction
          ? applyAiExtraction(candidate, extraction)
          : preserveDeterministicMatch(candidate, extraction),
      );
      return;
    }

    // Lexical mismatches need affirmative semantic recovery to be promoted; otherwise they stay deferred.
    if (aiAccepted && extraction) {
      kept.push(applyAiExtraction(candidate, extraction));
      return;
    }

    deferred.push(record);
  });

  // Cloudflare may have bounded the AI work. Preserve deterministic non-mismatch
  // records outside that budget; mismatches outside it are deferred like the rest.
  for (const candidate of priority.overflow) {
    if (candidate.record.rawData?.manualQueryMismatch === true) {
      deferred.push(candidate.record);
    } else {
      kept.push(candidate.record);
    }
  }

  const seen = new Set<string>();
  const records = [...kept, ...deferred].filter((record) => {
    const key = stableKey(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (priority.applied || usedScorers.length > 0) {
    console.info(
      JSON.stringify({
        event: "public_portal_ai_adjudication",
        input: result.records.length,
        output: records.length,
        cloudflareApplied: priority.applied,
        cloudflareEmbedded: priority.embedded,
        cloudflareDirectReranked: priority.directReranked,
        duplicatesRemoved: priority.duplicatesRemoved,
        aiScorers: [
          ...(priority.applied ? ["cloudflare-workers-ai"] : []),
          ...usedScorers,
        ],
        queryDeferred: deferred.length,
        thinSnippetDeferred: priority.deferred,
      }),
    );
  }

  return {
    records,
    total: records.filter(
      (record) => record.rawData?.manualQueryMismatch !== true,
    ).length,
    errors: result.errors,
  };
}
