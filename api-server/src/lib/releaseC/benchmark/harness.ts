/**
 * Release C Opportunities benchmark harness.
 *
 * Label provenance is kept explicit and separate; nothing here is a human-validated gold label:
 *   synthetic_fixture         hand-written repository fixtures (regression corpus, golden set, audit corpus)
 *   synthetic_adversarial     Release C adversarial cases (injection, exclusions, long-description changes)
 *   ai_reference_agreed       production records labelled independently by two AI reviewers (same model family,
 *                             so agreement is self-consistency, NOT independent model consensus)
 *   ai_reference_adjudicated  production records where the two AI reviewers disagreed or were unsure; a third AI
 *                             pass adjudicated; never used to gate a release
 *
 * Gate: only synthetic cases (exact expectations) and ai_reference_agreed cases that are high-confidence for both
 * reviewers AND carry independent non-AI support (official NAICS/PSC code evidence from OCCU_MED_AWARE, or an
 * agreed non-procurement notice stage) gate a release. Everything else is measured and reported only.
 */
import type { NormalizedOpportunity } from "../../providers/types";
import { classifyProviderRecordRelevance } from "../../providers/providerQueryMatch";
import { decideRelevance, matchDiscoveryCode, type RelevanceVerdict } from "../../search/relevanceDecision";
import { buildLedger } from "../requirements";

export type LabelProvenance = "synthetic_fixture" | "synthetic_adversarial" | "ai_reference_agreed" | "ai_reference_adjudicated";
export type Expectation = "accept" | "reject" | "not_accept" | "not_reject";

export interface BenchmarkCase {
  caseId: string;
  source: string;
  stratum: string;
  label: "relevant" | "not_relevant";
  /** Exact pipeline expectation (synthetic cases); AI cases derive it from the label. */
  expectation: Expectation;
  provenance: LabelProvenance;
  confidence: "high" | "medium" | "low";
  explanation: string;
  independentSupport: string[];
  gateEligible: boolean;
  disagreement: string | null;
  record: {
    title: string;
    agency?: string | null;
    type?: string | null;
    description?: string | null;
    naicsCode?: string | null;
    pscCode?: string | null;
    sourceUrl?: string | null;
    responseDeadline?: string | null;
    postedDate?: string | null;
    setAside?: string | null;
  };
}

export interface CaseResult {
  caseId: string;
  provenance: LabelProvenance;
  label: BenchmarkCase["label"];
  expectation: Expectation;
  gateEligible: boolean;
  verdict: RelevanceVerdict;
  score: number;
  confidence: string;
  meetsExpectation: boolean;
  officialSource: boolean;
  deadlineKnown: boolean;
}

export function toRecord(c: BenchmarkCase): NormalizedOpportunity {
  return {
    externalId: c.caseId,
    title: c.record.title,
    agency: c.record.agency ?? "",
    type: c.record.type ?? "Solicitation",
    status: "active",
    description: c.record.description ?? "",
    naicsCode: c.record.naicsCode ?? undefined,
    sourceUrl: c.record.sourceUrl ?? undefined,
    responseDeadline: c.record.responseDeadline ? new Date(c.record.responseDeadline) : undefined,
    postedDate: c.record.postedDate ? new Date(c.record.postedDate) : undefined,
    setAside: c.record.setAside ?? undefined,
    source: c.source,
    rawData: c.record.pscCode ? { classificationCode: c.record.pscCode } : {},
  } as NormalizedOpportunity;
}

export function meets(expectation: Expectation, verdict: RelevanceVerdict): boolean {
  if (expectation === "accept") return verdict === "accept";
  if (expectation === "reject") return verdict === "reject";
  if (expectation === "not_accept") return verdict !== "accept";
  return verdict !== "reject";
}

export function evaluateCase(c: BenchmarkCase): CaseResult {
  const record = toRecord(c);
  const relevance = classifyProviderRecordRelevance(record);
  const verdict = decideRelevance(relevance).verdict;
  const ledger = buildLedger(record, [], { documents: [], documentPipelineEnabled: false });
  return {
    caseId: c.caseId,
    provenance: c.provenance,
    label: c.label,
    expectation: c.expectation,
    gateEligible: c.gateEligible,
    verdict,
    score: relevance.score,
    confidence: relevance.confidence,
    meetsExpectation: meets(c.expectation, verdict),
    officialSource: ledger.assessment.sourceVerification.status === "pass",
    deadlineKnown: Boolean(c.record.responseDeadline),
  };
}

/** Official classification-code evidence from OCCU_MED_AWARE discovery codes (non-AI support signal). */
export function codeSupport(c: Pick<BenchmarkCase, "record">): string | null {
  const naics = matchDiscoveryCode("NAICS 2022", c.record.naicsCode);
  const psc = matchDiscoveryCode("PSC", c.record.pscCode);
  const hit = naics ?? psc;
  return hit ? `${hit.system} ${hit.code} (${hit.tier}, ${hit.effect})` : null;
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : Math.round((n / d) * 1000) / 1000;
}

/** Mann-Whitney AUC of the classifier score for relevant vs not relevant. */
function auc(results: CaseResult[]): number | null {
  const pos = results.filter((r) => r.label === "relevant").map((r) => r.score);
  const neg = results.filter((r) => r.label === "not_relevant").map((r) => r.score);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return Math.round((wins / (pos.length * neg.length)) * 1000) / 1000;
}

export interface GroupMetrics {
  cases: number;
  relevant: number;
  notRelevant: number;
  /** Kept = accept or review (retained, not discarded). */
  keptPrecision: number | null;
  keptRecall: number | null;
  autoAcceptPrecision: number | null;
  autoAcceptRecall: number | null;
  missedOpportunities: string[];
  wrongHighConfidenceMatches: string[];
  expectationPassRate: number | null;
  expectationFailures: string[];
  rankingAuc: number | null;
  precisionAtTopDecile: number | null;
  officialSourceRate: number | null;
  deadlineKnownRate: number | null;
}

export function metrics(results: CaseResult[]): GroupMetrics {
  const relevant = results.filter((r) => r.label === "relevant");
  const notRelevant = results.filter((r) => r.label === "not_relevant");
  const kept = results.filter((r) => r.verdict !== "reject");
  const accepted = results.filter((r) => r.verdict === "accept");
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, Math.max(1, Math.ceil(results.length / 10)));
  return {
    cases: results.length,
    relevant: relevant.length,
    notRelevant: notRelevant.length,
    keptPrecision: ratio(kept.filter((r) => r.label === "relevant").length, kept.length),
    keptRecall: ratio(relevant.filter((r) => r.verdict !== "reject").length, relevant.length),
    autoAcceptPrecision: ratio(accepted.filter((r) => r.label === "relevant").length, accepted.length),
    autoAcceptRecall: ratio(relevant.filter((r) => r.verdict === "accept").length, relevant.length),
    missedOpportunities: relevant.filter((r) => r.verdict === "reject").map((r) => r.caseId),
    wrongHighConfidenceMatches: notRelevant
      .filter((r) => r.verdict === "accept" && (r.confidence === "verified_explicit" || r.confidence === "strong_combination"))
      .map((r) => r.caseId),
    expectationPassRate: ratio(results.filter((r) => r.meetsExpectation).length, results.length),
    expectationFailures: results.filter((r) => !r.meetsExpectation).map((r) => r.caseId),
    rankingAuc: auc(results),
    precisionAtTopDecile: ratio(top.filter((r) => r.label === "relevant").length, top.length),
    officialSourceRate: ratio(results.filter((r) => r.officialSource).length, results.length),
    deadlineKnownRate: ratio(results.filter((r) => r.deadlineKnown).length, results.length),
  };
}

export interface BenchmarkReport {
  datasetVersion: string;
  profileVersion: string;
  total: number;
  byProvenance: Record<string, GroupMetrics>;
  gate: GroupMetrics;
  disputed: number;
}

export function runBenchmark(cases: BenchmarkCase[], datasetVersion: string, profileVersion: string): { report: BenchmarkReport; results: CaseResult[] } {
  const results = cases.map(evaluateCase);
  const byProvenance: Record<string, GroupMetrics> = {};
  for (const provenance of ["synthetic_fixture", "synthetic_adversarial", "ai_reference_agreed", "ai_reference_adjudicated"] as const) {
    const group = results.filter((r) => r.provenance === provenance);
    if (group.length) byProvenance[provenance] = metrics(group);
  }
  return {
    report: {
      datasetVersion,
      profileVersion,
      total: results.length,
      byProvenance,
      gate: metrics(results.filter((r) => r.gateEligible)),
      disputed: cases.filter((c) => c.disagreement).length,
    },
    results,
  };
}
