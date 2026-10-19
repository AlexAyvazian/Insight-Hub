/**
 * One authoritative, versioned decision per opportunity (Opportunities wave 4: qualification).
 *
 * structuredOpportunityDecision writes exactly one row per opportunity key into opportunity_decisions: the outcome
 * state, the inputs hash it was judged on (judgmentContentHash: full notice + every document hash + the
 * OCCU_MED_AWARE profile version), the evaluator version, the cited primary purchased scope and the validated
 * evaluator citations. A new settled decision for the same opportunity increments decision_version and keeps the
 * previous one in opportunity_audit_log.
 *
 * States:
 *   qualified    approved on evidence (primary purchased scope evidenced or validly cited, documents complete)
 *   provisional  approved, but documents are still being read or the evidence is partial; or held only because
 *                documents are pending
 *   needs_review unresolved: abstention, conflict/dispute, unverifiable citations, untrusted content, waiting on AI
 *   out_of_scope rejected by the relevance rules or declined by the evaluator
 *   closed       the response deadline has passed
 *
 * Reopen: when the inputs change (new documents, amendments, requirements or a new profile version) the stored
 * decision is marked stale and the opportunity re-enters the review queue. Read-time routes use a stored decision
 * only while it is current (not stale, same profile version, same notice text as the stored row).
 */
import { createHash } from "node:crypto";
import type { NormalizedOpportunity } from "../providers/types";
import { rcPool } from "./db";
import { ensureReleaseCSchema } from "./schema";
import { sectionCitationLabel, type EvidenceSection } from "./requirements";
import type { DecisionAuthority } from "./flags";

/** Bumped when the decision logic changes meaningfully; stored with every decision. */
export const DECISION_EVALUATOR_VERSION = "opportunity-decision-2026-10-18";

export type DecisionState = "qualified" | "needs_review" | "provisional" | "out_of_scope" | "closed";
export type DecisionOutcome = "approved" | "held" | "rejected";

/** A passage the evaluator cites: the bracketed document citation (or "notice") and an exact quote. */
export interface DecisionCitation {
  section: string | null;
  quote: string;
}

export interface ValidatedCitation extends DecisionCitation {
  /** The stored section the quote was found in (null when it came from the notice text). */
  sectionId: string | null;
}

export interface CitationCheck {
  valid: ValidatedCitation[];
  dropped: Array<DecisionCitation & { why: "quote_too_short" | "unknown_section" | "quote_not_found" }>;
}

const MIN_QUOTE_CHARS = 12;
const NOTICE_REFS = /^\s*\[?\s*(?:notice|description|notice description|title|listing)\s*\]?\s*$/i;

function normalizeQuoteText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/[^\p{L}\p{N}%$'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Each part of a quote (split at an ellipsis) must appear, in order, in the text. */
function quoteFound(quote: string, text: string): boolean {
  const haystack = normalizeQuoteText(text);
  const parts = quote.split(/\.{3}|…/).map(normalizeQuoteText).filter(Boolean);
  if (parts.length === 0) return false;
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

function sectionForRef(ref: string, sections: EvidenceSection[]): EvidenceSection | null {
  const wanted = ref.trim().replace(/^\[|\]$/g, "").trim().toLowerCase();
  if (!wanted) return null;
  return (
    sections.find((s) => s.id != null && s.id.toLowerCase() === wanted) ??
    sections.find((s) => sectionCitationLabel(s).slice(1, -1).trim().toLowerCase() === wanted) ??
    null
  );
}

/**
 * Checks evaluator citations against what is actually stored: a cited section must exist among the stored document
 * sections (by id or by its bracketed citation), and the quote must occur in that section, or, for "notice"
 * citations, in the notice text. Anything else is dropped; it never counts as evidence.
 */
export function validateCitations(
  citations: DecisionCitation[] | undefined,
  context: { sections: EvidenceSection[]; noticeText: string },
): CitationCheck {
  const check: CitationCheck = { valid: [], dropped: [] };
  for (const citation of citations ?? []) {
    const quote = String(citation.quote ?? "").slice(0, 600);
    const section = citation.section == null ? null : String(citation.section).slice(0, 200);
    const entry = { section, quote };
    if (normalizeQuoteText(quote).length < MIN_QUOTE_CHARS) {
      check.dropped.push({ ...entry, why: "quote_too_short" });
      continue;
    }
    if (!section || NOTICE_REFS.test(section)) {
      if (quoteFound(quote, context.noticeText)) {
        check.valid.push({ ...entry, sectionId: null });
        continue;
      }
      const found = context.sections.find((s) => quoteFound(quote, s.text));
      if (found) check.valid.push({ ...entry, sectionId: found.id });
      else check.dropped.push({ ...entry, why: "quote_not_found" });
      continue;
    }
    const stored = sectionForRef(section, context.sections);
    if (!stored) {
      check.dropped.push({ ...entry, why: "unknown_section" });
      continue;
    }
    if (quoteFound(quote, stored.text)) check.valid.push({ ...entry, sectionId: stored.id });
    else check.dropped.push({ ...entry, why: "quote_not_found" });
  }
  return check;
}

/** Maps an outcome to its state. Abstention and conflicts are never approval or rejection: needs_review. */
export function decisionStateFor(input: {
  outcome: DecisionOutcome;
  holdCode?: string | null;
  /** The evaluator(s) answered "not an opportunity" (as opposed to a low score or no answer). */
  evaluatorRejected?: boolean;
  responseDeadline?: Date | null;
  /** Documents are registered but not all read yet. */
  documentsPartial?: boolean;
  /** Primary purchased scope evidenced, or at least one evaluator citation verified. */
  evidenceBacked?: boolean;
  now?: number;
}): DecisionState {
  const deadline = input.responseDeadline instanceof Date ? input.responseDeadline.getTime() : Number.NaN;
  if (Number.isFinite(deadline) && deadline < (input.now ?? Date.now())) return "closed";
  if (input.outcome === "rejected") return "out_of_scope";
  if (input.outcome === "approved") return input.documentsPartial || input.evidenceBacked === false ? "provisional" : "qualified";
  if (input.holdCode === "structured_document_pending") return "provisional";
  if (input.holdCode === "structured_review_declined" && input.evaluatorRejected) return "out_of_scope";
  return "needs_review";
}

/** Notice text identity shared by the ingested record and its stored row (title + full description). */
export function noticeFingerprint(title: unknown, description: unknown): string {
  const norm = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${norm(title)}\n${norm(description)}`).digest("hex").slice(0, 32);
}

export interface DecisionRecordInput {
  opportunityKey: string;
  provider: string;
  inputsHash: string;
  profileVersion: string | null;
  evaluatorVersion: string;
  noticeFingerprint: string;
  state: DecisionState;
  outcome: DecisionOutcome;
  /** False while the outcome still waits on review (queued, capacity, dispute, documents): never replaces a settled decision. */
  settled: boolean;
  method: string | null;
  holdCode: string | null;
  score: number | null;
  reason: string;
  primaryScope: unknown;
  citations: CitationCheck | null;
  /** Why a second evaluator was asked, when one was. */
  escalation: string | null;
  reviewers: string[];
  families: string[];
  /** Snapshot used to put the opportunity back into the review queue when it is reopened. */
  record: NormalizedOpportunity | null;
  /** The queue hash a review-queue drain claimed; a decision that has since moved to another version is left alone. */
  expectedHash?: string | null;
}

export interface StoredDecision {
  opportunityKey: string;
  decisionVersion: number;
  evaluatorVersion: string;
  inputsHash: string;
  pendingInputsHash: string | null;
  profileVersion: string | null;
  noticeFingerprint: string | null;
  state: DecisionState;
  outcome: DecisionOutcome;
  settled: boolean;
  method: string | null;
  holdCode: string | null;
  score: number | null;
  reason: string | null;
  primaryScope: unknown;
  citations: CitationCheck | null;
  escalation: string | null;
  reviewers: string[];
  families: string[];
  stale: boolean;
  staleReason: string | null;
  decidedAt: string | null;
}

function toStored(row: Record<string, unknown>): StoredDecision {
  const date = (value: unknown) => (value instanceof Date ? value.toISOString() : value == null ? null : String(value));
  return {
    opportunityKey: String(row.opportunity_key),
    decisionVersion: Number(row.decision_version),
    evaluatorVersion: String(row.evaluator_version),
    inputsHash: String(row.inputs_hash),
    pendingInputsHash: (row.pending_inputs_hash as string | null) ?? null,
    profileVersion: (row.profile_version as string | null) ?? null,
    noticeFingerprint: (row.notice_fingerprint as string | null) ?? null,
    state: row.state as DecisionState,
    outcome: row.outcome as DecisionOutcome,
    settled: Boolean(row.settled),
    method: (row.method as string | null) ?? null,
    holdCode: (row.hold_code as string | null) ?? null,
    score: row.score == null ? null : Number(row.score),
    reason: (row.reason as string | null) ?? null,
    primaryScope: row.primary_scope ?? null,
    citations: (row.citations as CitationCheck | null) ?? null,
    escalation: (row.escalation as string | null) ?? null,
    reviewers: Array.isArray(row.reviewers) ? (row.reviewers as string[]) : [],
    families: Array.isArray(row.families) ? (row.families as string[]) : [],
    stale: Boolean(row.stale),
    staleReason: (row.stale_reason as string | null) ?? null,
    decidedAt: date(row.decided_at),
  };
}

const DECISION_COLUMNS = `opportunity_key, decision_version, evaluator_version, inputs_hash, pending_inputs_hash, profile_version,
  notice_fingerprint, state, outcome, settled, method, hold_code, score, reason, primary_scope, citations, escalation,
  reviewers, families, stale, stale_reason, decided_at`;

/** Current decision rows for these opportunity keys. */
export async function storedDecisions(keys: string[]): Promise<Map<string, StoredDecision>> {
  const out = new Map<string, StoredDecision>();
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return out;
  await ensureReleaseCSchema();
  const result = await (await rcPool()).query(
    `SELECT ${DECISION_COLUMNS} FROM opportunity_decisions WHERE opportunity_key = ANY($1::text[])`,
    [unique],
  );
  for (const row of result.rows) out.set(String(row.opportunity_key), toStored(row as Record<string, unknown>));
  return out;
}

function sameContent(existing: StoredDecision, input: DecisionRecordInput): boolean {
  return (
    existing.inputsHash === input.inputsHash &&
    existing.state === input.state &&
    existing.outcome === input.outcome &&
    existing.method === input.method &&
    existing.holdCode === input.holdCode &&
    existing.evaluatorVersion === input.evaluatorVersion &&
    existing.settled === input.settled
  );
}

/**
 * Writes the decisions of one decision call. Per opportunity:
 *   - no row yet: inserted as version 1 (a relevance rejection of a never-decided record is not stored);
 *   - a settled outcome: replaces the row, incrementing decision_version when anything changed, and clears staleness;
 *   - an unsettled outcome on new inputs over a settled decision: the decision is kept but marked stale
 *     (inputs_changed) with the pending inputs hash, while the queue reviews the new version.
 */
export async function saveDecisions(inputs: DecisionRecordInput[]): Promise<{ inserted: number; superseded: number; staled: number; unchanged: number }> {
  const counts = { inserted: 0, superseded: 0, staled: 0, unchanged: 0 };
  if (inputs.length === 0) return counts;
  await ensureReleaseCSchema();
  const pool = await rcPool();
  const existing = await storedDecisions(inputs.map((input) => input.opportunityKey));
  for (const input of inputs) {
    const row = existing.get(input.opportunityKey);
    if (
      row &&
      input.expectedHash &&
      row.inputsHash !== input.expectedHash &&
      row.pendingInputsHash !== input.expectedHash &&
      row.inputsHash !== input.inputsHash
    ) {
      counts.unchanged += 1; // a newer version was decided meanwhile
      continue;
    }
    const values = [
      input.opportunityKey,
      input.evaluatorVersion,
      input.inputsHash,
      input.profileVersion,
      input.noticeFingerprint,
      input.state,
      input.outcome,
      input.settled,
      input.method,
      input.holdCode,
      input.score,
      input.reason.slice(0, 1_000),
      JSON.stringify(input.primaryScope ?? null),
      JSON.stringify(input.citations ?? null),
      input.escalation,
      JSON.stringify(input.reviewers),
      JSON.stringify(input.families),
      input.record ? JSON.stringify(input.record) : null,
      input.provider,
    ];
    if (!row) {
      if (input.outcome === "rejected") continue;
      const result = await pool.query(
        `INSERT INTO opportunity_decisions (opportunity_key, decision_version, evaluator_version, inputs_hash, profile_version,
           notice_fingerprint, state, outcome, settled, method, hold_code, score, reason, primary_scope, citations, escalation,
           reviewers, families, record, provider)
         VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (opportunity_key) DO NOTHING`,
        values,
      );
      counts.inserted += result.rowCount ?? 0;
      continue;
    }
    if (!input.settled && row.settled && row.inputsHash !== input.inputsHash) {
      if (row.stale && row.pendingInputsHash === input.inputsHash) {
        counts.unchanged += 1;
        continue;
      }
      await pool.query(
        `UPDATE opportunity_decisions SET stale = true, stale_reason = 'inputs_changed', stale_at = now(), pending_inputs_hash = $2,
           record = coalesce($3, record), updated_at = now()
         WHERE opportunity_key = $1 AND decision_version = $4`,
        [input.opportunityKey, input.inputsHash, input.record ? JSON.stringify(input.record) : null, row.decisionVersion],
      );
      await audit(input.opportunityKey, "decision_stale", { version: row.decisionVersion, state: row.state, inputsHash: row.inputsHash, newInputsHash: input.inputsHash });
      counts.staled += 1;
      continue;
    }
    if (!input.settled && row.settled && row.inputsHash === input.inputsHash) {
      counts.unchanged += 1; // a settled decision on these inputs stands
      continue;
    }
    const changed = !sameContent(row, input);
    if (!changed && !row.stale) {
      await pool.query(`UPDATE opportunity_decisions SET score = $2, reason = $3, citations = $4, primary_scope = $5, updated_at = now() WHERE opportunity_key = $1`, [
        input.opportunityKey,
        input.score,
        input.reason.slice(0, 1_000),
        JSON.stringify(input.citations ?? null),
        JSON.stringify(input.primaryScope ?? null),
      ]);
      counts.unchanged += 1;
      continue;
    }
    const result = await pool.query(
      `UPDATE opportunity_decisions SET decision_version = decision_version + $20, evaluator_version = $2, inputs_hash = $3,
         profile_version = $4, notice_fingerprint = $5, state = $6, outcome = $7, settled = $8, method = $9, hold_code = $10,
         score = $11, reason = $12, primary_scope = $13, citations = $14, escalation = $15, reviewers = $16, families = $17,
         record = coalesce($18, record), provider = $19, stale = false, stale_reason = NULL, stale_at = NULL,
         pending_inputs_hash = NULL, decided_at = now(), updated_at = now()
       WHERE opportunity_key = $1 AND decision_version = $21`,
      // Versions count settled decisions; refreshing a still-pending outcome keeps its number.
      [...values, changed && (input.settled || row.settled) ? 1 : 0, row.decisionVersion],
    );
    if ((result.rowCount ?? 0) === 0) {
      counts.unchanged += 1;
      continue;
    }
    if (changed) {
      await audit(input.opportunityKey, "decision_superseded", {
        previous: { version: row.decisionVersion, state: row.state, inputsHash: row.inputsHash, method: row.method, holdCode: row.holdCode },
        next: { version: row.decisionVersion + 1, state: input.state, inputsHash: input.inputsHash },
      });
      counts.superseded += 1;
    } else {
      counts.unchanged += 1;
    }
  }
  return counts;
}

async function audit(opportunityKey: string, event: string, details: Record<string, unknown>): Promise<void> {
  await (await rcPool()).query(
    `INSERT INTO opportunity_audit_log (id, opportunity_key, event, details) VALUES (gen_random_uuid()::text, $1, $2, $3)`,
    [opportunityKey, event, JSON.stringify(details)],
  );
}

/**
 * Puts stale decisions back into the review queue from their stored snapshot. An existing queue row is reopened
 * (queued, due now); a missing one (deterministic approvals never had one) is created. Rows being reviewed right
 * now are left alone.
 */
export const REQUEUE_STALE_SQL = `INSERT INTO opportunity_review_queue (id, opportunity_key, provider, record, content_hash, profile_version,
     priority, status, hold_code, reason, response_deadline)
   SELECT gen_random_uuid()::text, d.opportunity_key, coalesce(d.provider, 'reopened'), d.record, d.inputs_hash, d.profile_version,
     50, 'queued', 'structured_review_queued', $2,
     CASE WHEN d.record->>'responseDeadline' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (d.record->>'responseDeadline')::timestamptz ELSE NULL END
   FROM opportunity_decisions d
   WHERE d.opportunity_key = ANY($1::text[]) AND d.record IS NOT NULL
   ON CONFLICT (opportunity_key) DO UPDATE SET status = 'queued', next_attempt_at = now(), reason = EXCLUDED.reason, updated_at = now()
   WHERE opportunity_review_queue.status IN ('held','decided','queued')`;

/** Marks these opportunities' decisions stale and returns them to the review queue. */
export async function reopenDecisions(keys: string[], reason: string): Promise<number> {
  if (keys.length === 0) return 0;
  await ensureReleaseCSchema();
  const pool = await rcPool();
  const staled = await pool.query(
    `UPDATE opportunity_decisions SET stale = true, stale_reason = $2, stale_at = now(), updated_at = now()
     WHERE opportunity_key = ANY($1::text[]) AND state <> 'closed'`,
    [keys, reason.slice(0, 200)],
  );
  await pool.query(REQUEUE_STALE_SQL, [keys, reason.slice(0, 500)]);
  return staled.rowCount ?? 0;
}

/**
 * Profile-version reopen: decisions made under another OCCU_MED_AWARE version are stale and re-enter the queue (in
 * bounded batches; the review-queue drain calls this before claiming work).
 */
export async function reopenDecisionsForProfile(profileVersion: string, limit = 500): Promise<number> {
  if (!profileVersion || profileVersion === "unavailable") return 0;
  await ensureReleaseCSchema();
  const result = await (await rcPool()).query(
    `SELECT opportunity_key FROM opportunity_decisions
     WHERE stale = false AND state <> 'closed' AND profile_version IS DISTINCT FROM $1
     ORDER BY decided_at ASC LIMIT $2`,
    [profileVersion, limit],
  );
  const keys = result.rows.map((row) => String(row.opportunity_key));
  return reopenDecisions(keys, "profile_version_changed");
}

export interface AuthoritativeDecisionView {
  /** stored: an opportunity_decisions row exists; none: only the read-time classification is available. */
  source: "stored" | "none";
  state: DecisionState | null;
  decisionVersion: number | null;
  evaluatorVersion: string | null;
  inputsHash: string | null;
  profileVersion: string | null;
  decidedAt: string | null;
  method: string | null;
  holdCode: string | null;
  score: number | null;
  reason: string | null;
  primaryScope: unknown;
  citations: ValidatedCitation[];
  /** Stored, settled, not stale, made under the current profile and on the notice text this row holds. */
  current: boolean;
  stale: boolean;
  staleReason: string | null;
  /** The read-time view follows this decision (see decisionAuthority). */
  authoritative: boolean;
  /** Set when the read-time classifier disagrees with the stored decision; it is a flag, never an override. */
  readTimeConflict: string | null;
}

const APPROVED_STATES = new Set<DecisionState>(["qualified", "provisional"]);

export function isApprovedState(state: DecisionState | null | undefined): boolean {
  return Boolean(state && APPROVED_STATES.has(state));
}

/**
 * The decision a read-time route must use for a stored opportunity row. A current stored approval is authoritative
 * unless the authority is off; a current stored hold or rejection is authoritative only under "enforce" (otherwise
 * it is surfaced as a conflict flag, so no currently visible record is hidden by default).
 */
export function authoritativeDecisionView(
  stored: StoredDecision | undefined,
  row: { title?: unknown; description?: unknown },
  options: { profileVersion: string; authority: DecisionAuthority; readTimeEligible: boolean },
): AuthoritativeDecisionView {
  if (!stored) {
    return {
      source: "none", state: null, decisionVersion: null, evaluatorVersion: null, inputsHash: null, profileVersion: null,
      decidedAt: null, method: null, holdCode: null, score: null, reason: null, primaryScope: null, citations: [],
      current: false, stale: false, staleReason: null, authoritative: false, readTimeConflict: null,
    };
  }
  const rowChanged = stored.noticeFingerprint != null && stored.noticeFingerprint !== noticeFingerprint(row.title, row.description);
  const profileChanged = stored.profileVersion !== options.profileVersion;
  const stale = stored.stale || rowChanged || profileChanged;
  const staleReason = stored.stale
    ? stored.staleReason
    : profileChanged ? "profile_version_changed" : rowChanged ? "notice_changed" : null;
  const current = stored.settled && !stale;
  const approved = isApprovedState(stored.state);
  const authoritative = current && options.authority !== "off" && (approved || options.authority === "enforce");
  const disagrees = current && stored.state !== "closed" && approved !== options.readTimeEligible;
  return {
    source: "stored",
    state: stored.state,
    decisionVersion: stored.decisionVersion,
    evaluatorVersion: stored.evaluatorVersion,
    inputsHash: stored.inputsHash,
    profileVersion: stored.profileVersion,
    decidedAt: stored.decidedAt,
    method: stored.method,
    holdCode: stored.holdCode,
    score: stored.score,
    reason: stored.reason,
    primaryScope: stored.primaryScope,
    citations: stored.citations?.valid ?? [],
    current,
    stale,
    staleReason,
    authoritative,
    readTimeConflict: disagrees
      ? approved
        ? `The listing-text classifier would hold this record, but stored decision v${stored.decisionVersion} (${stored.state}) is authoritative.`
        : `The listing-text classifier accepts this record, but stored decision v${stored.decisionVersion} is ${stored.state}${authoritative ? "" : " (flagged only)"}.`
      : null,
  };
}
