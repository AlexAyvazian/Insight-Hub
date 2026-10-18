import type { NormalizedOpportunity } from "../providers/types";
import { classifyProviderRecordRelevance } from "../providers/providerQueryMatch";
import { getOccuMedPromptContext, renderPromptContext } from "./occumedPromptContext";
import { hasPrimaryOccuMedServiceEvidence } from "../opportunityScopeEvidence";
import { decideRelevance } from "./relevanceDecision";
import { getRelevanceProfile } from "./relevanceProfile";
import { opportunityDescriptionContext } from "./opportunityDescriptionContext";
import { SCOPE_BLOCK_HEADER, judgeScopeBlock, profileServiceLabels, scoreGuidance } from "./profileText";
import { geminiProvider } from "../providers/gemini";
import { groqProvider } from "../providers/groq";
import { openrouterProvider } from "../providers/openrouter";
import { minimaxProvider } from "../providers/minimax";
import { clodProvider } from "../providers/clod";
import {
  cerebrasProvider,
  deepseekProvider,
  mistralProvider,
  nvidiaProvider,
} from "../providers/openAiCompatible";
import {
  recordProviderFailure,
  recordProviderSuccess,
  selectBudgetedProviders,
} from "../providerBudget";

interface ReviewProvider {
  name: string;
  isConfigured(): Promise<boolean>;
  complete(prompt: string, maxTokens?: number): Promise<string>;
}

/** Why a structured record was neither approved nor rejected. Held records are retained for review, never bid-ready. */
export type StructuredHoldCode =
  | "structured_review_budget"
  | "structured_review_declined"
  | "structured_review_failed";

export interface StructuredHeldRecord {
  record: NormalizedOpportunity;
  code: StructuredHoldCode;
  reason: string;
}

export interface StructuredOpportunityDecisionResult {
  approved: NormalizedOpportunity[];
  /** Ambiguous records not approved this run (budget, AI decline or AI failure): retained, never discarded. */
  held: StructuredHeldRecord[];
  /** Records the canonical relevance decision rejected, kept for rejection provenance. */
  rejectedRecords: NormalizedOpportunity[];
  deterministicApproved: number;
  aiApproved: number;
  rejected: number;
  reviewHeld: number;
  reviewer: string | null;
  diagnostics: string[];
}

export interface ReviewVote {
  index: number;
  isOpportunity: boolean;
  relevanceScore: number;
  reason: string;
}

interface PanelDecision extends ReviewVote {
  method: "panel-ai-review" | "single-ai-review";
  reviewers: string[];
}

const REVIEW_PROVIDERS: ReviewProvider[] = [
  cerebrasProvider,
  groqProvider,
  mistralProvider,
  nvidiaProvider,
  openrouterProvider,
  minimaxProvider,
  clodProvider,
  geminiProvider,
  deepseekProvider,
];

const DEFAULT_REVIEW_LIMIT = 3;
const REVIEW_DESCRIPTION_CHARS = 12_000;
const REVIEW_OUTPUT_TOKENS = 700;
const PANEL_SIZE = 3;
const PANEL_CONSENSUS = 2;

function existingTags(record: NormalizedOpportunity): string[] {
  const tags = record.rawData?.tags;
  return Array.isArray(tags)
    ? tags.filter(
        (tag): tag is string =>
          typeof tag === "string" && tag.trim().length > 0,
      )
    : [];
}

function withDecision(
  record: NormalizedOpportunity,
  method: "deterministic" | "panel-ai-review" | "single-ai-review",
  score: number,
  reason: string,
  reviewers: string[] = [],
): NormalizedOpportunity {
  return {
    ...record,
    rawData: {
      ...(record.rawData ?? {}),
      opportunityDecision: "actionable",
      opportunityDecisionMethod: method,
      relevanceScore: score,
      relevanceReason: reason,
      ...(reviewers.length > 0
        ? {
            opportunityReviewer: reviewers.join(","),
            opportunityReviewers: reviewers,
          }
        : {}),
      tags: Array.from(
        new Set([
          ...existingTags(record),
          "actionable",
          method === "deterministic"
            ? "deterministic-approved"
            : method === "panel-ai-review"
              ? "panel-ai-reviewed"
              : "single-ai-reviewed",
        ]),
      ),
    },
  };
}

function hasFutureDeadline(
  record: NormalizedOpportunity,
  now = Date.now(),
): boolean {
  return Boolean(
    record.responseDeadline &&
      !Number.isNaN(record.responseDeadline.getTime()) &&
      record.responseDeadline.getTime() > now,
  );
}

export function isDeterministicallyActionable(
  record: NormalizedOpportunity,
  now = Date.now(),
): boolean {
  const relevance = classifyProviderRecordRelevance(record);
  return (
    decideRelevance(relevance).verdict === "accept" &&
    hasFutureDeadline(record, now) &&
    (relevance.confidence === "verified_explicit" ||
      relevance.confidence === "strong_combination") &&
    // A classifier score alone is not purchased-scope proof; without it the record goes to review, not auto-approval.
    hasPrimaryOccuMedServiceEvidence(record.title ?? "", record.description ?? "")
  );
}

export function structuredReviewCandidateLimit(): number {
  const parsed = Number.parseInt(
    process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT ?? "",
    10,
  );
  if (!Number.isFinite(parsed)) return DEFAULT_REVIEW_LIMIT;
  return Math.max(0, Math.min(5, parsed));
}

function stripJson(text: string): string {
  return text
    .replace(/```json\n?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function parseReviewVotes(text: string): ReviewVote[] | null {
  const cleaned = stripJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { results?: unknown[] }).results)
      ? (parsed as { results: unknown[] }).results
      : null;
  if (!rows) return null;

  return rows.flatMap((row, order) => {
    if (!row || typeof row !== "object") return [];
    const object = row as Record<string, unknown>;
    const indexValue = Number(object.index);
    const index = Number.isInteger(indexValue) ? indexValue : order;
    const scoreValue = Number(object.relevanceScore);
    const relevanceScore = Number.isFinite(scoreValue)
      ? Math.max(0, Math.min(100, Math.round(scoreValue)))
      : 0;
    const reason =
      typeof object.reason === "string" && object.reason.trim()
        ? object.reason.trim().slice(0, 400)
        : object.isOpportunity === true
          ? "The purchased scope is an active Occu-Med-compatible procurement."
          : "The record lacks sufficient active Occu-Med procurement evidence.";
    return [
      {
        index,
        isOpportunity: object.isOpportunity === true,
        relevanceScore,
        reason,
      },
    ];
  });
}

/**
 * A judge can contribute at most one vote to each record. Invalid or repeated
 * indexes are dropped so malformed model output cannot manufacture consensus.
 */
export function distinctProviderVotes(
  votes: ReviewVote[] | null,
  recordCount: number,
): ReviewVote[] {
  if (!votes || recordCount <= 0) return [];
  const unique = new Map<number, ReviewVote>();
  for (const vote of votes) {
    if (vote.index < 0 || vote.index >= recordCount) continue;
    if (!unique.has(vote.index)) unique.set(vote.index, vote);
  }
  return [...unique.values()];
}

export function buildReviewPrompt(
  records: NormalizedOpportunity[],
  profileContext = "",
): string {
  const items = records
    .map(
      (record, index) =>
        [
          `[${index}]`,
          `Title: ${record.title}`,
          `Buyer: ${record.agency}`,
          `Notice type: ${record.type}`,
          record.solicitationNumber
            ? `Solicitation: ${record.solicitationNumber}`
            : "",
          record.responseDeadline
            ? `Deadline: ${record.responseDeadline.toISOString()}`
            : "Deadline: unknown",
          `Description: ${opportunityDescriptionContext(record.description, REVIEW_DESCRIPTION_CHARS)}`,
        ]
          .filter(Boolean)
          .join("\n"),
    )
    .join("\n\n");

  return `You are one independent judge in a procurement relevance panel for Occu-Med.
Today is ${new Date().toISOString().slice(0, 10)}.
${profileContext ? `\n${profileContext}\n` : ""}
${profileContext.includes(SCOPE_BLOCK_HEADER) ? "" : judgeScopeBlock()}

A record is approved only when it is a real procurement notice that is currently open for responses and the PRIMARY PURCHASED SCOPE (not incidental boilerplate) is within the scope policies above. Reject expired, awarded, cancelled or closed notices. Do not approve an unknown deadline unless the record contains clear evidence that responses are currently being accepted.

${scoreGuidance()}

Judge independently. Do not assume another model will correct you. Return only JSON in this shape and exactly one row per item:
{"results":[{"index":0,"isOpportunity":true,"relevanceScore":86,"reason":"Core scope purchases ${profileServiceLabels()[0] ?? "a listed service"}; deadline is open."}]}

ITEMS:
${items}`;
}

export function panelResolved(
  votesByIndex: Map<number, Array<{ provider: string; vote: ReviewVote }>>,
  recordCount: number,
): boolean {
  if (recordCount === 0) return true;
  for (let index = 0; index < recordCount; index += 1) {
    const rows = votesByIndex.get(index) ?? [];
    const yes = new Set(
      rows
        .filter((row) => row.vote.isOpportunity)
        .map((row) => row.provider),
    ).size;
    const no = new Set(
      rows
        .filter((row) => !row.vote.isOpportunity)
        .map((row) => row.provider),
    ).size;
    if (yes < PANEL_CONSENSUS && no < PANEL_CONSENSUS) return false;
  }
  return true;
}

async function reviewAmbiguous(
  records: NormalizedOpportunity[],
): Promise<{
  decisions: PanelDecision[];
  reviewers: string[];
  diagnostics: string[];
}> {
  if (records.length === 0) {
    return { decisions: [], reviewers: [], diagnostics: [] };
  }

  const configuredRows = await Promise.all(
    REVIEW_PROVIDERS.map(async (provider) => ({
      provider,
      configured: await provider.isConfigured().catch(() => false),
    })),
  );
  const configured = configuredRows
    .filter((row) => row.configured)
    .map((row) => row.provider);

  const selectedNames = await selectBudgetedProviders(
    configured.map((provider) => `judge:${provider.name}`),
    PANEL_SIZE,
  );
  const selected = selectedNames
    .map((name) =>
      configured.find((provider) => `judge:${provider.name}` === name),
    )
    .filter((provider): provider is ReviewProvider => Boolean(provider));

  const diagnostics: string[] = [];
  const reviewers: string[] = [];
  if (selected.length === 0) {
    diagnostics.push(
      configured.length === 0
        ? "No review provider is configured."
        : `All ${configured.length} configured review providers are in budget cooldown.`,
    );
  }

  const votesByIndex = new Map<
    number,
    Array<{ provider: string; vote: ReviewVote }>
  >();
  const prompt = buildReviewPrompt(
    records,
    renderPromptContext(await getOccuMedPromptContext()),
  );

  for (const provider of selected) {
    const budgetName = `judge:${provider.name}`;
    try {
      const parsedVotes = parseReviewVotes(
        await provider.complete(prompt, REVIEW_OUTPUT_TOKENS),
      );
      const votes = distinctProviderVotes(parsedVotes, records.length);
      if (!parsedVotes || votes.length !== records.length) {
        throw new Error(
          `${provider.name} returned ${votes.length}/${records.length} distinct valid panel votes`,
        );
      }
      reviewers.push(provider.name);
      await recordProviderSuccess(budgetName, votes.length);
      for (const vote of votes) {
        const rows = votesByIndex.get(vote.index) ?? [];
        rows.push({ provider: provider.name, vote });
        votesByIndex.set(vote.index, rows);
      }
      if (panelResolved(votesByIndex, records.length)) break;
    } catch (error) {
      await recordProviderFailure(budgetName, error);
      diagnostics.push(
        `${provider.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const decisions: PanelDecision[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const rows = votesByIndex.get(index) ?? [];
    if (rows.length === 0) continue;
    const byProvider = new Map(
      rows.map((row) => [row.provider, row] as const),
    );
    const distinctRows = [...byProvider.values()];
    const positive = distinctRows.filter((row) => row.vote.isOpportunity);
    const negative = distinctRows.filter((row) => !row.vote.isOpportunity);

    if (positive.length >= PANEL_CONSENSUS) {
      const score = Math.round(
        positive.reduce((sum, row) => sum + row.vote.relevanceScore, 0) /
          positive.length,
      );
      if (score < getRelevanceProfile().thresholds.acceptMin) continue;
      decisions.push({
        index,
        isOpportunity: true,
        relevanceScore: score,
        reason: positive.map((row) => row.vote.reason).slice(0, 2).join(" | "),
        method: "panel-ai-review",
        reviewers: positive.map((row) => row.provider),
      });
      continue;
    }

    // If only one judge is available it may confirm a record the Neon evidence
    // rules already accept (for example to verify an open deadline), at the
    // canonical accept threshold. A record in the review band needs a panel, and
    // one weak model can never outvote a second negative judge.
    if (
      distinctRows.length === 1 &&
      positive.length === 1 &&
      negative.length === 0 &&
      decideRelevance(classifyProviderRecordRelevance(records[index]!)).verdict === "accept" &&
      positive[0]!.vote.relevanceScore >= getRelevanceProfile().thresholds.acceptMin
    ) {
      decisions.push({
        ...positive[0]!.vote,
        method: "single-ai-review",
        reviewers: [positive[0]!.provider],
      });
    }
  }

  return {
    decisions,
    reviewers,
    diagnostics: Array.from(new Set(diagnostics)).slice(0, 8),
  };
}

export async function decideStructuredOpportunities(
  records: NormalizedOpportunity[],
): Promise<StructuredOpportunityDecisionResult> {
  const approved: NormalizedOpportunity[] = [];
  const ambiguous: Array<{
    record: NormalizedOpportunity;
    score: number;
    reason: string;
  }> = [];
  const rejectedRecords: NormalizedOpportunity[] = [];
  let rejected = 0;

  for (const record of records) {
    const relevance = classifyProviderRecordRelevance(record);
    if (decideRelevance(relevance).verdict === "reject") {
      rejected += 1;
      rejectedRecords.push(record);
      continue;
    }

    if (isDeterministicallyActionable(record)) {
      approved.push(
        withDecision(
          record,
          "deterministic",
          relevance.score,
          relevance.reasons.join("; ") ||
            "Explicit Occu-Med service scope with a future response deadline.",
        ),
      );
      continue;
    }

    ambiguous.push({
      record,
      score: relevance.score,
      reason: relevance.reasons.join("; "),
    });
  }

  ambiguous.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta) return scoreDelta;
    const leftDeadline = left.record.responseDeadline?.getTime() ?? Infinity;
    const rightDeadline = right.record.responseDeadline?.getTime() ?? Infinity;
    return leftDeadline - rightDeadline;
  });

  // The limit bounds paid review calls, never record retention: everything not approved below is held.
  const reviewLimit = structuredReviewCandidateLimit();
  const selected = ambiguous.slice(0, reviewLimit);
  let review: Awaited<ReturnType<typeof reviewAmbiguous>>;
  let reviewFailure: string | null = null;
  try {
    review = await reviewAmbiguous(selected.map((entry) => entry.record));
  } catch (error) {
    reviewFailure = error instanceof Error ? error.message : String(error);
    review = { decisions: [], reviewers: [], diagnostics: [`structured review failed: ${reviewFailure}`] };
  }
  let aiApproved = 0;
  const approvedIndexes = new Set<number>();

  for (const decision of review.decisions) {
    const target = selected[decision.index];
    if (!target || !decision.isOpportunity) continue;
    approved.push(
      withDecision(
        target.record,
        decision.method,
        decision.relevanceScore,
        decision.reason,
        decision.reviewers,
      ),
    );
    approvedIndexes.add(decision.index);
    aiApproved += 1;
  }

  const held: StructuredHeldRecord[] = ambiguous.flatMap((entry, index) => {
    if (approvedIndexes.has(index)) return [];
    if (index >= reviewLimit) {
      return [{ record: entry.record, code: "structured_review_budget" as const,
        reason: `Not sent to AI review: per-run review budget (${reviewLimit}) reached. ${entry.reason}`.trim() }];
    }
    if (reviewFailure || review.reviewers.length === 0) {
      return [{ record: entry.record, code: "structured_review_failed" as const,
        reason: `AI review unavailable${reviewFailure ? ` (${reviewFailure})` : ""}. ${entry.reason}`.trim() }];
    }
    return [{ record: entry.record, code: "structured_review_declined" as const,
      reason: `AI review did not confirm purchased scope. ${entry.reason}`.trim() }];
  });
  const reviewHeld = held.length;

  return {
    approved,
    held,
    rejectedRecords,
    deterministicApproved: approved.length - aiApproved,
    aiApproved,
    rejected,
    reviewHeld,
    reviewer: review.reviewers.length > 0 ? review.reviewers.join(",") : null,
    diagnostics: review.diagnostics,
  };
}
