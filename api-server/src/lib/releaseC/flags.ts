/**
 * Release C staged activation. Every substantial behaviour is behind its own flag so it can be turned on, watched
 * and turned off independently (Render env var change; no code rollback needed).
 *
 *   OPPORTUNITY_REVIEW_QUEUE_ENABLED      persistent adaptive AI review queue instead of the fixed per-run ceiling
 *   OPPORTUNITY_DOCUMENT_PIPELINE_ENABLED discover/fetch/extract notice documents and use their evidence
 *   OPPORTUNITY_REQUIRE_DOCUMENT_EVIDENCE thin records (title/snippet/short prefix) are held until documents are read
 *   OPPORTUNITY_REQUIREMENT_LEDGER_ENABLED per-requirement evidence ledger and multi-axis assessment
 *   OPPORTUNITY_COVERAGE_TRACKING_ENABLED  per-query/page/family coverage events and partition-exclusion audit
 *   DOCUMENT_EXTRACTION_WORKER_MODE       "off" (default) | "child": run the extraction worker as a child process
 *   OPPORTUNITY_SHARED_WORK_DURABLE       share page fetches / AI extractions across workers and deploys (default on
 *                                         in production, off elsewhere so tests never read another run's results)
 *   OPPORTUNITY_FULL_CORPUS_EVIDENCE      rank evidence passages over every document section (default on)
 *   PROVIDER_ACCOUNTING_FAIL_CLOSED       refuse billable-capable account calls while durable accounting is down
 *                                         (default on)
 *
 * Defaults: queue, ledger and coverage tracking default ON (they only add records/telemetry and never drop work);
 * the document pipeline and the stricter evidence requirement default OFF until activated in production.
 */
function flag(name: string, fallback: boolean, env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "off") return false;
  return fallback;
}

export function releaseCFlags(env: Record<string, string | undefined> = process.env) {
  const documentPipeline = flag("OPPORTUNITY_DOCUMENT_PIPELINE_ENABLED", false, env);
  return {
    reviewQueue: flag("OPPORTUNITY_REVIEW_QUEUE_ENABLED", true, env),
    documentPipeline,
    requireDocumentEvidence: documentPipeline && flag("OPPORTUNITY_REQUIRE_DOCUMENT_EVIDENCE", false, env),
    requirementLedger: flag("OPPORTUNITY_REQUIREMENT_LEDGER_ENABLED", true, env),
    coverageTracking: flag("OPPORTUNITY_COVERAGE_TRACKING_ENABLED", true, env),
    workerMode: (env.DOCUMENT_EXTRACTION_WORKER_MODE?.trim().toLowerCase() === "child" ? "child" : "off") as "child" | "off",
  };
}

export type ReleaseCFlags = ReturnType<typeof releaseCFlags>;

export type ReviewMode = "single" | "panel";

/**
 * single (default): one evaluator decides; a second model family is asked only for a genuine conflict between the
 * evaluator and the deterministic or document evidence (see escalationConflict in structuredOpportunityDecision).
 * panel: the Release C two-family consensus. OPPORTUNITY_REVIEW_MODE=panel restores the panel without a deploy.
 */
export function reviewMode(override?: ReviewMode): ReviewMode {
  if (override) return override;
  return process.env.OPPORTUNITY_REVIEW_MODE?.trim().toLowerCase() === "panel" ? "panel" : "single";
}

export function durableSharedWorkEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flag("OPPORTUNITY_SHARED_WORK_DURABLE", env.NODE_ENV === "production", env);
}

/** Billable-capable accounts are not used while reservations cannot be recorded durably. */
export function accountingFailClosed(env: Record<string, string | undefined> = process.env): boolean {
  return flag("PROVIDER_ACCOUNTING_FAIL_CLOSED", true, env);
}

/** Document evidence ranked over every stored section instead of a kind-ordered prefix (default on). */
export function fullCorpusEvidenceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flag("OPPORTUNITY_FULL_CORPUS_EVIDENCE", true, env);
}

/**
 * Read-time authority of the stored decision (decisionRecord.ts), OPPORTUNITY_DECISION_AUTHORITY:
 *   flag (default)  a current stored approval (qualified / provisional) is authoritative: the list and detail routes
 *                   and ingestion's quality gate follow it instead of re-scoring the listing text. A current stored
 *                   hold or rejection of a record that is already visible is only flagged (decision.readTimeConflict),
 *                   so nothing visible today is hidden by this change.
 *   enforce         a current stored needs_review / out_of_scope decision is authoritative too and moves the record
 *                   out of the actionable view.
 *   off             read-time classification only; the decision fields are still exposed.
 */
export type DecisionAuthority = "off" | "flag" | "enforce";

export function decisionAuthority(env: Record<string, string | undefined> = process.env): DecisionAuthority {
  const raw = env.OPPORTUNITY_DECISION_AUTHORITY?.trim().toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "flag";
}

/**
 * OPPORTUNITY_CITATION_CHECK (default on): evaluator citations are always checked against the stored document
 * sections and the notice text, and invalid ones are dropped. On: an approval whose every citation was invalid is
 * downgraded to needs_review (hold structured_evidence_unverified). Off: citations are still checked and recorded,
 * but no approval is downgraded.
 */
export function citationCheckEnforced(env: Record<string, string | undefined> = process.env): boolean {
  return flag("OPPORTUNITY_CITATION_CHECK", true, env);
}
