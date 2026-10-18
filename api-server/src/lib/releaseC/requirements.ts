/**
 * Requirement-level evidence ledger.
 *
 * Breaks the notice and its extracted documents into individual requirements (each with document, page and section
 * citation), matches each one against the OCCU_MED_AWARE profile through the canonical classifier (no vocabulary of
 * its own: categories, terms and hard rules all come from the loaded profile), and rolls them up into a multi-axis
 * assessment: scope fit, exclusions, eligibility, source and deadline verification, and document completeness.
 *
 * The ledger is evidence for the decision, not a second decision engine: it never accepts a record by itself. Its
 * outputs feed the judge prompt (cited excerpts), the review queue (held when evidence is missing) and the UI.
 */
import { randomUUID } from "node:crypto";
import { rcPool } from "./db";
import type { NormalizedOpportunity } from "../providers/types";
import { classifyResult } from "../search/relevance";
import { getRelevanceProfile } from "../search/relevanceProfile";
import type { SectionKind } from "../documents/types";
import { ensureReleaseCSchema } from "./schema";

export type RequirementCategory = "scope" | "exclusion" | "eligibility" | "deadline" | "location" | "pricing" | "evaluation";
export type MatchStatus = "supported" | "adjacent" | "unsupported" | "excluded" | "needs_evidence" | "informational";

export interface EvidenceSection {
  id: string | null;
  documentId: string | null;
  documentTitle: string | null;
  sourceUrl: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  heading: string | null;
  kind: SectionKind;
  text: string;
}

export interface Requirement {
  requirementId: string;
  documentId: string | null;
  sectionId: string | null;
  page: number | null;
  locator: string;
  text: string;
  mandatory: boolean;
  category: RequirementCategory;
}

export interface RequirementMatch {
  requirementId: string;
  status: MatchStatus;
  capability: string | null;
  rationale: string;
  evidence: { explicit: string[]; component: string[]; negative: string[] };
}

export interface AssessmentAxis {
  status: "pass" | "fail" | "unknown" | "partial";
  detail: string;
}

export interface Assessment {
  scopeFit: AssessmentAxis & { supported: number; adjacent: number; unsupported: number; scopeRequirements: number };
  exclusions: AssessmentAxis & { excluded: string[] };
  eligibility: AssessmentAxis;
  sourceVerification: AssessmentAxis;
  deadlineVerification: AssessmentAxis;
  documentCompleteness: AssessmentAxis & { documents: number; extracted: number; pendingOrFailed: number };
  summary: string;
}

const MANDATORY = /\b(shall|must|is required to|are required to|will be required|required to|responsible for|minimum|at least|no later than)\b/i;
const REQUIREMENT_HINT = /\b(shall|must|will provide|will perform|required|responsible for|provide|perform|deliver|conduct|furnish|minimum|qualif|licens|certif|set[- ]aside|due|no later than|location|on[- ]site)\b/i;
const NOT_IN_SCOPE = /\b(not (?:be )?(?:included|required|part of|within)|excluded|exclusions?|out of scope|outside (?:the )?scope|shall not|will not be (?:required|provided)|by others|government[- ]furnished)\b/i;
const ELIGIBILITY = /\b(set[- ]aside|small business|8\(a\)|hubzone|sdvosb|wosb|edwosb|veteran[- ]owned|licens|certif|accredit|registered in sam|security clearance|clearance|board[- ]certified|credential|uei)\b/i;
const DEADLINE = /\b(due (?:date|by|on)|closing date|no later than|deadline|submission(?:s)? (?:are|is) due|questions? (?:are|is) due|offers? (?:are|is) due)\b/i;
const LOCATION = /\b(place of performance|on[- ]site|onsite|located at|location|facility|installation|nationwide|worldwide|statewide)\b/i;
const PRICING = /\b(price|pricing|clin|unit cost|firm[- ]fixed|time and materials|labor rate|cost proposal)\b/i;
const EVALUATION = /\b(evaluat|best value|lowest price technically acceptable|lpta|tradeoff|factor \d)\b/i;
const MAX_REQUIREMENTS = 400;
const MAX_REQUIREMENT_CHARS = 600;

function categoryFor(text: string, kind: SectionKind): RequirementCategory {
  if (kind === "exclusion" || NOT_IN_SCOPE.test(text)) return "exclusion";
  if (ELIGIBILITY.test(text) || kind === "qualification") return "eligibility";
  if (DEADLINE.test(text) || kind === "deadline") return "deadline";
  if (PRICING.test(text) && kind === "pricing") return "pricing";
  if (EVALUATION.test(text) && kind === "evaluation") return "evaluation";
  if (LOCATION.test(text) && kind === "location") return "location";
  return "scope";
}

/** Splits text into requirement-sized statements: bullets, numbered items and sentences. */
function statements(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n(?=\s*(?:[-*•▪◦]|\(?[a-z0-9]{1,3}[.)]|\d+(?:\.\d+)+)\s)|(?<=[.;:])\s+(?=[A-Z(])|\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 25);
}

/** Statements with the page they are on (sections spanning pages carry "[page N]" markers). */
function pagedStatements(section: EvidenceSection): Array<{ statement: string; page: number | null }> {
  const out: Array<{ statement: string; page: number | null }> = [];
  const chunks = section.text.split(/\[page (\d+)\]/);
  let page = section.pageStart;
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      page = Number(chunk);
      return;
    }
    for (const statement of statements(chunk)) out.push({ statement, page });
  });
  return out;
}

/** Description-only records still get a ledger (cited to the notice itself). */
export function noticeAsSection(record: NormalizedOpportunity): EvidenceSection {
  return {
    id: null,
    documentId: null,
    documentTitle: "Notice description",
    sourceUrl: record.sourceUrl ?? null,
    pageStart: null,
    pageEnd: null,
    heading: null,
    kind: "general",
    text: record.description ?? "",
  };
}

export function extractRequirements(sections: EvidenceSection[]): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    let index = 0;
    for (const { statement, page: statementPage } of pagedStatements(section)) {
      if (out.length >= MAX_REQUIREMENTS) return out;
      if (!REQUIREMENT_HINT.test(statement) && section.kind === "general") continue;
      const text = statement.slice(0, MAX_REQUIREMENT_CHARS);
      const dedupe = text.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      index += 1;
      const page = statementPage;
      const where = [section.documentTitle ?? "document", page != null ? `p.${page}` : null, section.heading ? `§ ${section.heading.slice(0, 80)}` : null]
        .filter(Boolean)
        .join(", ");
      out.push({
        requirementId: `${section.id ?? "notice"}#${index}`,
        documentId: section.documentId,
        sectionId: section.id,
        page,
        locator: where,
        text,
        mandatory: MANDATORY.test(text),
        category: categoryFor(text, section.kind),
      });
    }
  }
  return out;
}

/** Matches one requirement against the canonical profile through the canonical classifier. */
export function matchRequirement(requirement: Requirement): RequirementMatch {
  const profile = getRelevanceProfile();
  const result = classifyResult({ title: "", description: requirement.text, deadlineInFuture: true, allowHistorical: true });
  const evidence = {
    explicit: result.matchedExplicitPhrases.slice(0, 8),
    component: result.matchedComponentTerms.slice(0, 8),
    negative: result.negativeSignals.slice(0, 8),
  };
  const categories = result.matchedServiceCategories.filter((c) => c !== "Occu-Med profile phrase");
  const capability = result.primaryServiceCategory ?? categories[0] ?? null;
  const adjacentLabels = new Set(profile.categories.filter((c) => c.adjacentOnly).map((c) => c.label));
  const hasService = categories.length > 0 || evidence.explicit.length > 0;
  const onlyAdjacent = categories.length > 0 && categories.every((c) => adjacentLabels.has(c));

  if (profile.source === "unavailable") {
    return { requirementId: requirement.requirementId, status: "needs_evidence", capability: null, rationale: "Canonical profile unavailable", evidence };
  }
  if (requirement.category === "exclusion") {
    return hasService
      ? { requirementId: requirement.requirementId, status: "excluded", capability, rationale: `Document excludes ${capability ?? "an Occu-Med service"} from scope`, evidence }
      : { requirementId: requirement.requirementId, status: "informational", capability: null, rationale: "Exclusion of non-Occu-Med work", evidence };
  }
  if (requirement.category === "eligibility") {
    return { requirementId: requirement.requirementId, status: "needs_evidence", capability, rationale: "Eligibility or credential requirement; verify against company registrations", evidence };
  }
  if (requirement.category !== "scope") {
    return { requirementId: requirement.requirementId, status: "informational", capability, rationale: `${requirement.category} requirement`, evidence };
  }
  if (result.rejected && evidence.negative.length > 0) {
    return { requirementId: requirement.requirementId, status: "unsupported", capability, rationale: result.rejectReason ?? "Matches an Occu-Med hard-reject rule", evidence };
  }
  if (hasService && !onlyAdjacent) {
    return { requirementId: requirement.requirementId, status: "supported", capability, rationale: `Matches ${categories.join(", ") || "profile phrase"}`, evidence };
  }
  if (onlyAdjacent) {
    return { requirementId: requirement.requirementId, status: "adjacent", capability, rationale: `Adjacent-only category ${categories.join(", ")}`, evidence };
  }
  return { requirementId: requirement.requirementId, status: "unsupported", capability: null, rationale: "No Occu-Med capability evidence", evidence };
}

export interface AssessmentContext {
  documents: Array<{ extractionStatus: string; retrievalStatus: string }>;
  documentPipelineEnabled: boolean;
  now?: number;
}

const OFFICIAL_HOST = /(^|\.)((sam|usaspending|grants|fbo|gsa|va|dla|nasa|state|army|navy|af|mil)\.(gov|mil)|[a-z0-9-]+\.(gov|mil|gov\.[a-z]{2}|us))$/i;

export function buildAssessment(record: NormalizedOpportunity, requirements: Requirement[], matches: RequirementMatch[], context: AssessmentContext): Assessment {
  const scopeMatches = matches.filter((m, i) => requirements[i]?.category === "scope");
  const supported = scopeMatches.filter((m) => m.status === "supported").length;
  const adjacent = scopeMatches.filter((m) => m.status === "adjacent").length;
  const unsupported = scopeMatches.filter((m) => m.status === "unsupported").length;
  const excluded = matches.filter((m) => m.status === "excluded").map((m) => m.capability ?? m.rationale);
  const scopeStatus: AssessmentAxis["status"] =
    scopeMatches.length === 0 ? "unknown" : supported === 0 ? (adjacent > 0 ? "partial" : "fail") : supported >= unsupported ? "pass" : "partial";

  let host = "";
  try {
    host = new URL(record.sourceUrl ?? "").hostname.toLowerCase();
  } catch {
    host = "";
  }
  const official = OFFICIAL_HOST.test(host);
  const deadline = record.responseDeadline instanceof Date ? record.responseDeadline : null;
  const now = context.now ?? Date.now();
  const deadlineMentioned = requirements.some((r) => r.category === "deadline");
  const eligibilityReqs = requirements.filter((r) => r.category === "eligibility").length;

  const docs = context.documents;
  const extracted = docs.filter((d) => d.extractionStatus === "extracted").length;
  const pendingOrFailed = docs.length - extracted;
  const completeness: AssessmentAxis["status"] = !context.documentPipelineEnabled
    ? "unknown"
    : docs.length === 0
      ? "unknown"
      : pendingOrFailed === 0
        ? "pass"
        : extracted > 0
          ? "partial"
          : "fail";

  const assessment: Assessment = {
    scopeFit: {
      status: scopeStatus,
      detail: `${supported} supported, ${adjacent} adjacent, ${unsupported} unsupported of ${scopeMatches.length} scope requirements`,
      supported,
      adjacent,
      unsupported,
      scopeRequirements: scopeMatches.length,
    },
    exclusions: {
      status: excluded.length > 0 ? "fail" : "pass",
      detail: excluded.length > 0 ? `Excludes: ${excluded.slice(0, 5).join("; ")}` : "No Occu-Med service excluded",
      excluded,
    },
    eligibility: {
      status: record.setAside ? "partial" : eligibilityReqs > 0 ? "partial" : "unknown",
      detail: [record.setAside ? `Set-aside: ${record.setAside}` : null, eligibilityReqs > 0 ? `${eligibilityReqs} eligibility/credential requirements to verify` : null]
        .filter(Boolean)
        .join("; ") || "No eligibility terms found",
    },
    sourceVerification: {
      status: official ? "pass" : host ? "partial" : "unknown",
      detail: official ? `Official source ${host}` : host ? `Non-government host ${host}; confirm against the official notice` : "No source URL",
    },
    deadlineVerification: {
      status: !deadline ? "unknown" : deadline.getTime() < now ? "fail" : deadlineMentioned ? "pass" : "partial",
      detail: !deadline
        ? "No response deadline"
        : deadline.getTime() < now
          ? "Response deadline has passed"
          : deadlineMentioned
            ? `Deadline ${deadline.toISOString().slice(0, 10)} with a deadline statement in the documents`
            : `Deadline ${deadline.toISOString().slice(0, 10)} from the source metadata only`,
    },
    documentCompleteness: {
      status: completeness,
      detail: !context.documentPipelineEnabled
        ? "Document pipeline not active"
        : `${extracted} of ${docs.length} documents extracted`,
      documents: docs.length,
      extracted,
      pendingOrFailed,
    },
    summary: "",
  };
  assessment.summary = [
    `Scope ${assessment.scopeFit.status}`,
    `exclusions ${assessment.exclusions.status}`,
    `source ${assessment.sourceVerification.status}`,
    `deadline ${assessment.deadlineVerification.status}`,
    `documents ${assessment.documentCompleteness.status}`,
  ].join(", ");
  return assessment;
}

export interface Ledger {
  requirements: Requirement[];
  matches: RequirementMatch[];
  assessment: Assessment;
}

export function buildLedger(record: NormalizedOpportunity, sections: EvidenceSection[], context: AssessmentContext): Ledger {
  const source = sections.length > 0 ? sections : [noticeAsSection(record)];
  const requirements = extractRequirements(source);
  const matches = requirements.map(matchRequirement);
  return { requirements, matches, assessment: buildAssessment(record, requirements, matches, context) };
}

/**
 * Cited excerpts for the classifier and judges: scope, amendment, exclusion and qualification sections first, each
 * prefixed with its citation. Bounded so a large solicitation cannot flood a prompt.
 */
export function evidenceExcerpts(sections: EvidenceSection[], maxChars = 12_000): { text: string; citations: string[] } {
  const order: SectionKind[] = ["amendment", "scope", "exclusion", "qualification", "location", "deadline", "evaluation", "pricing", "general"];
  const sorted = [...sections].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const parts: string[] = [];
  const citations: string[] = [];
  let used = 0;
  for (const section of sorted) {
    if (used >= maxChars) break;
    const cite = `[${section.documentTitle ?? "document"}${section.pageStart != null ? `, p.${section.pageStart}${section.pageEnd && section.pageEnd !== section.pageStart ? `-${section.pageEnd}` : ""}` : ""}${section.heading ? `, ${section.heading.slice(0, 60)}` : ""}]`;
    const room = maxChars - used - cite.length - 2;
    if (room < 200) break;
    const body = section.text.slice(0, Math.min(room, 3_000));
    parts.push(`${cite} ${body}`);
    citations.push(cite);
    used += cite.length + body.length + 2;
  }
  return { text: parts.join("\n\n"), citations };
}

/** Persists the ledger; the previous one for this opportunity is superseded, not deleted. */
export async function saveLedger(opportunityKey: string, contentHash: string, ledger: Ledger): Promise<void> {
  await ensureReleaseCSchema();
  const profileVersion = getRelevanceProfile().version;
  const client = await (await rcPool()).connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT id FROM opportunity_assessments WHERE opportunity_key = $1 AND superseded_at IS NULL AND content_hash = $2 AND profile_version = $3`,
      [opportunityKey, contentHash, profileVersion],
    );
    if (current.rows.length > 0) {
      await client.query("COMMIT");
      return;
    }
    await client.query(`UPDATE opportunity_requirements SET superseded_at = now() WHERE opportunity_key = $1 AND superseded_at IS NULL`, [opportunityKey]);
    await client.query(`UPDATE opportunity_requirement_matches SET invalidated_at = now() WHERE opportunity_key = $1 AND invalidated_at IS NULL`, [opportunityKey]);
    await client.query(
      `UPDATE opportunity_assessments SET superseded_at = now(), superseded_reason = 'content_or_profile_changed' WHERE opportunity_key = $1 AND superseded_at IS NULL`,
      [opportunityKey],
    );
    for (let i = 0; i < ledger.requirements.length; i += 1) {
      const requirement = ledger.requirements[i]!;
      const match = ledger.matches[i]!;
      const rowId = randomUUID();
      await client.query(
        `INSERT INTO opportunity_requirements (id, opportunity_key, requirement_id, document_id, section_id, page, locator, requirement_text, mandatory, category, source_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [rowId, opportunityKey, requirement.requirementId, requirement.documentId, requirement.sectionId, requirement.page, requirement.locator, requirement.text, requirement.mandatory, requirement.category, contentHash],
      );
      await client.query(
        `INSERT INTO opportunity_requirement_matches (id, requirement_row_id, opportunity_key, profile_version, capability_id, status, rationale, evidence, decided_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deterministic')`,
        [randomUUID(), rowId, opportunityKey, profileVersion, match.capability, match.status, match.rationale.slice(0, 500), JSON.stringify(match.evidence)],
      );
    }
    await client.query(
      `INSERT INTO opportunity_assessments (id, opportunity_key, content_hash, profile_version, axes, summary) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), opportunityKey, contentHash, profileVersion, JSON.stringify(ledger.assessment), ledger.assessment.summary],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Compact form kept in rawData so the UI and the quality gate can read the ledger without another query. */
export function ledgerSummary(ledger: Ledger): Record<string, unknown> {
  return {
    assessment: ledger.assessment,
    requirements: ledger.requirements.slice(0, 60).map((r, i) => ({
      id: r.requirementId,
      category: r.category,
      mandatory: r.mandatory,
      locator: r.locator,
      text: r.text.slice(0, 240),
      status: ledger.matches[i]?.status,
      capability: ledger.matches[i]?.capability ?? null,
    })),
    totalRequirements: ledger.requirements.length,
  };
}
