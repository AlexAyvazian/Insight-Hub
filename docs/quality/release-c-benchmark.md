# Release C Opportunities benchmark

Dataset `api-server/src/lib/releaseC/benchmark/dataset.json`, version `f6a35f22cec67f5a`, built 2026-10-18. Gate test: `api-server/src/lib/releaseC/__tests__/releaseCBenchmark.test.ts`. Baseline: `api-server/src/lib/releaseC/benchmark/baseline.json`.

## Label provenance

No label in this dataset is human-validated. AI reference labels are model output and are reported separately from fixtures.

| Provenance | Cases | Source |
| --- | --- | --- |
| `synthetic_fixture` | 158 | Repository regression corpus, golden set and Release A audit corpus (exact expected verdicts). |
| `synthetic_adversarial` | 20 | Release C adversarial cases: injection text, workers' comp, staffing, supplies, award notices, thin and vague records. |
| `ai_reference_agreed` | 175 | Production records (public `/api/opportunities` and rejection diagnostics) where two blind AI reviewers gave the same label. |
| `ai_reference_adjudicated` | 5 | Reviewers disagreed or were unclear; a third AI pass settled the label. |
| Unresolved | 22 | Still unclear after adjudication (closed or under-evaluation bids, title-only records, mismatched records). Not scored; listed as a coverage gap. |

All three AI passes used the same model family, so agreement measures self-consistency, not independent consensus. The rubric the reviewers received was built from the canonical `OCCU_MED_AWARE` policies and rules; one reviewer reported that the service-category section of it was empty and one rule text was cut short.

A production case is gate-eligible only when both reviewers agreed at high confidence and an independent non-AI signal supports the label: an `OCCU_MED_AWARE` discovery code for relevant records, or, for not-relevant records, an agreed non-procurement stage or official codes outside the discovery codes. 218 cases are gate-eligible (178 synthetic, 40 production).

## Results (deterministic pipeline, no AI judge)

| Group | Kept precision | Kept recall | Auto-accept precision | Auto-accept recall | Ranking AUC | Expectation pass |
| --- | --- | --- | --- | --- | --- | --- |
| Fixtures (158) | 0.872 | 1.000 | 1.000 | 0.987 | 0.999 | 100% |
| Adversarial (20) | 0.900 | 1.000 | 1.000 | 1.000 | 1.000 | 100% |
| AI agreed (175) | 0.686 | 0.988 | 1.000 | 0.929 | 0.970 | 99.4% |
| AI adjudicated (5) | 0 | n/a | 0 | n/a | n/a | 60% |
| **Gate (218)** | 0.729 | 1.000 | 1.000 | 0.988 | 0.997 | 100% |

"Kept" means accepted or held for review. Missed opportunities in the gate set: none. In the AI-agreed set, one (`rej-008`, Arlington "Annual firefighter health and fitness assessments", rejected because the record has no description).

Wrong high-confidence matches in the gate set: none (3 before the procurement-authenticity check: an employer RFP checklist article, a Florida transplant-centre regulation and a website's terms of service, all web-discovery pages that are not procurements). In the wider AI-agreed set: none (15 before the authenticity check, 5 after it, 0 after the primary-purchased-scope check). The authenticity check (`api-server/src/lib/search/procurementAuthenticity.ts`, applied in `classifyProviderRecordRelevance` and in web-discovery triage) classifies web-discovery pages from their URL host and path, title patterns and procurement metadata. It rejects guidance articles, regulations, terms of service and commentary (5 cases, one of them because only an aggregator's "similar RFPs" section carried the medical wording). It holds listing and search-results pages, addenda and post-award notice types for review (5 cases). No relevant case changed verdict and no new opportunity was missed. The other 5 were not web-page authenticity problems: a medications, vaccines and medical-supplies contract (two records), two clinical laboratory testing BPAs and a disease-surveillance research study. The primary-purchased-scope check (`api-server/src/lib/search/primaryPurchasedScope.ts`, applied after the authenticity check in `classifyProviderRecordRelevance`) holds all 5 for review, without changing the `OCCU_MED_AWARE` profile: a result whose only Occu-Med evidence is the laboratory / diagnostic component category (optionally with program management) and that has no workforce, employer or regulatory signal (the 3 laboratory / study records), and a result with no explicit service phrase whose notice procures medications or vaccines as goods, whose title names no service and which never says the contractor administers them (the 2 MVMS records). Both only downgrade accept to review; nothing is rejected. No other case changed verdict or score, so the gate metrics are unchanged and `baseline.json` was not re-recorded. Regression tests: `api-server/src/lib/search/__tests__/primaryPurchasedScope.test.ts`. The gate fails on any new wrong match.

Source verification: 36.6% of AI-agreed production cases come from an official government host; 50.3% carry a known deadline. Document completeness is not measured here because the document pipeline is staged off in production.

## How to rebuild

1. Export production records and rejection samples, write `production_sample.json` and the blind `label_input.json`.
2. Have two blind reviewers write `labels_a.json` and `labels_b.json`, and an adjudicator write `adjudication.json` for disagreements.
3. Run `node --import tsx src/lib/releaseC/benchmark/build.ts <dir>` from `api-server`, then re-record `baseline.json` only when the change is an intended improvement.
