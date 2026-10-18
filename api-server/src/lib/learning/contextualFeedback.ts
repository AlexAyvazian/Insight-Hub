import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { rfpDb, rfpPool, settingsTable } from "@workspace/db";
import { opportunitiesTable } from "@workspace/db/schema";
import type { FeedbackGrade } from "./feedbackModel";
import { classifyResult } from "../search/relevance";
import { getRelevanceProfile } from "../search/relevanceProfile";

const PREFIX = "feedback-context:v1:";
const MAX_ADJUSTMENT = 20;
const MAX_AGENCIES = 128;
const MAX_NAICS = 256;
const MAX_TAGS = 512;
const MAX_KEYWORDS = 1_024;
const MAX_GRADES_BY_OPPORTUNITY = 5_000;
const GRADE_WEIGHT: Record<FeedbackGrade, number> = {
  excellent: 2,
  good: 1,
  poor: -1,
  spam: -2,
};

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "services",
  "service",
  "contract",
  "solicitation",
  "rfp",
  "request",
  "federal",
  "government",
]);

export interface ContextSignalState {
  context: string;
  contextHash: string;
  grades: number;
  gradesByOpportunity: Record<string, FeedbackGrade>;
  agencies: Record<string, number>;
  naics: Record<string, number>;
  tags: Record<string, number>;
  keywords: Record<string, number>;
  updatedAt: string;
}

type OpportunityLike = Record<string, any>;

function words(value: unknown): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

export function normalizeQueryContext(value: unknown): string | null {
  const tokens = Array.from(new Set(words(value))).slice(0, 18);
  return tokens.length ? tokens.join(" ") : null;
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return raw
      .split(/[,;|]/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
}

/**
 * Service-line scopes of a notice: the profile categories the one classifier matches in its text.
 * Scope keys are the profile category ids (underscores hyphenated), so they follow the Neon profile.
 */
function serviceScopes(text: string): string[] {
  const profile = getRelevanceProfile();
  const labelToId = new Map(profile.categories.map((c) => [c.label, c.id]));
  const result = classifyResult({ title: text, allowHistorical: true });
  const scopes = new Set<string>();
  for (const label of result.matchedServiceCategories) {
    const id = labelToId.get(label);
    if (id) scopes.add(id.replace(/_/g, "-"));
  }
  return [...scopes];
}

export function deriveOpportunityContext(
  opportunity: OpportunityLike,
  explicitContext?: string | null,
): string {
  const explicit = normalizeQueryContext(explicitContext);
  if (explicit) return `query:${explicit}`;

  const text = [
    opportunity.title,
    opportunity.description,
    opportunity.naicsDescription,
    parseTags(opportunity.tags).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
  const scopes = serviceScopes(text);
  const agency = normalizeQueryContext(opportunity.agency)
    ?.split(" ")
    .slice(0, 4)
    .join(" ");
  if (scopes.length) {
    return `scope:${scopes.sort().join("+")}${agency ? ` agency:${agency}` : ""}`;
  }

  const fallback = normalizeQueryContext(
    `${opportunity.title ?? ""} ${opportunity.naicsCode ?? ""}`,
  );
  return `scope:${fallback ?? "general"}`;
}

export function contextHash(context: string): string {
  return createHash("sha256").update(context).digest("hex").slice(0, 16);
}

function blank(context: string): ContextSignalState {
  return {
    context,
    contextHash: contextHash(context),
    grades: 0,
    gradesByOpportunity: {},
    agencies: {},
    naics: {},
    tags: {},
    keywords: {},
    updatedAt: new Date(0).toISOString(),
  };
}

function parseState(
  context: string,
  raw: string | undefined,
): ContextSignalState {
  if (!raw) return blank(context);
  try {
    const parsed = JSON.parse(raw) as Partial<ContextSignalState>;
    return {
      ...blank(context),
      ...parsed,
      context,
      contextHash: contextHash(context),
      gradesByOpportunity:
        parsed.gradesByOpportunity &&
        typeof parsed.gradesByOpportunity === "object" &&
        !Array.isArray(parsed.gradesByOpportunity)
          ? (parsed.gradesByOpportunity as Record<string, FeedbackGrade>)
          : {},
    };
  } catch {
    return blank(context);
  }
}

async function load(context: string): Promise<ContextSignalState> {
  const hash = contextHash(context);
  try {
    const [row] = await rfpDb
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, `${PREFIX}${hash}`))
      .limit(1);
    return parseState(context, row?.value);
  } catch {
    return blank(context);
  }
}

async function loadContexts(
  contexts: Map<string, string>,
): Promise<Map<string, ContextSignalState>> {
  const states = new Map<string, ContextSignalState>();
  const entries = Array.from(contexts.entries());
  if (entries.length === 0) return states;

  const keys = entries.map(([hash]) => `${PREFIX}${hash}`);
  try {
    const rows = await rfpDb
      .select({ key: settingsTable.key, value: settingsTable.value })
      .from(settingsTable)
      .where(inArray(settingsTable.key, keys));
    const values = new Map(rows.map((row) => [row.key, row.value] as const));
    for (const [hash, context] of entries) {
      states.set(hash, parseState(context, values.get(`${PREFIX}${hash}`)));
    }
  } catch {
    for (const [hash, context] of entries) states.set(hash, blank(context));
  }
  return states;
}

function add(map: Record<string, number>, key: unknown, weight: number): void {
  const normalized = String(key ?? "").trim().toLowerCase();
  if (!normalized) return;
  const next = (map[normalized] ?? 0) + weight;
  if (Math.abs(next) < 0.000001) delete map[normalized];
  else map[normalized] = next;
}

function pruneSignalMap(map: Record<string, number>, limit: number): void {
  const entries = Object.entries(map);
  if (entries.length <= limit) return;
  entries
    .sort((left, right) => {
      const magnitude = Math.abs(right[1]) - Math.abs(left[1]);
      return magnitude !== 0 ? magnitude : left[0].localeCompare(right[0]);
    })
    .slice(limit)
    .forEach(([key]) => delete map[key]);
}

function pruneContextState(state: ContextSignalState): void {
  pruneSignalMap(state.agencies, MAX_AGENCIES);
  pruneSignalMap(state.naics, MAX_NAICS);
  pruneSignalMap(state.tags, MAX_TAGS);
  pruneSignalMap(state.keywords, MAX_KEYWORDS);

  const gradeIds = Object.keys(state.gradesByOpportunity);
  const overflow = gradeIds.length - MAX_GRADES_BY_OPPORTUNITY;
  if (overflow > 0) {
    for (const id of gradeIds.slice(0, overflow)) {
      delete state.gradesByOpportunity[id];
    }
  }
}

function keywordSignals(opportunity: OpportunityLike): string[] {
  return Array.from(
    new Set(
      words(`${opportunity.title ?? ""} ${opportunity.description ?? ""}`),
    ),
  ).slice(0, 40);
}

function applyContribution(
  state: ContextSignalState,
  opportunity: OpportunityLike,
  weight: number,
): void {
  add(state.agencies, opportunity.agency, weight);
  add(state.naics, opportunity.naicsCode, weight);
  for (const tag of parseTags(opportunity.tags)) add(state.tags, tag, weight);
  for (const keyword of keywordSignals(opportunity)) {
    add(state.keywords, keyword, weight);
  }
}

export async function recordContextFeedback(
  opportunityId: string,
  grade: FeedbackGrade,
  explicitContext?: string | null,
): Promise<{ context: string; contextHash: string }> {
  const [opportunity] = await rfpDb
    .select()
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opportunityId))
    .limit(1);
  if (!opportunity) throw new Error(`Opportunity ${opportunityId} not found`);

  const context = deriveOpportunityContext(opportunity, explicitContext);
  const hash = contextHash(context);
  const key = `${PREFIX}${hash}`;
  const client = await rfpPool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    const result = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = $1 FOR UPDATE",
      [key],
    );
    const state = parseState(context, result.rows[0]?.value);
    const previousGrade = state.gradesByOpportunity[opportunityId];

    if (previousGrade) {
      applyContribution(state, opportunity, -GRADE_WEIGHT[previousGrade]);
      delete state.gradesByOpportunity[opportunityId];
    } else {
      state.grades += 1;
    }
    applyContribution(state, opportunity, GRADE_WEIGHT[grade]);
    state.gradesByOpportunity[opportunityId] = grade;
    pruneContextState(state);
    state.updatedAt = new Date().toISOString();

    await client.query(
      `INSERT INTO settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(state)],
    );
    await client.query("COMMIT");
    return { context, contextHash: hash };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function adjustmentFor(
  opportunity: OpportunityLike,
  state: ContextSignalState,
): number {
  if (state.grades === 0) return 0;
  let score = 0;
  const agency = String(opportunity.agency ?? "")
    .trim()
    .toLowerCase();
  const naics = String(opportunity.naicsCode ?? "")
    .trim()
    .toLowerCase();
  if (agency && state.agencies[agency] != null) {
    score += state.agencies[agency] * 5;
  }
  if (naics && state.naics[naics] != null) score += state.naics[naics] * 4;
  for (const tag of parseTags(opportunity.tags)) {
    const value = state.tags[tag.toLowerCase()];
    if (value != null) score += value * 2;
  }
  for (const keyword of keywordSignals(opportunity)) {
    const value = state.keywords[keyword];
    if (value != null) score += value;
  }
  return Math.max(
    -MAX_ADJUSTMENT,
    Math.min(MAX_ADJUSTMENT, Math.round(score)),
  );
}

export async function contextualAdjustments(
  opportunities: OpportunityLike[],
  explicitContext?: string | null,
): Promise<
  Map<string, { adjustment: number; context: string; contextHash: string }>
> {
  // Derive each opportunity's context once (it runs the classifier) and reuse it for the lookup and the result.
  const derived = opportunities.map((opportunity) => {
    const context = deriveOpportunityContext(opportunity, explicitContext);
    return { opportunity, context, hash: contextHash(context) };
  });
  const contexts = new Map<string, string>();
  for (const { context, hash } of derived) contexts.set(hash, context);
  const states = await loadContexts(contexts);

  const result = new Map<
    string,
    { adjustment: number; context: string; contextHash: string }
  >();
  for (const { opportunity, context, hash } of derived) {
    result.set(String(opportunity.id), {
      adjustment: adjustmentFor(
        opportunity,
        states.get(hash) ?? blank(context),
      ),
      context,
      contextHash: hash,
    });
  }
  return result;
}

export async function contextualFeedbackSummary(context?: string | null) {
  const normalized = normalizeQueryContext(context);
  if (!normalized) return { context: null, state: null };
  const resolved = `query:${normalized}`;
  return { context: resolved, state: await load(resolved) };
}
