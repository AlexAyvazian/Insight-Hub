import { createHash } from "node:crypto";
import type { NormalizedOpportunity } from "../providers/types";
import { classifyProviderRecordRelevance } from "../providers/providerQueryMatch";
import { getOccuMedPromptContext, renderPromptContext } from "./occumedPromptContext";
import { opportunityDescriptionContext } from "./opportunityDescriptionContext";
import { geminiProvider } from "../providers/gemini";
import { decideRelevance } from "./relevanceDecision";
import { getRelevanceProfile } from "./relevanceProfile";
import { SCOPE_BLOCK_HEADER, judgeScopeBlock, profileServiceLabels, scoreGuidance } from "./profileText";
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

interface JudgeProvider {
  name: string;
  isConfigured(): Promise<boolean>;
  complete(prompt: string, maxTokens?: number): Promise<string>;
}

export interface StructuredJudgeVote {
  judge: string;
  isOpportunity: boolean;
  relevanceScore: number;
  reason: string;
}

export interface StructuredJudgeDecision {
  approved: boolean;
  panelSize: number;
  yesVotes: number;
  noVotes: number;
  score: number;
  judges: string[];
  reasons: string[];
}

export interface StructuredJudgeResult {
  approved: NormalizedOpportunity[];
  rejected: number;
  deterministicRejected: number;
  panelRejected: number;
  unjudged: number;
  deferred: number;
  usedJudges: string[];
  errors: string[];
}

const JUDGE_PROVIDERS: JudgeProvider[] = [
  cerebrasProvider,
  groqProvider,
  openrouterProvider,
  mistralProvider,
  nvidiaProvider,
  minimaxProvider,
  clodProvider,
  geminiProvider,
  deepseekProvider,
];

export const STRUCTURED_JUDGE_PROVIDER_ORDER = JUDGE_PROVIDERS.map(
  (provider) => provider.name,
);

const PANEL_SIZE = 3;
const MIN_PANEL_SIZE = 2;
const CHUNK_SIZE = 4;
const DEFAULT_CANDIDATE_LIMIT = 10;
const PROVIDER_TIMEOUT_MS = 28_000;
const MAX_DESCRIPTION_CHARS = 12_000;
const MAX_OUTPUT_TOKENS = 900;
const CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
const SHORT_COOLDOWN_MS = 10 * 60 * 1_000;
const RATE_LIMIT_COOLDOWN_MS = 20 * 60 * 1_000;
const TERMINAL_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

interface CachedDecision {
  value: StructuredJudgeDecision;
  expiresAt: number;
}

interface ProviderCooldown {
  until: number;
  reason: string;
}

const decisionCache = new Map<string, CachedDecision>();
const providerCooldowns = new Map<string, ProviderCooldown>();

function cacheKey(record: NormalizedOpportunity): string {
  return createHash("sha256")
    .update(record.sourceUrl ?? "")
    .update("\n")
    .update(record.externalId ?? "")
    .update("\n")
    .update(record.title ?? "")
    .update("\n")
    .update((record.description ?? "").slice(0, 6_000))
    .digest("hex")
    .slice(0, 28);
}

function getCached(record: NormalizedOpportunity): StructuredJudgeDecision | null {
  const key = cacheKey(record);
  const entry = decisionCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    decisionCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(
  record: NormalizedOpportunity,
  decision: StructuredJudgeDecision,
): void {
  decisionCache.set(cacheKey(record), {
    value: decision,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function stripJson(text: string): string {
  return text
    .replace(/```json\n?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function parseJsonArray(text: string): unknown[] | null {
  const cleaned = stripJson(text);
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { results?: unknown[] }).results)
    ) {
      return (parsed as { results: unknown[] }).results;
    }
  } catch {}

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedScore(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function conciseError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function configuredCandidateLimit(): number {
  const parsed = Number.parseInt(
    process.env.STRUCTURED_RFP_JUDGE_CANDIDATE_LIMIT ?? "",
    10,
  );
  if (!Number.isFinite(parsed)) return DEFAULT_CANDIDATE_LIMIT;
  return Math.max(5, Math.min(30, parsed));
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function recordText(record: NormalizedOpportunity): string {
  return [
    `Title: ${record.title}`,
    `Buyer: ${record.agency}`,
    record.subAgency ? `Sub-agency: ${record.subAgency}` : "",
    `Notice type: ${record.type}`,
    record.solicitationNumber
      ? `Solicitation number: ${record.solicitationNumber}`
      : "",
    record.naicsCode ? `NAICS: ${record.naicsCode}` : "",
    record.naicsDescription
      ? `NAICS description: ${record.naicsDescription}`
      : "",
    record.placeOfPerformance
      ? `Place of performance: ${record.placeOfPerformance}`
      : "",
    record.responseDeadline
      ? `Response deadline: ${record.responseDeadline.toISOString()}`
      : "Response deadline: unknown",
    `Description: ${opportunityDescriptionContext(record.description, MAX_DESCRIPTION_CHARS)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPrompt(
  providerName: string,
  records: NormalizedOpportunity[],
  profileContext = "",
): string {
  const items = records
    .map((record, index) => `[${index}]\n${recordText(record)}`)
    .join("\n\n");

  return `You are one independent judge on a strict procurement relevance panel for Occu-Med.

Occu-Med can perform: ${profileServiceLabels().join("; ")}.
Source being reviewed: ${providerName}.
Today: ${new Date().toISOString().slice(0, 10)}.
${profileContext ? `\n${profileContext}\n` : ""}
${profileContext.includes(SCOPE_BLOCK_HEADER) ? "" : judgeScopeBlock()}

A YES verdict requires all of the following:
1. The record is a real procurement notice that is currently open for responses.
2. The PRIMARY PURCHASED SCOPE (not incidental boilerplate) is within the scope policies above.
3. Occu-Med could realistically bid as the prime or a meaningful subcontractor.

Return ONLY JSON in this shape:
{"results":[{"index":0,"isOpportunity":true,"relevanceScore":92,"reason":"The core scope purchases ${profileServiceLabels()[0] ?? "a listed service"}."}]}

Return exactly one result for every numbered item. Keep each reason under 25 words. Do not include markdown.
${scoreGuidance()} Be conservative.

ITEMS:
${items}`;
}

function cooldownRemaining(providerName: string): number {
  const entry = providerCooldowns.get(providerName);
  if (!entry) return 0;
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    providerCooldowns.delete(providerName);
    return 0;
  }
  return remaining;
}

function providerAvailable(provider: JudgeProvider): boolean {
  return cooldownRemaining(provider.name) === 0;
}

export function structuredJudgeFailureCooldownMs(error: unknown): number {
  const message = conciseError(error).toLowerCase();
  if (
    /\b(?:401|402|403)\b/.test(message) ||
    /invalid api key|api key not valid|unauthori[sz]ed|insufficient balance|payment required|account disabled|permission denied|invalid credential/.test(
      message,
    )
  ) {
    return TERMINAL_COOLDOWN_MS;
  }
  if (
    /\b429\b|rate limit|quota exceeded|too many requests|resource exhausted/.test(
      message,
    )
  ) {
    return RATE_LIMIT_COOLDOWN_MS;
  }
  return SHORT_COOLDOWN_MS;
}

function coolProvider(provider: JudgeProvider, error: unknown): void {
  providerCooldowns.set(provider.name, {
    until: Date.now() + structuredJudgeFailureCooldownMs(error),
    reason: conciseError(error),
  });
}

function clearProviderCooldown(provider: JudgeProvider): void {
  providerCooldowns.delete(provider.name);
}

export function shouldSplitStructuredJudgeBatch(error: unknown): boolean {
  const message = conciseError(error).toLowerCase();
  return /request too large|\b413\b|context (?:length|window)|too many tokens|token limit|malformed panel json|returned only \d+\/\d+ panel decisions/.test(
    message,
  );
}

async function completeWithTimeout(
  provider: JudgeProvider,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Request cancelled", "AbortError");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${provider.name} judge timed out`)),
      PROVIDER_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([
      provider.complete(prompt, MAX_OUTPUT_TOKENS),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runJudgeBatch(
  provider: JudgeProvider,
  providerName: string,
  records: NormalizedOpportunity[],
  signal?: AbortSignal,
): Promise<Map<number, StructuredJudgeVote>> {
  const text = await completeWithTimeout(
    provider,
    buildPrompt(providerName, records, renderPromptContext(await getOccuMedPromptContext())),
    signal,
  );
  const rows = parseJsonArray(text);
  if (!rows) throw new Error(`${provider.name} returned malformed panel JSON`);

  const votes = new Map<number, StructuredJudgeVote>();
  rows.forEach((raw, order) => {
    if (!raw || typeof raw !== "object") return;
    const object = raw as JsonRecord;
    const parsedIndex = Number(object.index);
    const index = Number.isInteger(parsedIndex) ? parsedIndex : order;
    if (index < 0 || index >= records.length) return;
    const isOpportunity = object.isOpportunity === true;
    const reason =
      typeof object.reason === "string" && object.reason.trim()
        ? object.reason.trim().slice(0, 500)
        : isOpportunity
          ? "Judge approved the record as a core Occu-Med procurement."
          : "Judge rejected the record as unrelated or insufficiently supported.";
    votes.set(index, {
      judge: provider.name,
      isOpportunity,
      relevanceScore: boundedScore(object.relevanceScore),
      reason,
    });
  });

  if (votes.size < records.length) {
    throw new Error(
      `${provider.name} returned only ${votes.size}/${records.length} panel decisions`,
    );
  }
  return votes;
}

async function runJudge(
  provider: JudgeProvider,
  providerName: string,
  records: NormalizedOpportunity[],
  signal?: AbortSignal,
): Promise<Map<number, StructuredJudgeVote>> {
  if (!providerAvailable(provider)) {
    const cooldown = providerCooldowns.get(provider.name);
    throw new Error(
      `${provider.name} judge is cooling down after: ${cooldown?.reason ?? "provider failure"}`,
    );
  }

  try {
    const votes = await runJudgeBatch(
      provider,
      providerName,
      records,
      signal,
    );
    clearProviderCooldown(provider);
    return votes;
  } catch (error) {
    if (records.length > 1 && shouldSplitStructuredJudgeBatch(error)) {
      const midpoint = Math.ceil(records.length / 2);
      const halves = [
        records.slice(0, midpoint),
        records.slice(midpoint),
      ].filter((items) => items.length > 0);
      const merged = new Map<number, StructuredJudgeVote>();
      let offset = 0;
      for (const half of halves) {
        const votes = await runJudge(provider, providerName, half, signal);
        for (const [index, vote] of votes) {
          merged.set(index + offset, vote);
        }
        offset += half.length;
      }
      clearProviderCooldown(provider);
      return merged;
    }

    coolProvider(provider, error);
    throw error;
  }
}

export function aggregateJudgePanelVotes(
  votes: StructuredJudgeVote[],
): StructuredJudgeDecision {
  const yesVotes = votes.filter((vote) => vote.isOpportunity);
  const noVotes = votes.length - yesVotes.length;
  const yesScores = yesVotes
    .map((vote) => vote.relevanceScore)
    .sort((left, right) => left - right);
  const score = yesScores.length
    ? Math.round(
        yesScores.reduce((sum, value) => sum + value, 0) / yesScores.length,
      )
    : 0;
  const requiredYes = votes.length >= 3 ? 2 : MIN_PANEL_SIZE;
  const approved =
    votes.length >= MIN_PANEL_SIZE &&
    yesVotes.length >= requiredYes &&
    score >= getRelevanceProfile().thresholds.acceptMin &&
    yesScores.every((value) => value >= getRelevanceProfile().thresholds.acceptMin);

  return {
    approved,
    panelSize: votes.length,
    yesVotes: yesVotes.length,
    noVotes,
    score,
    judges: votes.map((vote) => vote.judge),
    reasons: Array.from(new Set(votes.map((vote) => vote.reason))).slice(0, 4),
  };
}

function existingTags(record: NormalizedOpportunity): string[] {
  const tags = record.rawData?.tags;
  return Array.isArray(tags)
    ? tags.filter(
        (tag): tag is string => typeof tag === "string" && tag.trim().length > 0,
      )
    : [];
}

function approvedRecord(
  record: NormalizedOpportunity,
  decision: StructuredJudgeDecision,
): NormalizedOpportunity {
  const summary = `Judge panel ${decision.yesVotes}/${decision.panelSize} approved: ${decision.reasons.join(" ")}`;
  return {
    ...record,
    rawData: {
      ...(record.rawData ?? {}),
      relevanceScore: decision.score,
      relevanceReason: summary,
      judgePanelApproved: true,
      judgePanel: decision,
      tags: Array.from(
        new Set([...existingTags(record), "judge-panel-approved"]),
      ),
    },
  };
}

async function collectInitialPanelVotes(
  providers: JudgeProvider[],
  providerName: string,
  group: NormalizedOpportunity[],
  signal: AbortSignal | undefined,
  diagnostics: string[],
  usedJudges: Set<string>,
  groupJudgeNames: Set<string>,
): Promise<Array<Map<number, StructuredJudgeVote>>> {
  const votes: Array<Map<number, StructuredJudgeVote>> = [];
  const available = providers.filter(providerAvailable);
  const firstWave = available.slice(0, MIN_PANEL_SIZE);
  const firstResults = await Promise.allSettled(
    firstWave.map((provider) => runJudge(provider, providerName, group, signal)),
  );

  firstResults.forEach((result, index) => {
    const provider = firstWave[index];
    if (!provider) return;
    if (result.status === "fulfilled") {
      votes.push(result.value);
      usedJudges.add(provider.name);
      groupJudgeNames.add(provider.name);
      return;
    }
    diagnostics.push(`${provider.name} judge: ${conciseError(result.reason)}`);
  });

  for (const provider of available.slice(MIN_PANEL_SIZE)) {
    if (votes.length >= MIN_PANEL_SIZE) break;
    try {
      const result = await runJudge(provider, providerName, group, signal);
      votes.push(result);
      usedJudges.add(provider.name);
      groupJudgeNames.add(provider.name);
    } catch (error) {
      diagnostics.push(`${provider.name} judge: ${conciseError(error)}`);
    }
  }

  return votes;
}

function logRecoveredJudgeDiagnostics(
  providerName: string,
  diagnostics: string[],
): void {
  if (diagnostics.length === 0) return;
  console.warn(
    JSON.stringify({
      event: "rfp_judge_provider_failover_recovered",
      sourceProvider: providerName,
      failures: Array.from(new Set(diagnostics)).slice(0, 12),
    }),
  );
}

export async function judgeStructuredOpportunities(
  records: NormalizedOpportunity[],
  options: { providerName: string; signal?: AbortSignal },
): Promise<StructuredJudgeResult> {
  const errors: string[] = [];
  const diagnostics: string[] = [];
  const usedJudges = new Set<string>();
  const deterministic = records
    .map((record) => ({
      record,
      relevance: classifyProviderRecordRelevance(record),
    }))
    .filter(
      ({ relevance }) =>
        decideRelevance(relevance).verdict !== "reject" &&
        relevance.confidence !== "possible_adjacent",
    )
    .sort((left, right) => {
      const scoreDelta = right.relevance.score - left.relevance.score;
      if (scoreDelta) return scoreDelta;
      const leftDeadline = left.record.responseDeadline?.getTime() ?? Infinity;
      const rightDeadline = right.record.responseDeadline?.getTime() ?? Infinity;
      return leftDeadline - rightDeadline;
    });

  const deterministicRejected = records.length - deterministic.length;
  const limit = configuredCandidateLimit();
  const selected = deterministic.slice(0, limit).map(({ record }) => record);
  const deferred = Math.max(0, deterministic.length - selected.length);
  const approved: NormalizedOpportunity[] = [];
  let panelRejected = 0;
  let unjudged = 0;

  const configured: JudgeProvider[] = [];
  for (const provider of JUDGE_PROVIDERS) {
    try {
      if ((await provider.isConfigured()) && providerAvailable(provider)) {
        configured.push(provider);
      }
    } catch (error) {
      diagnostics.push(
        `${provider.name} configuration check: ${conciseError(error)}`,
      );
    }
  }

  for (const group of chunk(selected, CHUNK_SIZE)) {
    if (options.signal?.aborted) break;

    const cached = group.map((record) => getCached(record));
    const requiresPanel = cached.some((decision) => !decision);
    const providerVotes: Array<Map<number, StructuredJudgeVote>> = [];
    const groupJudgeNames = new Set<string>();

    if (requiresPanel) {
      providerVotes.push(
        ...(await collectInitialPanelVotes(
          configured,
          options.providerName,
          group,
          options.signal,
          diagnostics,
          usedJudges,
          groupJudgeNames,
        )),
      );

      const disagreement = group.some((_record, index) => {
        const votes = providerVotes
          .map((map) => map.get(index))
          .filter((vote): vote is StructuredJudgeVote => Boolean(vote));
        return (
          votes.length >= MIN_PANEL_SIZE &&
          votes.some((vote) => vote.isOpportunity) &&
          votes.some((vote) => !vote.isOpportunity)
        );
      });

      if (disagreement && providerVotes.length >= MIN_PANEL_SIZE) {
        for (const provider of configured.filter(providerAvailable)) {
          if (groupJudgeNames.has(provider.name)) continue;
          try {
            const votes = await runJudge(
              provider,
              options.providerName,
              group,
              options.signal,
            );
            providerVotes.push(votes);
            usedJudges.add(provider.name);
            groupJudgeNames.add(provider.name);
            break;
          } catch (error) {
            diagnostics.push(
              `${provider.name} tie-break judge: ${conciseError(error)}`,
            );
          }
        }
      }
    }

    group.forEach((record, index) => {
      let decision = cached[index];
      if (!decision) {
        const votes = providerVotes
          .map((map) => map.get(index))
          .filter((vote): vote is StructuredJudgeVote => Boolean(vote))
          .slice(0, PANEL_SIZE);
        decision = aggregateJudgePanelVotes(votes);
        if (decision.panelSize >= MIN_PANEL_SIZE) setCached(record, decision);
      }

      if (decision.panelSize < MIN_PANEL_SIZE) {
        unjudged += 1;
        return;
      }
      if (!decision.approved) {
        panelRejected += 1;
        return;
      }
      approved.push(approvedRecord(record, decision));
    });
  }

  const uniqueDiagnostics = Array.from(new Set(diagnostics));
  if (selected.length > 0 && configured.length < MIN_PANEL_SIZE) {
    errors.push(
      `Structured RFP judge panel requires at least ${MIN_PANEL_SIZE} healthy AI judges; only ${configured.length} were available. Invalid, exhausted, or failing keys were skipped.`,
    );
  } else if (unjudged > 0) {
    errors.push(
      `Structured RFP judge panel could not obtain two complete decisions for ${unjudged} candidate${unjudged === 1 ? "" : "s"}. ${uniqueDiagnostics.slice(0, 4).join(" | ")}`,
    );
  } else {
    logRecoveredJudgeDiagnostics(options.providerName, uniqueDiagnostics);
  }

  return {
    approved,
    rejected: deterministicRejected + panelRejected + unjudged + deferred,
    deterministicRejected,
    panelRejected,
    unjudged,
    deferred,
    usedJudges: [...usedJudges],
    errors: Array.from(new Set(errors)).slice(0, 4),
  };
}

export function clearStructuredJudgeCache(): void {
  decisionCache.clear();
  providerCooldowns.clear();
}
