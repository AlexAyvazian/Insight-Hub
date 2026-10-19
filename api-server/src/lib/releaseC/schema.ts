/**
 * Release C additive schema (RFP database only).
 *
 * Every statement is CREATE ... IF NOT EXISTS: no existing table, column, row or the canonical Neon profile is
 * touched. The exact inverse lives in lib/db/migrations/rfp/release-c/down.sql and drops only these tables.
 * Nothing here is coupled to destructive cleanup; rolling back the application never runs the down migration.
 */
import { rcPool } from "./db";

export const RELEASE_C_SCHEMA_VERSION = "release-c-2026-10-18";

export const RELEASE_C_TABLES = [
  "opportunity_documents",
  "opportunity_document_sections",
  "opportunity_requirements",
  "opportunity_requirement_matches",
  "opportunity_assessments",
  "opportunity_review_queue",
  "document_extraction_jobs",
  "provider_account_usage",
  "opportunity_coverage_events",
  "opportunity_benchmark_runs",
  "opportunity_benchmark_results",
  "opportunity_audit_log",
  "remote_extraction_jobs",
  "source_query_checkpoints",
  "shared_work_results",
  "provider_account_reservations",
  "provider_purpose_usage",
  "provider_pool_cooldowns",
  "opportunity_versions",
] as const;

export const RELEASE_C_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS opportunity_documents (
    id text PRIMARY KEY,
    opportunity_key text NOT NULL,
    opportunity_id text,
    source_url text NOT NULL,
    final_url text,
    document_role text NOT NULL DEFAULT 'attachment',
    title text,
    content_type text,
    byte_size integer,
    sha256 text,
    source_version text,
    amended_at timestamptz,
    retrieval_status text NOT NULL DEFAULT 'pending',
    retrieval_error text,
    page_count integer,
    extracted_page_count integer,
    extraction_status text NOT NULL DEFAULT 'pending',
    extraction_method text,
    extraction_provider text,
    extraction_account text,
    extraction_quality text,
    storage_ref text,
    superseded_by text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_checked_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_opportunity_documents_version
     ON opportunity_documents (opportunity_key, source_url, coalesce(sha256, ''))`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_documents_key ON opportunity_documents (opportunity_key)`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_documents_sha ON opportunity_documents (sha256)`,

  `CREATE TABLE IF NOT EXISTS opportunity_document_sections (
    id text PRIMARY KEY,
    document_id text NOT NULL,
    opportunity_key text NOT NULL,
    ordinal integer NOT NULL,
    page_start integer,
    page_end integer,
    heading text,
    section_kind text NOT NULL DEFAULT 'general',
    text text NOT NULL,
    char_count integer NOT NULL,
    sha256 text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_document_sections_doc ON opportunity_document_sections (document_id, ordinal)`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_document_sections_key ON opportunity_document_sections (opportunity_key)`,

  `CREATE TABLE IF NOT EXISTS opportunity_requirements (
    id text PRIMARY KEY,
    opportunity_key text NOT NULL,
    requirement_id text NOT NULL,
    document_id text,
    section_id text,
    page integer,
    locator text,
    requirement_text text NOT NULL,
    mandatory boolean NOT NULL DEFAULT true,
    category text NOT NULL,
    worksite text,
    delivery_model text,
    credentials text,
    quantity text,
    source_hash text NOT NULL,
    notice_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    superseded_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_requirements_key ON opportunity_requirements (opportunity_key) WHERE superseded_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS opportunity_requirement_matches (
    id text PRIMARY KEY,
    requirement_row_id text NOT NULL,
    opportunity_key text NOT NULL,
    profile_version text NOT NULL,
    capability_id text,
    status text NOT NULL,
    rationale text NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    decided_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    invalidated_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_requirement_matches_key ON opportunity_requirement_matches (opportunity_key) WHERE invalidated_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS opportunity_assessments (
    id text PRIMARY KEY,
    opportunity_key text NOT NULL,
    content_hash text NOT NULL,
    profile_version text NOT NULL,
    axes jsonb NOT NULL,
    summary text,
    created_at timestamptz NOT NULL DEFAULT now(),
    superseded_at timestamptz,
    superseded_reason text
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_assessments_current ON opportunity_assessments (opportunity_key) WHERE superseded_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS opportunity_review_queue (
    id text PRIMARY KEY,
    opportunity_key text NOT NULL,
    provider text NOT NULL,
    record jsonb NOT NULL,
    content_hash text NOT NULL,
    profile_version text,
    priority double precision NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'queued',
    hold_code text,
    reason text,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    response_deadline timestamptz,
    last_error text,
    decision jsonb,
    decided_at timestamptz,
    enqueued_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_opportunity_review_queue_key ON opportunity_review_queue (opportunity_key)`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_review_queue_due ON opportunity_review_queue (status, next_attempt_at, priority DESC)`,

  `CREATE TABLE IF NOT EXISTS document_extraction_jobs (
    id text PRIMARY KEY,
    document_id text NOT NULL,
    opportunity_key text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    priority double precision NOT NULL DEFAULT 0,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    locked_by text,
    locked_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_document_extraction_jobs_doc ON document_extraction_jobs (document_id)`,
  `CREATE INDEX IF NOT EXISTS idx_document_extraction_jobs_due ON document_extraction_jobs (status, next_attempt_at, priority DESC)`,

  `CREATE TABLE IF NOT EXISTS provider_account_usage (
    id text PRIMARY KEY,
    pool text NOT NULL,
    slot text NOT NULL,
    provider text NOT NULL,
    model_family text,
    allowance_kind text NOT NULL DEFAULT 'unknown',
    unit text NOT NULL DEFAULT 'requests',
    quota_limit double precision,
    quota_remaining double precision,
    used_today double precision NOT NULL DEFAULT 0,
    used_month double precision NOT NULL DEFAULT 0,
    used_total double precision NOT NULL DEFAULT 0,
    requests_total integer NOT NULL DEFAULT 0,
    day_key text,
    month_key text,
    reset_at timestamptz,
    reset_source text,
    exhausted boolean NOT NULL DEFAULT false,
    exhausted_reason text,
    needs_confirmation boolean NOT NULL DEFAULT false,
    cooldown_until timestamptz,
    last_outcome text,
    successes integer NOT NULL DEFAULT 0,
    failures integer NOT NULL DEFAULT 0,
    quality_good integer NOT NULL DEFAULT 0,
    quality_poor integer NOT NULL DEFAULT 0,
    last_confirmed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS opportunity_coverage_events (
    id text PRIMARY KEY,
    run_id text,
    provider text NOT NULL,
    service_family text,
    query text,
    page integer,
    returned integer NOT NULL DEFAULT 0,
    matched integer NOT NULL DEFAULT 0,
    excluded integer NOT NULL DEFAULT 0,
    staged integer NOT NULL DEFAULT 0,
    error text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_coverage_events_created ON opportunity_coverage_events (created_at)`,

  `CREATE TABLE IF NOT EXISTS opportunity_benchmark_runs (
    id text PRIMARY KEY,
    dataset_version text NOT NULL,
    commit_sha text,
    pipeline text NOT NULL,
    metrics jsonb NOT NULL,
    gate_passed boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS opportunity_benchmark_results (
    id text PRIMARY KEY,
    run_id text NOT NULL,
    case_id text NOT NULL,
    label text NOT NULL,
    label_provenance text NOT NULL,
    label_confidence text NOT NULL,
    predicted text NOT NULL,
    correct boolean NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_benchmark_results_run ON opportunity_benchmark_results (run_id)`,

  `CREATE TABLE IF NOT EXISTS opportunity_audit_log (
    id text PRIMARY KEY,
    opportunity_key text,
    event text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_audit_log_key ON opportunity_audit_log (opportunity_key, created_at)`,

  // Remote extraction jobs accepted (and charged) by a provider, so a restarted worker resumes them instead of
  // resubmitting the document.
  `CREATE TABLE IF NOT EXISTS remote_extraction_jobs (
    job_key text PRIMARY KEY,
    provider text NOT NULL,
    account_slot text NOT NULL,
    remote_id text NOT NULL,
    planned_units numeric NOT NULL DEFAULT 0,
    submitted_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Where a source query that did not fit in one run stopped, so the next run resumes it (Opportunities wave 1).
  `CREATE TABLE IF NOT EXISTS source_query_checkpoints (
    source text NOT NULL,
    query_key text NOT NULL,
    next_offset integer NOT NULL DEFAULT 0,
    total_records integer,
    window_from text,
    window_to text,
    complete boolean NOT NULL DEFAULT false,
    last_error text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, query_key)
  )`,
  // Page fetches and AI extractions shared across workers and deploys (Opportunities wave 1).
  `CREATE TABLE IF NOT EXISTS shared_work_results (
    kind text NOT NULL,
    work_key text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    value jsonb,
    owner text,
    lease_until timestamptz,
    expires_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, work_key)
  )`,
  `CREATE INDEX IF NOT EXISTS shared_work_results_expires_idx ON shared_work_results (expires_at)`,
  // Units planned by in-flight provider calls, held atomically across workers until usage is recorded.
  `CREATE TABLE IF NOT EXISTS provider_account_reservations (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    units numeric NOT NULL,
    purpose text,
    owner text,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS provider_account_reservations_account_idx ON provider_account_reservations (account_id, expires_at)`,
  // Daily provider calls per purpose (search, page extraction, OCR, AI evaluation), budgeted separately.
  `CREATE TABLE IF NOT EXISTS provider_purpose_usage (
    purpose text NOT NULL,
    day_key text NOT NULL,
    calls integer NOT NULL DEFAULT 0,
    failures integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (purpose, day_key)
  )`,
  // Provider cooldowns (quota, rate limit, auth) that must survive a restart or redeploy.
  `CREATE TABLE IF NOT EXISTS provider_pool_cooldowns (
    pool_provider text PRIMARY KEY,
    cooldown_until timestamptz NOT NULL,
    reason text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // OCDS-style release history per procurement: tender, amendment, cancellation, update (Opportunities wave 2).
  `CREATE TABLE IF NOT EXISTS opportunity_versions (
    id text PRIMARY KEY,
    opportunity_id text NOT NULL,
    opportunity_key text,
    provider text NOT NULL,
    provider_native_id text,
    raw_record_id text,
    release_tag text NOT NULL,
    content_hash text NOT NULL,
    snapshot jsonb NOT NULL,
    changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
    solicitation_number text,
    source_url text,
    source_modified text,
    observed_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opportunity_versions_opportunity ON opportunity_versions (opportunity_id, observed_at DESC)`,
];

type Runner = (statement: string) => Promise<unknown>;

let ensured: Promise<void> | null = null;

/** Applies the additive Release C schema once per process. Safe to call from any feature entry point. */
export function ensureReleaseCSchema(run?: Runner): Promise<void> {
  if (run) return applyReleaseCSchema(run);
  if (!ensured) {
    ensured = (async () => {
      // One client for the whole sequence: the transaction and its advisory lock must stay on one connection.
      const client = await (await rcPool()).connect();
      try {
        await applyReleaseCSchema((statement) => client.query(statement));
      } finally {
        client.release();
      }
    })().catch((error) => {
      ensured = null;
      throw error;
    });
  }
  return ensured;
}

// One transaction with a transaction-scoped lock: the production RFP endpoint is a transaction-mode pooler, where a
// session lock and its unlock could land on different backends and leave the lock held.
async function applyReleaseCSchema(run: Runner): Promise<void> {
  await run("BEGIN");
  try {
    await run(`SELECT pg_advisory_xact_lock(hashtextextended('insight-hub-release-c-schema', 0))`);
    for (const statement of RELEASE_C_DDL) await run(statement);
    await run("COMMIT");
  } catch (error) {
    await Promise.resolve(run("ROLLBACK")).catch(() => undefined);
    throw error;
  }
}

export function resetReleaseCSchemaStateForTests(): void {
  ensured = null;
}
