# Insight Hub Release and Rollback Contract

This runbook separates application deployment from database/data operations. A release is not accepted merely because a deploy reports `live`; the deployed revision must pass the read-only production acceptance gate.

## Release order

1. Merge only after required repository CI is green on the PR head.
2. Record the merge/deploy commit SHA before deployment.
3. Deploy that revision through the normal Render deployment path.
4. Confirm `GET /api/healthz` returns the expected deployment revision.
5. **Product build** runs again on every relevant push to `main`. After it succeeds, **Production acceptance** automatically checks that exact commit against the deployed Render service and retries boundedly while the deployment converges.
6. The automatic gate uses `https://insight-hub-eyza.onrender.com` as the known Hub 1 production endpoint. A non-secret GitHub repository variable named `INSIGHT_PRODUCTION_URL` may override that hostname if production moves later.
7. The same Production acceptance workflow remains manually runnable with optional `base_url` and `expected_commit` inputs for explicit release or rollback verification.
8. Treat the release as accepted only when the workflow passes health, readiness, database status, opportunity read, frontend-shell checks, and—when an expected SHA is supplied—deployed revision identity.

The production acceptance workflow is intentionally read-only. It does not fetch new intelligence, grade opportunities, refresh Forecasts/Recompetes/News, mutate settings, run migrations, or write to production data.

## Rollback triggers

Rollback the application when any of the following is true after deployment:

- `/api/healthz` is unavailable or reports the wrong revision.
- `/api/readyz?force=true` remains non-ready.
- `/api/database-status` reports the procurement database unhealthy.
- the normal opportunity read endpoint cannot return a valid response.
- a core procurement frontend route no longer returns the application shell.
- error rate, resource usage, or operator-observed behavior indicates a material regression.

## Application rollback procedure

1. Identify the last known-good deployed commit from release records / Render deploy history.
2. Roll back the **application revision only** using the deployment platform's normal rollback/redeploy mechanism.
3. Do not automatically reverse database changes or delete records as part of application rollback.
4. Wait for the rollback revision's `/api/healthz` to report the expected commit.
5. Run the Production acceptance workflow again using the rollback commit as `expected_commit`.
6. Keep the failed release unaccepted until its root cause is fixed in a new PR.

## Database migration rule

Database changes must be additive-first whenever practical:

- add columns/tables/indexes before code relies on them;
- keep old readers/writers compatible through the deployment window;
- backfill separately from destructive cleanup;
- validate constraints before removing compatibility paths;
- do not couple destructive data cleanup to application startup.

A failed application release must **not** automatically run a reverse data migration. Data rollback is a separate, explicit recovery decision after confirming backup/restore state and the impact on records written after deployment.

## Disaster recovery proof

The repository's Database Resilience workflow uses disposable PostgreSQL databases to prove:

1. the declared RFP schema can be created;
2. startup migrations complete;
3. the critical schema contract is present;
4. deterministic recovery fixtures can be backed up with `pg_dump`;
5. the dump can be restored into a fresh database;
6. critical schema checks still pass after restore;
7. opportunity, feedback, and settings fingerprints match source vs restored data.

That CI drill is a recovery **procedure test**, not a production backup. Production backup retention and point-in-time recovery remain the responsibility of the database platform and operational account configuration.

## Secrets and release artifacts

- Never place API keys, database credentials, passwords, or tokens directly in `render.yaml` or tracked `.env` files.
- Keep secret-like Render variables as `sync: false` / dashboard-managed values.
- `INSIGHT_PRODUCTION_URL` is optional and non-secret; it contains only a public deployment base URL and overrides the repository's known Hub 1 production endpoint when set.
- Do not attach production database dumps to GitHub Actions artifacts.
- The Database Resilience workflow may upload only its disposable CI fixture dump, with short retention.

## Release evidence to retain

For each accepted production release, retain:

- PR number;
- deployed commit SHA;
- repository CI status;
- Production acceptance workflow run;
- deployment timestamp;
- rollback commit if rollback occurred;
- any migration/backup notes relevant to that release.

## Release C (Opportunities document evidence and adaptive review)

Release C is staged behind flags; each can be turned off in the Render dashboard without a code rollback.

| Flag | Default in `render.yaml` | Off means |
| --- | --- | --- |
| `OPPORTUNITY_REVIEW_QUEUE_ENABLED` | `true` | No persistent review queue; held records stay held. |
| `OPPORTUNITY_REQUIREMENT_LEDGER_ENABLED` | `true` | No requirement-level evidence ledger is written. |
| `OPPORTUNITY_COVERAGE_TRACKING_ENABLED` | `true` | No coverage or partition-exclusion events are written. |
| `OPPORTUNITY_DOCUMENT_PIPELINE_ENABLED` | `false` | Attachments are not fetched or extracted. |
| `OPPORTUNITY_REQUIRE_DOCUMENT_EVIDENCE` | `false` | Records are not held when documents are incomplete. |
| `DOCUMENT_EXTRACTION_WORKER_MODE` | `off` | No child extraction worker (`child` spawns `dist/workers/documentExtractionWorker.mjs`). |
| `STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT` | unset | Unset means adaptive (no fixed cap). A positive number restores a hard ceiling. |

Release C tables are additive (`lib/db/migrations/rfp/release-c/up.sql`, created idempotently at startup). They do not alter existing tables or opportunity rows. `lib/db/migrations/rfp/release-c/down.sql` drops only the Release C tables; run it only after the flags are off and only if the data in those tables is no longer needed.

The benchmark gate (`pnpm --filter @workspace/api-server run test:release-c`) compares against `api-server/src/lib/releaseC/benchmark/baseline.json`. Rebuild the dataset with `node --import tsx src/lib/releaseC/benchmark/build.ts <label-dir>`; see `docs/quality/release-c-benchmark.md`.
