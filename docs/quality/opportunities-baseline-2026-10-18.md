# Opportunities baseline and production provenance (Task 00)

Recorded 2026-10-18 against `main` @ `47487ba7e0defb9cce894a576c1d2f135186de0e`. Read-only: no production
schema, data, secret or paid-API change was made to collect anything below. Connection strings and credentials
are deliberately not recorded; only hostnames and IDs that the application itself logs at startup.

## 1. Production mapping

| Item | Value | Evidence level |
|---|---|---|
| Production web service | Render `Insight-Hub`, `srv-d9vkimbl550s73aootjg` (workspace "Occu-Med") | **Proved** — Render API |
| Public URL | https://insight-hub-952b.onrender.com | **Proved** — Render API + deploy log |
| Deploy trigger | auto-deploy on commit to `main` | **Proved** — Render service config |
| Live deploy at baseline | `dep-dba0sl0ae00c739amjr0`, commit `47487ba7` | **Proved** — Render deploys API |
| Start command | `pnpm run start:prod` (heap `--max-old-space-size=224`, `STRUCTURED_RFP_REVIEW_CANDIDATE_LIMIT=3`, `WEB_INTELLIGENCE_AI_CANDIDATE_LIMIT=20`, `DATABASE_POOL_MAX=1`) | **Proved** — startup log |
| RFP (Opportunities) database host | `ep-orange-fire-ap4zgc4a-pooler.c-7.us-east-1.aws.neon.tech`, db `neondb`, env `RFP_DATABASE_URL` | **Proved** — startup log "Procurement database verified" |
| Intel database host | `ep-frosty-boat-apvfnwbm-pooler.c-7.us-east-1.aws.neon.tech`, env `INTEL_DATABASE_URL` | **Proved** — startup log |
| OCCU_MED_AWARE profile source | env `OCCU_MED_AWARE_DATABASE_URL`; startup log reports `source: "neon"`, version `feed91d061b87b2fa2b903cdfc9047f43922161acd6478e625c39f266f528322` | Source **proved**; **host unresolved** (not logged) |
| Regression fixture profile version | `604ec101964c22d29fbbd72928ff5af1133bdcc53aaea9eace1bdd613141f3d2` (`docs/neon-profile/regression/rows.json`) | **Differs from live** — fixture results are not live results |
| Second Render service on same repo | `Insight-Hub` `srv-d7ab054hg0os73bf1cvg` (workspace "Alex's workspace"), manual deploys only, last live commit `d906b4bd` (2026-10-16) | **Proved stale / not the auto-deployed production target** |
| Suspended | `Insight-Hub-New` `srv-d8b46mtckfvc73clvne0` | Proved suspended |

The project previously inspected as `RFP_AWARE_DATABASE` (`ep-small-king-*`) does **not** match the RFP host above
and must not be treated as the application's opportunities store (F-19). The Neon MCP connector was not
authorized in this session, so live row counts were not collected.

## 2. Provider lineage and persistence fate

Every record returned by `fetchOneProvider` (`api-server/src/lib/ingestion/providerRunner.ts`) is written by
`processOneRecord` (`manualIngestion.ts`) to `opportunity_raw_records` (immutable) and `opportunity_staging`, then
`decideOpportunityQuality` sets `qualityStatus` = `accepted` | `rejected` | `quarantined` | `duplicate`.
Only `accepted` rows are promoted to `opportunities`. Records dropped **before** `fetchOneProvider` returns never
reach raw/staging and are therefore unauditable.

| Provider path | Pre-return filters | Dropped before staging at baseline |
|---|---|---|
| `samGov`, `tango` (`fetchStructuredFederalProvider` → `applyStructuredFederalDecision`) | query partition, expiry, `decideStructuredOpportunities` | **review-band records beyond the AI budget (3) and AI failures** (F-03); structured rejects |
| SAM zero-result recovery (`samGov.ts` → `webIntelligenceFetch`) | snippet prefilter `isRfpCandidate` (requires *accept*) | review-band snippets (F-08) |
| CanadaBuys (`internationalPublicPortals.ts` → `webIntelligenceFetch`) | same snippet prefilter | review-band snippets (F-08) |
| Web discovery providers (exa, you, langsearch, …) | same snippet prefilter, AI extraction `isOpportunity` | review-band snippets (F-08) |
| Registry providers (public portals, Bonfire, TX ESBD, NY SCR, …) | query partition, expiry | partition mismatches (bounded diagnostic sample retained elsewhere) |
| aiDiscovery, rssAggregator | query partition, expiry | partition mismatches |

## 3. Reproducible fixture baseline (no secrets)

`api-server/src/lib/search/__tests__/support/opportunityAuditCorpus.ts` holds the frozen, issue-tagged corpus
(hard negatives, hard positives, vague-title positive, recompete). The assertion tests that consume it are
`opportunityAuditRegression.test.ts` and siblings added in Release A. Before Release A, against the fixture
profile: construction QA and medical-waste hauling scored **84 / accept / strong_combination** through inside-word
matches (`sts`←costs, `der`←provider); OCONUS clearance had no purchased-scope evidence (dead title fallback);
an RFP mentioning "previously awarded to" was classified `award`.

## 4. Gold set process (not yet executed — needs authorized read access)

1. Sample 300 rows from the RFP database (`ep-orange-fire`) stratified by `qualityStatus` (accepted/quarantined/
   rejected/duplicate from `opportunity_staging`) and provider family, plus 50 named hard negatives.
2. Export only id, title, agency, source URL, provider, dates and a 2,000-character description excerpt; no
   contact data. Store labels outside the repository until approved.
3. Two reviewers label: in-scope purchased service (yes/no/unclear), notice stage, deadline open, with the source
   URL as evidence; adjudicate disagreements.
4. Report separately: raw acquisition recall (reference official notices present in raw/staging at any status),
   review retention (no unaccounted drops), Actionable precision, verification confidence, list latency.

## 5. Stage metrics available today vs. unavailable

Available in logs: `rfp_structured_decision` (candidates/approved/rejected/reviewHeld), `rfp_provider_query_partitioned`,
`rfp_expired_records_skipped`, ingestion-run telemetry (candidates, accepted, enrichment counts per provider).
Unavailable / not measured: live false-positive rate, true positives lost, heap usage during `GET /opportunities`,
attachment/SOW completeness, quota spend per run. These are reported as unknown, not estimated.
