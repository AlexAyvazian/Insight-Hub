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
  getProviderBudgetSnapshot,
  providerDailyTokenLimit,
  recordProviderFailure,
  recordProviderSuccess,
} from "../providerBudget";
import { releaseCFlags } from "../releaseC/flags";
import { judgmentContentHash, opportunityKey, providerModelFamily } from "../releaseC/identity";
import { cachedQueueDecisions, enqueueForReview, reviewPriority, settleByKey, type CachedQueueDecision } from "../releaseC/reviewQueue";
import {
  classifyWithDocumentEvidence,
  documentEvidenceText,
  loadDocumentContext,
  withDocumentEvidence,
  type DocumentContext,
} from "../releaseC/documentEvidence";
import { buildLedger, ledgerSummary, saveLedger, type Ledger } from "../releaseC/requirements";
import { fenceUntrustedText, neutraliseUntrustedText, UNTRUSTED_EVIDENCE_RULE } from "../security/untrustedContent";

export interface ReviewProvider {
  name: string;
  isConfigured(): Promise<boolean>;
  complete(prompt: string, maxTokens?: number): Promise<string>;
}

/** Why a structured record was neither approved nor rejected. Held records are retained for review, never bid-ready. */
export type StructuredHoldCode =
  /** STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT override reached; queued for the next pass. */
  | "structured_review_budget"
  /** Not reviewed this run (AI capacity or time used up); queued and resumed automatically. */
  | "structured_review_queued"
  /** Independent judges declined it. */
  | "structured_review_declined"
  /** Independent model families disagreed; queued for adjudication by another family. */
  | "structured_review_disputed"
  /** No reviewer is configured or every reviewer failed. */
  | "structured_review_failed"
  /** The notice or its documents tried to steer the reviewer; never AI-approved. */
  | "structured_untrusted_content"
  /** OPPORTUNITY_REQUIRE_DOCUMENT_EVIDENCE: documents not yet read. */
  | "structured_document_pending";

export interface StructuredHeldRecord {
  record: NormalizedOpportunity;
  code: StructuredHoldCode;
  reason: string;
}

export interface StructuredOpportunityDecisionResult {
  approved: NormalizedOpportunity[];
  /** Ambiguous records not approved this run: retained (and queued), never discarded. */
  held: StructuredHeldRecord[];
  /** Records the canonical relevance decision rejected, kept for rejection provenance. */
  rejectedRecords: NormalizedOpportunity[];
  deterministicApproved: number;
  aiApproved: number;
  rejected: number;
  reviewHeld: number;
  reviewer: string | null;
  diagnostics: string[];
  /** Adaptive review accounting for this call. */
  review: {
    candidates: number;
    reviewed: number;
    cached: number;
    queued: number;
    judgeCalls: number;
    estimatedTokens: number;
    families: string[];
    stopReason: string | null;
  };
}

export interface ReviewVote {
  index: number;
  isOpportunity: boolean;
  relevanceScore: number;
  reason: string;
}

type DecisionMethod = "deterministic" | "panel-ai-review" | "single-ai-review";

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

const REVIEW_DESCRIPTION_CHARS = 12_000;
const REVIEW_DESCRIPTION_CHARS_WITH_DOCUMENTS = 7_000;
const REVIEW_DOCUMENT_CHARS = 7_000;
const REVIEW_OUTPUT_TOKENS = 700;
const REVIEW_BATCH_SIZE = 3;
const PANEL_CONSENSUS = 2;
const DEFAULT_REVIEW_TIME_BUDGET_MS = 35_000;
const STORAGE_BACKOFF_MS = 60_000;
let storageUnavailableUntil = 0;

function existingTags(record: NormalizedOpportunity): string[] {
  const tags = record.rawData?.tags;
  return Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    : [];
}

function withDecision(
  record: NormalizedOpportunity,
  method: DecisionMethod,
  score: number,
  reason: string,
  reviewers: string[] = [],
  families: string[] = [],
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
        ? { opportunityReviewer: reviewers.join(","), opportunityReviewers: reviewers, opportunityReviewerFamilies: families }
        : {}),
      tags: Array.from(
        new Set([
          ...existingTags(record),
          "actionable",
          method === "deterministic" ? "deterministic-approved" : method === "panel-ai-review" ? "panel-ai-reviewed" : "single-ai-reviewed",
        ]),
      ),
    },
  };
}

function hasFutureDeadline(record: NormalizedOpportunity, now = Date.now()): boolean {
  return Boolean(
    record.responseDeadline && !Number.isNaN(record.responseDeadline.getTime()) && record.responseDeadline.getTime() > now,
  );
}

export function isDeterministicallyActionable(record: NormalizedOpportunity, now = Date.now()): boolean {
  const { result: relevance, usedDocuments } = classifyWithDocumentEvidence(record);
  const description = usedDocuments ? `${record.description ?? ""}\n\n${documentEvidenceText(record)}` : record.description ?? "";
  return (
    decideRelevance(relevance).verdict === "accept" &&
    hasFutureDeadline(record, now) &&
    (relevance.confidence === "verified_explicit" || relevance.confidence === "strong_combination") &&
    // A classifier score alone is not purchased-scope proof; without it the record goes to review, not auto-approval.
    hasPrimaryOccuMedServiceEvidence(record.title ?? "", description)
  );
}

/**
 * Optional operator ceiling on how many ambiguous records one call may send to AI review. Unset (the default) means
 * adaptive: as many as free AI capacity, rate limits and the time budget allow. Records above the ceiling are
 * queued, never dropped.
 */
export function structuredReviewCandidateLimit(): number | null {
  const raw = process.env.STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT?.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function structuredReviewTimeBudgetMs(): number {
  const parsed = Number.parseInt(process.env.STRUCTURED_RFP_REVIEW_TIME_BUDGET_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 15 * 60_000) : DEFAULT_REVIEW_TIME_BUDGET_MS;
}

function stripJson(text: string): string {
  return text.replace(/```json\n?/gi, "").replace(/```/g, "").trim();
}

export function parseReviewVotes(text: string): ReviewVote[] | null {
  const cleaned = stripJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const arrayStart = cleaned.indexOf("[");
    const arrayEnd = cleaned.lastIndexOf("]");
    const candidates = [
      start >= 0 && end > start ? cleaned.slice(start, end + 1) : null,
      arrayStart >= 0 && arrayEnd > arrayStart ? cleaned.slice(arrayStart, arrayEnd + 1) : null,
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      try {
        parsed = JSON.parse(candidate);
        break;
      } catch {
        parsed = undefined;
      }
    }
    if (parsed === undefined) return null;
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown[] }).results)
      ? (parsed as { results: unknown[] }).results
      : null;
  if (!rows) return null;

  return rows.flatMap((row, order) => {
    if (!row || typeof row !== "object") return [];
    const object = row as Record<string, unknown>;
    const indexValue = Number(object.index);
    const index = Number.isInteger(indexValue) ? indexValue : order;
    const scoreValue = Number(object.relevanceScore);
    const relevanceScore = Number.isFinite(scoreValue) ? Math.max(0, Math.min(100, Math.round(scoreValue))) : 0;
    const reason =
      typeof object.reason === "string" && object.reason.trim()
        ? object.reason.trim().slice(0, 400)
        : object.isOpportunity === true
          ? "The purchased scope is an active Occu-Med-compatible procurement."
          : "The record lacks sufficient active Occu-Med procurement evidence.";
    return [{ index, isOpportunity: object.isOpportunity === true, relevanceScore, reason }];
  });
}

/**
 * A judge can contribute at most one vote to each record. Invalid or repeated
 * indexes are dropped so malformed model output cannot manufacture consensus.
 */
export function distinctProviderVotes(votes: ReviewVote[] | null, recordCount: number): ReviewVote[] {
  if (!votes || recordCount <= 0) return [];
  const unique = new Map<number, ReviewVote>();
  for (const vote of votes) {
    if (vote.index < 0 || vote.index >= recordCount) continue;
    if (!unique.has(vote.index)) unique.set(vote.index, vote);
  }
  return [...unique.values()];
}

function shortField(value: string | null | undefined, max = 300): string {
  return neutraliseUntrustedText(String(value ?? "")).text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function buildReviewPrompt(records: NormalizedOpportunity[], profileContext = ""): string {
  const items = records
    .map((record, index) => {
      const documents = documentEvidenceText(record);
      const description = fenceUntrustedText(
        opportunityDescriptionContext(record.description, documents ? REVIEW_DESCRIPTION_CHARS_WITH_DOCUMENTS : REVIEW_DESCRIPTION_CHARS),
        "NOTICE DESCRIPTION",
      ).block;
      return [
        `[${index}]`,
        `Title: ${shortField(record.title)}`,
        `Buyer: ${shortField(record.agency, 200)}`,
        `Notice type: ${shortField(record.type, 80)}`,
        record.solicitationNumber ? `Solicitation: ${shortField(record.solicitationNumber, 80)}` : "",
        record.responseDeadline ? `Deadline: ${record.responseDeadline.toISOString()}` : "Deadline: unknown",
        `Description:\n${description}`,
        documents
          ? `Official documents (cited excerpts, document/page/section in brackets):\n${fenceUntrustedText(documents.slice(0, REVIEW_DOCUMENT_CHARS), "SOLICITATION DOCUMENTS").block}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return `You are one independent judge in a procurement relevance panel for Occu-Med.
Today is ${new Date().toISOString().slice(0, 10)}.
${profileContext ? `\n${profileContext}\n` : ""}
${profileContext.includes(SCOPE_BLOCK_HEADER) ? "" : judgeScopeBlock()}

A record is approved only when it is a real procurement notice that is currently open for responses and the PRIMARY PURCHASED SCOPE (not incidental boilerplate) is within the scope policies above. Reject expired, awarded, cancelled or closed notices. Do not approve an unknown deadline unless the record contains clear evidence that responses are currently being accepted. When official document excerpts are given, judge the scope they describe (statement of work, amendments, exclusions), not only the summary.

${UNTRUSTED_EVIDENCE_RULE}

${scoreGuidance()}

Judge independently. Do not assume another model will correct you. Return only JSON in this shape and exactly one row per item:
{"results":[{"index":0,"isOpportunity":true,"relevanceScore":86,"reason":"Core scope purchases ${profileServiceLabels()[0] ?? "a listed service"}; deadline is open."}]}

ITEMS:
${items}`;
}

/** True when every record has a consensus (PANEL_CONSENSUS distinct voters agreeing) in either direction. */
export function panelResolved(
  votesByIndex: Map<number, Array<{ provider: string; vote: ReviewVote }>>,
  recordCount: number,
): boolean {
  if (recordCount === 0) return true;
  for (let index = 0; index < recordCount; index += 1) {
    if (!recordResolved(votesByIndex.get(index) ?? [])) return false;
  }
  return true;
}

function recordResolved(rows: Array<{ provider: string; vote: ReviewVote }>): boolean {
  const yes = new Set(rows.filter((row) => row.vote.isOpportunity).map((row) => row.provider)).size;
  const no = new Set(rows.filter((row) => !row.vote.isOpportunity).map((row) => row.provider)).size;
  return yes >= PANEL_CONSENSUS || no >= PANEL_CONSENSUS;
}

interface Judge {
  provider: ReviewProvider;
  budgetName: string;
  family: string;
}

/**
 * Judges that can be called right now: configured, not cooling down, inside any request/token allowance, and at
 * most one per model family (two gateways serving the same model are one vote, not two).
 */
async function availableJudges(providers: ReviewProvider[], excludeFamilies: Set<string> = new Set()): Promise<{ judges: Judge[]; configured: number }> {
  const configured = (
    await Promise.all(providers.map(async (provider) => ((await provider.isConfigured().catch(() => false)) ? provider : null)))
  ).filter((provider): provider is ReviewProvider => Boolean(provider));
  const rows = await Promise.all(
    configured.map(async (provider, index) => {
      const budgetName = `judge:${provider.name}`;
      const snapshot = await getProviderBudgetSnapshot(budgetName);
      const tokenLimit = providerDailyTokenLimit(budgetName);
      const tokensOk = tokenLimit == null || (snapshot.tokensToday ?? 0) < tokenLimit;
      return {
        judge: { provider, budgetName, family: await providerModelFamily(provider) },
        available: snapshot.available && tokensOk,
        quality: snapshot.successes + snapshot.failures > 0 ? snapshot.successes / (snapshot.successes + snapshot.failures) : 0.5,
        index,
      };
    }),
  );
  const byFamily = new Map<string, (typeof rows)[number]>();
  for (const row of rows
    .filter((row) => row.available && !excludeFamilies.has(row.judge.family))
    .sort((a, b) => b.quality - a.quality || a.index - b.index)) {
    if (!byFamily.has(row.judge.family)) byFamily.set(row.judge.family, row);
  }
  return { judges: [...byFamily.values()].map((row) => row.judge), configured: configured.length };
}

interface Candidate {
  record: NormalizedOpportunity;
  key: string;
  hash: string;
  score: number;
  reason: string;
  priority: number;
  injectionSignals: number;
  verdict: "accept" | "review" | "reject";
  ledger: Ledger | null;
}

type Outcome =
  | { kind: "approved"; method: DecisionMethod; score: number; reason: string; reviewers: string[]; families: string[] }
  | { kind: "held"; code: StructuredHoldCode; reason: string; decided: boolean; retryAt?: Date | null };

interface PanelRun {
  outcomes: Map<number, Outcome>;
  reviewers: string[];
  families: string[];
  judgeCalls: number;
  tokens: number;
  diagnostics: string[];
  anySuccess: boolean;
}

function estimateTokens(prompt: string, output: string): number {
  return Math.ceil((prompt.length + output.length) / 4);
}

async function callJudge(
  judge: Judge,
  prompt: string,
  count: number,
): Promise<{ votes: ReviewVote[] | null; tokens: number; error: string | null }> {
  try {
    const output = await judge.provider.complete(prompt, REVIEW_OUTPUT_TOKENS);
    const tokens = estimateTokens(prompt, output);
    const parsed = parseReviewVotes(output);
    const votes = distinctProviderVotes(parsed, count);
    if (!parsed || votes.length !== count) {
      throw new Error(`${judge.provider.name} returned ${votes.length}/${count} distinct valid panel votes`);
    }
    await recordProviderSuccess(judge.budgetName, votes.length, { tokens });
    return { votes, tokens, error: null };
  } catch (error) {
    await recordProviderFailure(judge.budgetName, error);
    return { votes: null, tokens: Math.ceil(prompt.length / 4), error: `${judge.provider.name}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * One batch: two judges from different model families first; a third family only for records they disagree on (or
 * where one failed). Consensus needs two distinct families. One family alone may only confirm a record the canonical
 * evidence rules already accept.
 */
async function reviewBatch(batch: Candidate[], judges: Judge[], profileContext: string, deadline: number): Promise<PanelRun> {
  const run: PanelRun = { outcomes: new Map(), reviewers: [], families: [], judgeCalls: 0, tokens: 0, diagnostics: [], anySuccess: false };
  const votes = new Map<number, Array<{ provider: string; family: string; vote: ReviewVote }>>();
  const queue = [...judges];
  let pending = batch.map((_, index) => index);

  const addVotes = (judge: Judge, indexes: number[], got: ReviewVote[]) => {
    run.anySuccess = true;
    run.reviewers.push(judge.provider.name);
    run.families.push(judge.family);
    for (const vote of got) {
      const target = indexes[vote.index];
      if (target === undefined) continue;
      const rows = votes.get(target) ?? [];
      rows.push({ provider: judge.provider.name, family: judge.family, vote: { ...vote, index: target } });
      votes.set(target, rows);
    }
  };

  // First round: up to two families in parallel.
  const firstRound: Judge[] = [];
  while (firstRound.length < 2 && queue.length > 0) firstRound.push(queue.shift()!);
  const firstPrompt = buildReviewPrompt(batch.map((c) => c.record), profileContext);
  const firstResults = await Promise.all(firstRound.map((judge) => callJudge(judge, firstPrompt, batch.length)));
  firstResults.forEach((result, i) => {
    run.judgeCalls += 1;
    run.tokens += result.tokens;
    if (result.votes) addVotes(firstRound[i]!, pending, result.votes);
    else if (result.error) run.diagnostics.push(result.error);
  });

  // Further families only for unresolved records, while time remains.
  const unresolved = () =>
    pending.filter((index) => {
      const rows = votes.get(index) ?? [];
      return !recordResolved(rows.map((row) => ({ provider: row.family, vote: row.vote })));
    });
  pending = unresolved();
  while (pending.length > 0 && queue.length > 0 && Date.now() < deadline) {
    const judge = queue.shift()!;
    const subset = pending.map((index) => batch[index]!.record);
    const prompt = buildReviewPrompt(subset, profileContext);
    const result = await callJudge(judge, prompt, subset.length);
    run.judgeCalls += 1;
    run.tokens += result.tokens;
    if (result.votes) addVotes(judge, pending, result.votes);
    else if (result.error) run.diagnostics.push(result.error);
    pending = unresolved();
  }

  const { acceptMin } = getRelevanceProfile().thresholds;
  batch.forEach((candidate, index) => {
    const rows = votes.get(index) ?? [];
    const byFamily = new Map(rows.map((row) => [row.family, row] as const));
    const distinct = [...byFamily.values()];
    const positive = distinct.filter((row) => row.vote.isOpportunity);
    const negative = distinct.filter((row) => !row.vote.isOpportunity);
    if (distinct.length === 0) {
      run.outcomes.set(index, { kind: "held", code: "structured_review_failed", reason: `AI review unavailable for this record. ${candidate.reason}`.trim(), decided: false });
      return;
    }
    if (positive.length >= PANEL_CONSENSUS) {
      const score = Math.round(positive.reduce((sum, row) => sum + row.vote.relevanceScore, 0) / positive.length);
      // Adjudication: a tie-breaking third family settles a 1-1 split by majority (2-1).
      if (score >= acceptMin && positive.length > negative.length) {
        run.outcomes.set(index, {
          kind: "approved",
          method: "panel-ai-review",
          score,
          reason: positive.map((row) => row.vote.reason).slice(0, 2).join(" | "),
          reviewers: positive.map((row) => row.provider),
          families: positive.map((row) => row.family),
        });
        return;
      }
      if (negative.length >= positive.length) {
        run.outcomes.set(index, { kind: "held", code: "structured_review_disputed", reason: `Judges disagree (${positive.length} yes / ${negative.length} no). ${candidate.reason}`.trim(), decided: false });
        return;
      }
      run.outcomes.set(index, { kind: "held", code: "structured_review_declined", reason: `Judges agree on scope but the consensus score ${score} is below accept_min ${acceptMin}.`, decided: true });
      return;
    }
    if (negative.length >= PANEL_CONSENSUS) {
      run.outcomes.set(index, { kind: "held", code: "structured_review_declined", reason: `AI review did not confirm purchased scope: ${negative[0]!.vote.reason}`.slice(0, 480), decided: true });
      return;
    }
    // A single family can only confirm a record the canonical rules already accept, at the accept threshold.
    if (distinct.length === 1 && positive.length === 1 && candidate.verdict === "accept" && positive[0]!.vote.relevanceScore >= acceptMin) {
      run.outcomes.set(index, {
        kind: "approved",
        method: "single-ai-review",
        score: positive[0]!.vote.relevanceScore,
        reason: positive[0]!.vote.reason,
        reviewers: [positive[0]!.provider],
        families: [positive[0]!.family],
      });
      return;
    }
    run.outcomes.set(index, {
      kind: "held",
      code: positive.length > 0 && negative.length > 0 ? "structured_review_disputed" : "structured_review_queued",
      reason:
        positive.length > 0 && negative.length > 0
          ? `Judges from different model families disagree; queued for another family. ${candidate.reason}`.trim()
          : `Only one independent model family reviewed this record; queued for a second. ${candidate.reason}`.trim(),
      decided: false,
    });
  });
  return run;
}

function storageAvailable(persist: boolean): boolean {
  return persist && Date.now() >= storageUnavailableUntil;
}

function storageFailed(diagnostics: string[], error: unknown): void {
  storageUnavailableUntil = Date.now() + STORAGE_BACKOFF_MS;
  diagnostics.push(`review queue storage unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
}

export interface DecideStructuredOptions {
  /** Provider that produced the records (queue bookkeeping). */
  provider?: string;
  /** Wall-clock budget for AI review in this call. */
  timeBudgetMs?: number;
  signal?: AbortSignal;
  /** Persist queue/ledger/decision cache (default: the review-queue flag). */
  persist?: boolean;
  /** Injected reviewers (tests). */
  reviewProviders?: ReviewProvider[];
  now?: number;
}

export async function decideStructuredOpportunities(
  records: NormalizedOpportunity[],
  options: DecideStructuredOptions = {},
): Promise<StructuredOpportunityDecisionResult> {
  const flags = releaseCFlags();
  const persist = options.persist ?? flags.reviewQueue;
  const startedAt = Date.now();
  const now = options.now ?? startedAt;
  const profile = getRelevanceProfile();
  const approved: NormalizedOpportunity[] = [];
  const held: StructuredHeldRecord[] = [];
  const rejectedRecords: NormalizedOpportunity[] = [];
  const diagnostics: string[] = [];
  const candidates: Candidate[] = [];
  let rejected = 0;
  let deterministicApproved = 0;

  for (const original of records) {
    const baseRelevance = classifyProviderRecordRelevance(original);
    // Documents are fetched for a rejected notice only when its own text is too thin to judge and it carries some
    // Occu-Med signal; hard-rule rejections and clearly unrelated notices never spend extraction capacity.
    const thinButSignalled =
      (original.description ?? "").length < 600 &&
      baseRelevance.score >= profile.thresholds.reviewMin / 2 &&
      !(baseRelevance.confidence === "rejected" && baseRelevance.negativeSignals.length > 0);
    if (decideRelevance(baseRelevance).verdict === "reject" && !(flags.documentPipeline && thinButSignalled)) {
      rejected += 1;
      rejectedRecords.push(original);
      continue;
    }
    const key = opportunityKey(original);
    const priority = reviewPriority(original, baseRelevance.score, profile.thresholds, now);
    let documents: DocumentContext | null = null;
    if (flags.documentPipeline && storageAvailable(true)) {
      documents = await loadDocumentContext(original, key, flags, Math.max(0, priority));
      if (documents.error) storageFailed(diagnostics, new Error(documents.error));
    }
    const record = documents ? withDocumentEvidence(original, documents) : original;
    const { result: relevance } = classifyWithDocumentEvidence(record);
    const verdict = decideRelevance(relevance).verdict;
    if (verdict === "reject") {
      rejected += 1;
      rejectedRecords.push(record);
      continue;
    }

    let ledger: Ledger | null = null;
    let withLedger = record;
    if (flags.requirementLedger) {
      ledger = buildLedger(record, documents?.sections ?? [], {
        documents: documents?.documents ?? [],
        documentPipelineEnabled: flags.documentPipeline,
        now,
      });
      withLedger = { ...record, rawData: { ...(record.rawData ?? {}), requirementLedger: ledgerSummary(ledger) } };
    }
    const hash = judgmentContentHash(original, { documentHashes: documents?.documentHashes ?? [], profileVersion: profile.version });
    const reason = relevance.reasons.join("; ");
    const excluded = Boolean(ledger && ledger.assessment.exclusions.status === "fail" && ledger.assessment.scopeFit.supported === 0);
    const documentsIncomplete =
      flags.requireDocumentEvidence && (!documents || documents.documents.length === 0 || documents.documents.some((d) => d.extractionStatus !== "extracted"));

    if (ledger && persist && storageAvailable(persist)) {
      await saveLedger(key, hash, ledger).catch((error) => storageFailed(diagnostics, error));
    }

    if (documentsIncomplete) {
      const pending = documents?.documents.filter((d) => d.extractionStatus !== "extracted").length ?? 0;
      candidates.push({ record: withLedger, key, hash, score: relevance.score, reason, priority, injectionSignals: 0, verdict, ledger });
      held.push({
        record: withLedger,
        code: "structured_document_pending",
        reason: `Held for document verification: ${pending || "no"} official document(s) ${pending ? "still being read" : "found yet"}. ${reason}`.trim(),
      });
      continue;
    }

    if (!excluded && isDeterministicallyActionable(withLedger, now)) {
      approved.push(withDecision(withLedger, "deterministic", relevance.score, reason || "Explicit Occu-Med service scope with a future response deadline."));
      deterministicApproved += 1;
      continue;
    }

    candidates.push({
      record: withLedger,
      key,
      hash,
      score: relevance.score,
      reason: excluded ? `Documents exclude Occu-Med scope (${ledger!.assessment.exclusions.detail}). ${reason}`.trim() : reason,
      priority,
      injectionSignals: documentInjectionSignals(withLedger),
      verdict,
      ledger,
    });
  }

  const documentPending = new Set(held.filter((h) => h.code === "structured_document_pending").map((h) => opportunityKey(h.record)));
  const reviewable = candidates.filter((c) => !documentPending.has(c.key)).sort((a, b) => b.priority - a.priority || b.score - a.score);

  // Decision cache: an unchanged content hash (full text + documents + profile version) reuses its decision.
  let cache = new Map<string, CachedQueueDecision>();
  if (storageAvailable(persist) && reviewable.length > 0) {
    cache = await cachedQueueDecisions(reviewable.map((c) => c.key)).catch((error) => {
      storageFailed(diagnostics, error);
      return new Map<string, CachedQueueDecision>();
    });
  }
  const outcomes = new Map<string, Outcome>();
  let cached = 0;
  const toReview: Candidate[] = [];
  for (const candidate of reviewable) {
    const hit = cache.get(candidate.key);
    const decision = hit?.decision as (Outcome & { kind?: string }) | null | undefined;
    if (hit && hit.contentHash === candidate.hash && (hit.status === "decided" || hit.status === "held") && decision?.kind) {
      outcomes.set(candidate.key, decision as Outcome);
      cached += 1;
    } else if (candidate.injectionSignals > 0) {
      outcomes.set(candidate.key, {
        kind: "held",
        code: "structured_untrusted_content",
        reason: `The notice or its documents contain ${candidate.injectionSignals} instruction-like passage(s) aimed at reviewers; held for human review and never AI-approved.`,
        decided: true,
      });
    } else {
      toReview.push(candidate);
    }
  }

  const limit = structuredReviewCandidateLimit();
  const selected = limit == null ? toReview : toReview.slice(0, limit);
  for (const candidate of limit == null ? [] : toReview.slice(limit)) {
    outcomes.set(candidate.key, {
      kind: "held",
      code: "structured_review_budget",
      reason: `Queued for AI review: the configured per-call review ceiling (${limit}) was reached. ${candidate.reason}`.trim(),
      decided: false,
    });
  }

  // Adaptive review: batches continue while time remains and at least one judge family has capacity.
  const timeBudget = options.timeBudgetMs ?? structuredReviewTimeBudgetMs();
  const deadline = startedAt + timeBudget;
  const reviewers = new Set<string>();
  const families = new Set<string>();
  let judgeCalls = 0;
  let tokens = 0;
  let reviewed = 0;
  let stopReason: string | null = null;
  let profileContext: string | null = null;
  let configuredCount = 0;
  let anyJudgeSucceeded = false;
  const providers = options.reviewProviders ?? REVIEW_PROVIDERS;
  for (let start = 0; start < selected.length; start += REVIEW_BATCH_SIZE) {
    if (options.signal?.aborted) {
      stopReason = "cancelled";
      break;
    }
    if (Date.now() >= deadline) {
      stopReason = "time_budget";
      break;
    }
    const { judges, configured } = await availableJudges(providers);
    configuredCount = configured;
    if (judges.length === 0) {
      stopReason = configured === 0 ? "no_reviewer_configured" : "ai_capacity_exhausted";
      break;
    }
    const batch = selected.slice(start, start + REVIEW_BATCH_SIZE);
    let panel: PanelRun;
    try {
      profileContext ??= renderPromptContext(await getOccuMedPromptContext());
      panel = await reviewBatch(batch, judges, profileContext, deadline);
    } catch (error) {
      diagnostics.push(`structured review failed: ${error instanceof Error ? error.message : String(error)}`);
      stopReason = "review_error";
      break;
    }
    judgeCalls += panel.judgeCalls;
    tokens += panel.tokens;
    diagnostics.push(...panel.diagnostics);
    panel.reviewers.forEach((name) => reviewers.add(name));
    panel.families.forEach((family) => families.add(family));
    anyJudgeSucceeded ||= panel.anySuccess;
    batch.forEach((candidate, index) => {
      const outcome = panel.outcomes.get(index);
      if (outcome) outcomes.set(candidate.key, outcome);
    });
    reviewed += batch.length;
  }

  for (const candidate of selected) {
    if (outcomes.has(candidate.key)) continue;
    const noReviewer = stopReason === "no_reviewer_configured" || (configuredCount === 0 && !anyJudgeSucceeded && stopReason !== "time_budget");
    outcomes.set(candidate.key, {
      kind: "held",
      code: noReviewer ? "structured_review_failed" : "structured_review_queued",
      reason: noReviewer
        ? `AI review unavailable (no reviewer configured). ${candidate.reason}`.trim()
        : `Queued for automatic AI review (${stopReason === "time_budget" ? "this run's review time was used" : stopReason === "cancelled" ? "run cancelled" : "free AI capacity is used up until it resets"}). ${candidate.reason}`.trim(),
      decided: false,
    });
  }

  let aiApproved = 0;
  for (const candidate of reviewable) {
    const outcome = outcomes.get(candidate.key);
    if (!outcome) continue;
    if (outcome.kind === "approved") {
      approved.push(withDecision(candidate.record, outcome.method, outcome.score, outcome.reason, outcome.reviewers, outcome.families));
      aiApproved += 1;
    } else {
      held.push({ record: candidate.record, code: outcome.code, reason: outcome.reason });
    }
  }

  // Persist: every candidate is in the queue with its current content hash and status.
  let queuedCount = 0;
  if (storageAvailable(persist) && candidates.length > 0) {
    try {
      await enqueueForReview(
        candidates.map((candidate) => {
          const outcome = outcomes.get(candidate.key);
          return {
            opportunityKey: candidate.key,
            provider: options.provider ?? candidate.record.source ?? "structured",
            record: candidate.record,
            contentHash: candidate.hash,
            profileVersion: profile.version,
            priority: candidate.priority,
            holdCode: outcome?.kind === "held" ? outcome.code : documentPending.has(candidate.key) ? "structured_document_pending" : "approved",
            reason: outcome?.kind === "held" ? outcome.reason : outcome?.kind === "approved" ? outcome.reason : candidate.reason,
          };
        }),
      );
      for (const candidate of candidates) {
        const outcome = outcomes.get(candidate.key);
        if (documentPending.has(candidate.key)) {
          // The document worker reopens the item when extraction finishes.
          await settleByKey(candidate.key, candidate.hash, { status: "held", holdCode: "structured_document_pending" });
          continue;
        }
        if (!outcome) continue;
        const decided = outcome.kind === "approved" || outcome.decided;
        if (!decided) queuedCount += 1;
        await settleByKey(candidate.key, candidate.hash, {
          status: decided ? (outcome.kind === "held" && outcome.code === "structured_untrusted_content" ? "held" : "decided") : "queued",
          decision: decided ? (outcome as unknown as Record<string, unknown>) : null,
          holdCode: outcome.kind === "held" ? outcome.code : null,
          reason: outcome.reason,
          retryAt: decided ? null : nextRetry(stopReason, outcome),
        });
      }
    } catch (error) {
      storageFailed(diagnostics, error);
    }
  }

  return {
    approved,
    held,
    rejectedRecords,
    deterministicApproved,
    aiApproved,
    rejected,
    reviewHeld: held.length,
    reviewer: reviewers.size > 0 ? [...reviewers].join(",") : null,
    diagnostics: Array.from(new Set(diagnostics)).slice(0, 12),
    review: {
      candidates: reviewable.length,
      reviewed,
      cached,
      queued: queuedCount,
      judgeCalls,
      estimatedTokens: tokens,
      families: [...families],
      stopReason,
    },
  };
}

function documentInjectionSignals(record: NormalizedOpportunity): number {
  const evidence = documentEvidenceText(record);
  return neutraliseUntrustedText(`${record.title ?? ""}\n${record.description ?? ""}\n${evidence}`).injectionSignals;
}

/** Disputed records wait a little so a different family can pick them up; capacity waits are retried next run. */
function nextRetry(stopReason: string | null, outcome: Outcome): Date | null {
  if (outcome.kind === "held" && outcome.code === "structured_review_disputed") return new Date(Date.now() + 30 * 60_000);
  if (stopReason === "ai_capacity_exhausted") return new Date(Date.now() + 15 * 60_000);
  return null;
}

/** Test hook: clears the storage back-off. */
export function resetStructuredDecisionStateForTests(): void {
  storageUnavailableUntil = 0;
}
