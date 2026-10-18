# PROPOSAL (not applied): search bundles for unbundled service families

Status: **proposal only, dry run**. Nothing here was written to Neon. Applying it to `OCCU_MED_AWARE`
(`facts` rows with `category = 'rfp_search_bundle'`) needs a separate, explicit decision.

## Why
Against the regression fixture profile, 6 non-adjacent relevance categories have **no** `rfp_search_bundle` whose
service terms mention any of their phrases (audit F-11). Release B (Task 07) already searches these families
through `coverageGapCategories()` in `api-server/src/lib/search/profileWebQueries.ts`, which rotates through each
category's own explicit phrases. That covers them now; dedicated bundles would also let curators set
per-family procurement terms and exclusions.

| Category (fixture) | Leading explicit phrases already in the profile |
|---|---|
| `fitness_return_work` | fit for duty; fitness for duty; functional capacity evaluation; job demands analysis |
| `respiratory_fit_testing` | qualitative/quantitative fit testing; respirator clearance examination; respiratory fit testing |
| `hearing_audiometry` | annual/baseline audiogram; audiometric examination; hearing conservation program |
| `lab_diagnostic_components` | clinical laboratory services; laboratory testing; infectious-disease testing |
| `immunizations_travel` | deployment immunizations; employee vaccination; immunization services; onsite vaccination clinic |
| `post_deployment_support` | behavioral health screening; deployment-related health; post-deployment diagnostic |

**Dental** has no category of its own in the fixture. Dental readiness phrases sit inside other categories, so a
dental family is not detected as a gap. Whether to add a dental category or bundle is a profile decision.

The live profile (version `feed91d0…`) differs from the fixture (`604ec101…`). Re-run `coverageGapCategories()`
against a read-only live load before applying anything.

## Proposed rows (shape only)
One `facts` row per family: `category = 'rfp_search_bundle'`, `predicate = 'bundle_<family>'`, and `value_json` with
`service_terms` (4–7 of the phrases above, quoted), `procurement_terms` (same as existing bundles: RFP, solicitation,
request for proposal), `workforce_terms` and `exclusions` (none beyond the global post-award / job-ad exclusions).
