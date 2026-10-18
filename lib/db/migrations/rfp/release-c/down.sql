-- Release C rollback: drops ONLY the additive Release C tables (indexes go with them).
-- No pre-existing table, column or row is touched; opportunities, staging, settings and the Neon profile are untouched.
-- Run manually, only as an explicit recovery decision (see docs/RELEASE_ROLLBACK.md). The application never runs it.
BEGIN;
DROP TABLE IF EXISTS source_query_checkpoints;
DROP TABLE IF EXISTS remote_extraction_jobs;
DROP TABLE IF EXISTS opportunity_audit_log;
DROP TABLE IF EXISTS opportunity_benchmark_results;
DROP TABLE IF EXISTS opportunity_benchmark_runs;
DROP TABLE IF EXISTS opportunity_coverage_events;
DROP TABLE IF EXISTS provider_account_usage;
DROP TABLE IF EXISTS document_extraction_jobs;
DROP TABLE IF EXISTS opportunity_review_queue;
DROP TABLE IF EXISTS opportunity_assessments;
DROP TABLE IF EXISTS opportunity_requirement_matches;
DROP TABLE IF EXISTS opportunity_requirements;
DROP TABLE IF EXISTS opportunity_document_sections;
DROP TABLE IF EXISTS opportunity_documents;
COMMIT;
