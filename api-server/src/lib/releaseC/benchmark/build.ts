/**
 * Builds dataset.json for the Release C benchmark (run: node --import tsx src/lib/releaseC/benchmark/build.ts <dir>).
 * <dir> holds production_sample.json (public production records), labels_a.json / labels_b.json (two blind AI
 * reviewers) and adjudication.json (third AI pass over disagreements). Repository fixtures are read from source.
 */
import "../../search/__tests__/support/useFixtureProfile";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GOLDEN_CASES } from "../../search/__tests__/goldenSet";
import { HARD_NEGATIVES, HARD_POSITIVES, RECOMPETE_SOLICITATION, VAGUE_TITLE_POSITIVE } from "../../search/__tests__/support/opportunityAuditCorpus";
import { codeSupport, type BenchmarkCase, type Expectation } from "./harness";
import { ADVERSARIAL_CASES } from "./adversarial";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
if (!dir) throw new Error("usage: build.ts <label-dir>");
const repoRoot = path.resolve(here, "../../../../..");

type Label = { caseId: string; label: "relevant" | "not_relevant" | "unclear"; confidence: "high" | "medium" | "low"; noticeStage: string; explanation: string };
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T;

const cases: BenchmarkCase[] = [];
const seen = new Set<string>();
function add(c: BenchmarkCase) {
  const key = `${c.record.title}`.toLowerCase().trim();
  if (seen.has(key)) return;
  seen.add(key);
  cases.push(c);
}

function synthetic(caseId: string, source: string, stratum: string, expectation: Expectation, title: string, description: string, explanation: string, extra: Partial<BenchmarkCase["record"]> = {}) {
  add({
    caseId,
    source,
    stratum,
    label: expectation === "accept" || expectation === "not_reject" ? "relevant" : "not_relevant",
    expectation,
    provenance: "synthetic_fixture",
    confidence: "high",
    explanation,
    independentSupport: ["repository fixture expectation"],
    gateEligible: true,
    disagreement: null,
    record: { title, description, ...extra },
  });
}

// 1. Neon-profile regression corpus (calibration cases).
for (const c of JSON.parse(readFileSync(path.join(repoRoot, "docs/neon-profile/regression/cases.json"), "utf8")) as Array<Record<string, string>>) {
  synthetic(`fx-${c.id}`, "fixture", `regression|${c.group}`, c.expect as Expectation, c.title!, c.description ?? "", c.note || `Regression corpus group ${c.group}`, { sourceUrl: c.url });
}
// 2. Golden set.
for (const c of GOLDEN_CASES) {
  synthetic(`gold-${c.id}`, "fixture", `golden|${c.wanted ? "wanted" : "unwanted"}`, c.wanted ? "not_reject" : "not_accept", c.title, c.description, c.note ?? "Golden set", { agency: c.agency, naicsCode: c.naicsCode });
}
// 3. Audit corpus (Release A findings).
for (const c of HARD_NEGATIVES) synthetic(`audit-${c.id}`, "fixture", "audit|hard_negative", "not_accept", c.title, c.description, `Audit findings ${c.findings.join(",")}`);
for (const c of [...HARD_POSITIVES, VAGUE_TITLE_POSITIVE, RECOMPETE_SOLICITATION]) synthetic(`audit-${c.id}`, "fixture", "audit|hard_positive", "not_reject", c.title, c.description, `Audit findings ${c.findings.join(",")}`);
// 4. Release C adversarial cases.
for (const c of ADVERSARIAL_CASES) add({ ...c, provenance: "synthetic_adversarial", gateEligible: true, disagreement: null, independentSupport: ["Release C adversarial fixture"] });

// 5. Production records with two blind AI labels, disagreement detection and adjudication.
const sample = read<Array<Record<string, any>>>("production_sample.json");
const a = new Map(read<Label[]>("labels_a.json").map((l) => [l.caseId, l]));
const b = new Map(read<Label[]>("labels_b.json").map((l) => [l.caseId, l]));
let adjudication = new Map<string, Label>();
try {
  adjudication = new Map(read<Label[]>("adjudication.json").map((l) => [l.caseId, l]));
} catch {
  adjudication = new Map();
}
const rank = { high: 3, medium: 2, low: 1 } as const;
for (const row of sample) {
  const la = a.get(row.caseId);
  const lb = b.get(row.caseId);
  if (!la || !lb) continue;
  const agreed = la.label === lb.label && la.label !== "unclear";
  const disagreement = agreed ? null : `A=${la.label}/${la.confidence} B=${lb.label}/${lb.confidence}`;
  const adj = adjudication.get(row.caseId);
  const final = agreed ? la.label : adj?.label;
  if (!final || final === "unclear") continue; // unresolved: reported as a coverage gap, not used
  const confidence = agreed ? (rank[la.confidence] <= rank[lb.confidence] ? la.confidence : lb.confidence) : (adj!.confidence === "high" ? "medium" : adj!.confidence);
  const record = {
    title: row.title,
    agency: row.agency,
    type: row.type,
    description: row.description,
    naicsCode: row.naicsCode,
    pscCode: row.pscCode,
    sourceUrl: row.sourceUrl,
    responseDeadline: row.responseDeadline,
    postedDate: row.postedDate,
    setAside: row.setAside,
  };
  const support: string[] = [];
  const code = codeSupport({ record });
  if (code) support.push(`OCCU_MED_AWARE discovery code ${code}`);
  const nonProcurement = ["not_a_procurement", "award_or_closed"].includes(la.noticeStage) && la.noticeStage === lb.noticeStage;
  if (nonProcurement) support.push(`both reviewers: notice stage ${la.noticeStage}`);
  const independent =
    (final === "relevant" && Boolean(code)) ||
    (final === "not_relevant" && (nonProcurement || (Boolean(record.naicsCode || record.pscCode) && !code)));
  if (final === "not_relevant" && record.naicsCode && !code) support.push(`official codes ${record.naicsCode}/${record.pscCode ?? "-"} are not Occu-Med discovery codes`);
  add({
    caseId: row.caseId,
    source: String(row.provider ?? "production"),
    stratum: String(row.stratum),
    label: final,
    expectation: final === "relevant" ? "not_reject" : "not_accept",
    provenance: agreed ? "ai_reference_agreed" : "ai_reference_adjudicated",
    confidence,
    explanation: (agreed ? la.explanation : adj!.explanation).slice(0, 300),
    independentSupport: support,
    gateEligible: agreed && la.confidence === "high" && lb.confidence === "high" && independent,
    disagreement,
    record,
  });
}

const body = JSON.stringify(cases, null, 1);
const version = createHash("sha256").update(body).digest("hex").slice(0, 16);
writeFileSync(path.join(here, "dataset.json"), JSON.stringify({ version, builtAt: new Date().toISOString().slice(0, 10), cases }, null, 1) + "\n");
const count = (p: string) => cases.filter((c) => c.provenance === p).length;
console.log(JSON.stringify({ version, total: cases.length, synthetic_fixture: count("synthetic_fixture"), synthetic_adversarial: count("synthetic_adversarial"), ai_agreed: count("ai_reference_agreed"), ai_adjudicated: count("ai_reference_adjudicated"), gateEligible: cases.filter((c) => c.gateEligible).length, unresolved: sample.length - count("ai_reference_agreed") - count("ai_reference_adjudicated") }));
