/**
 * Full-document evidence for the Opportunities decision.
 *
 * When the document pipeline is active, every non-rejected record has its official documents registered for
 * extraction, and whatever has already been extracted is turned into cited excerpts (document, page, section) that
 * travel with the record in rawData.documentEvidence. Relevance is then judged on the notice plus its documents
 * instead of a description prefix.
 *
 * Direction rule: document text can raise a record (thin SAM description + a SOW that buys physicals) but cannot by
 * itself sink one. Long solicitations carry boilerplate (FAR clauses, workers' compensation insurance, safety
 * plans) that would trip hard rules; real exclusions are handled by the requirement ledger and the judges, who see
 * the cited excerpts. Documents can, however, take away an automatic approval: when a document explicitly excludes
 * an Occu-Med service, or an amendment deletes or cancels one, an "accept" becomes "review" so newer authoritative
 * evidence is adjudicated instead of being outvoted by the original notice.
 */
import type { NormalizedOpportunity } from "../providers/types";
import { classifyProviderRecordRelevance } from "../providers/providerQueryMatch";
import type { RelevanceResult } from "../search/relevance";
import { decideRelevance, type RelevanceVerdict } from "../search/relevanceDecision";
import { getRelevanceProfile } from "../search/relevanceProfile";
import { discoverAttachmentsWithCoverage, hasAuthoritativeAttachmentList } from "../documents/attachments";
import { documentsFor, registerAttachments, sectionsFor, type StoredDocument } from "../documents/store";
import { isCurrentlyExtracted } from "../documents/types";
import { countInjectionSignals } from "../security/untrustedContent";
import type { ReleaseCFlags } from "./flags";
import { evidenceExcerpts, type EvidenceSection } from "./requirements";

export const DOCUMENT_EVIDENCE_CHARS = 12_000;

export interface DocumentEvidence {
  text: string;
  citations: string[];
  documents: number;
  extracted: number;
  pending: number;
  hashes: string[];
}

export interface DocumentContext {
  available: boolean;
  sections: EvidenceSection[];
  documents: StoredDocument[];
  documentHashes: string[];
  evidence: DocumentEvidence | null;
  injectionSignals: number;
  /** Listed attachments over the registration cap; the set is incomplete while this is above zero. */
  attachmentsNotRegistered: number;
  error: string | null;
}

const EMPTY: DocumentContext = {
  available: false,
  sections: [],
  documents: [],
  documentHashes: [],
  evidence: null,
  injectionSignals: 0,
  attachmentsNotRegistered: 0,
  error: null,
};

/** Registers the record's documents for extraction and loads what has already been extracted. Never throws. */
export async function loadDocumentContext(
  record: NormalizedOpportunity,
  opportunityKey: string,
  flags: ReleaseCFlags,
  priority = 0,
): Promise<DocumentContext> {
  if (!flags.documentPipeline) return EMPTY;
  try {
    const discovery = discoverAttachmentsWithCoverage(record);
    await registerAttachments(opportunityKey, discovery.attachments, priority, {
      authoritative: hasAuthoritativeAttachmentList(record),
      listedUrls: discovery.listedUrls,
    });
    const [documents, sections] = await Promise.all([documentsFor(opportunityKey), sectionsFor(opportunityKey)]);
    const excerpt = evidenceExcerpts(sections, DOCUMENT_EVIDENCE_CHARS);
    // Every current document counts, including ones not fetched yet, so a newly listed attachment changes the
    // judgment hash at once and a decision made before it was read is not reused.
    // A restored attachment awaiting its re-check counts as pending too, so an earlier decision is not reused.
    const identities = documents.map((d) => (d.sha256 && d.retrievalStatus !== "recheck" ? d.sha256 : `pending:${d.sourceUrl}`));
    const hashes = documents.map((d) => d.sha256).filter((h): h is string => Boolean(h));
    const extracted = documents.filter(isCurrentlyExtracted).length;
    return {
      available: true,
      sections,
      documents,
      documentHashes: identities,
      evidence: excerpt.text
        ? { text: excerpt.text, citations: excerpt.citations, documents: documents.length, extracted, pending: documents.length - extracted, hashes }
        : null,
      injectionSignals: countInjectionSignals(excerpt.text),
      attachmentsNotRegistered: discovery.overflow,
      error: null,
    };
  } catch (error) {
    return { ...EMPTY, error: error instanceof Error ? error.message : String(error) };
  }
}

export function withDocumentEvidence(record: NormalizedOpportunity, context: DocumentContext): NormalizedOpportunity {
  if (!context.evidence) return record;
  return { ...record, rawData: { ...(record.rawData ?? {}), documentEvidence: context.evidence } };
}

export function documentEvidenceText(record: NormalizedOpportunity): string {
  const evidence = (record.rawData as Record<string, unknown> | undefined)?.documentEvidence as { text?: unknown } | undefined;
  return typeof evidence?.text === "string" ? evidence.text.slice(0, DOCUMENT_EVIDENCE_CHARS) : "";
}

const RANK: Record<RelevanceVerdict, number> = { reject: 0, review: 1, accept: 2 };

/**
 * The relevance result for a record with its document evidence: the notice alone, unless the documents raise it.
 * A hard-rule rejection of the notice itself is never overturned by documents.
 */
export function classifyWithDocumentEvidence(record: NormalizedOpportunity): { result: RelevanceResult; usedDocuments: boolean; contradictions: string[] } {
  const base = classifyProviderRecordRelevance(record);
  const evidence = documentEvidenceText(record);
  if (!evidence) return { result: base, usedDocuments: false, contradictions: [] };
  const hardRejected = base.rejected && base.confidence === "rejected" && base.negativeSignals.length > 0;
  if (hardRejected) return { result: base, usedDocuments: false, contradictions: [] };
  const augmented = classifyProviderRecordRelevance({ ...record, description: `${record.description ?? ""}\n\n${evidence}` });
  const raised = RANK[decideRelevance(augmented).verdict] > RANK[decideRelevance(base).verdict];
  const chosen = raised ? augmented : base;
  const contradictions = contradictingStatements(evidence, record);
  if (contradictions.length > 0 && decideRelevance(chosen).verdict === "accept") {
    return { result: capToReview(chosen, contradictions), usedDocuments: true, contradictions };
  }
  return { result: chosen, usedDocuments: raised, contradictions };
}

const EXCLUSION_LANGUAGE = /\b(not (?:be )?(?:included|required|part of|within)|excluded|exclusions?|out of scope|outside (?:the )?scope|shall not (?:provide|perform|include)|will not be (?:required|provided|performed))\b/i;
const REMOVAL_LANGUAGE = /\b(is (?:hereby )?(?:deleted|removed|cancel+ed|withdrawn|rescinded)|are (?:hereby )?(?:deleted|removed|cancel+ed)|no longer (?:required|needed|included|part of)|(?:solicitation|requirement|notice) (?:has been|is) cancel+ed)\b/i;

/**
 * Document statements that take scope away: explicit exclusions or amendment deletions that themselves name an
 * Occu-Med service. A bare "excluded" in boilerplate does not count; the statement must carry the service.
 */
export function contradictingStatements(evidence: string, record: NormalizedOpportunity): string[] {
  const out: string[] = [];
  const statements = evidence
    .replace(/\r/g, "")
    .split(/(?<=[.:])\s+(?=[A-Z(\[])|(?<=;)\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 20 && s.length <= 1_200);
  for (const statement of statements) {
    if (!EXCLUSION_LANGUAGE.test(statement) && !REMOVAL_LANGUAGE.test(statement)) continue;
    // The statement alone, under the record's own metadata, so only the statement's wording decides the match.
    const match = classifyProviderRecordRelevance({ ...record, title: "", description: statement, rawData: {} });
    if (match.matchedExplicitPhrases.length > 0 || match.matchedServiceCategories.some((c) => c !== "Occu-Med profile phrase")) {
      out.push(statement.slice(0, 300));
      if (out.length >= 5) break;
    }
  }
  return out;
}

function capToReview(result: RelevanceResult, contradictions: string[]): RelevanceResult {
  const { acceptMin, reviewMin } = getRelevanceProfile().thresholds;
  return {
    ...result,
    score: Math.max(reviewMin, Math.min(result.score, acceptMin - 1)),
    reasons: [...result.reasons, `Documents contradict the notice: ${contradictions[0]}`],
    reasonCodes: [...result.reasonCodes, "DOCUMENT_CONTRADICTS_SCOPE"],
  };
}
