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
 * the cited excerpts.
 */
import type { NormalizedOpportunity } from "../providers/types";
import { classifyProviderRecordRelevance } from "../providers/providerQueryMatch";
import type { RelevanceResult } from "../search/relevance";
import { decideRelevance, type RelevanceVerdict } from "../search/relevanceDecision";
import { discoverAttachments, hasAuthoritativeAttachmentList } from "../documents/attachments";
import { documentsFor, registerAttachments, sectionsFor, type StoredDocument } from "../documents/store";
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
  error: string | null;
}

const EMPTY: DocumentContext = {
  available: false,
  sections: [],
  documents: [],
  documentHashes: [],
  evidence: null,
  injectionSignals: 0,
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
    await registerAttachments(opportunityKey, discoverAttachments(record), priority, { authoritative: hasAuthoritativeAttachmentList(record) });
    const [documents, sections] = await Promise.all([documentsFor(opportunityKey), sectionsFor(opportunityKey)]);
    const excerpt = evidenceExcerpts(sections, DOCUMENT_EVIDENCE_CHARS);
    // Every current document counts, including ones not fetched yet, so a newly listed attachment changes the
    // judgment hash at once and a decision made before it was read is not reused.
    const identities = documents.map((d) => d.sha256 ?? `pending:${d.sourceUrl}`);
    const hashes = documents.map((d) => d.sha256).filter((h): h is string => Boolean(h));
    const extracted = documents.filter((d) => d.extractionStatus === "extracted").length;
    return {
      available: true,
      sections,
      documents,
      documentHashes: identities,
      evidence: excerpt.text
        ? { text: excerpt.text, citations: excerpt.citations, documents: documents.length, extracted, pending: documents.length - extracted, hashes }
        : null,
      injectionSignals: countInjectionSignals(excerpt.text),
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
export function classifyWithDocumentEvidence(record: NormalizedOpportunity): { result: RelevanceResult; usedDocuments: boolean } {
  const base = classifyProviderRecordRelevance(record);
  const evidence = documentEvidenceText(record);
  if (!evidence) return { result: base, usedDocuments: false };
  const hardRejected = base.rejected && base.confidence === "rejected" && base.negativeSignals.length > 0;
  if (hardRejected) return { result: base, usedDocuments: false };
  const augmented = classifyProviderRecordRelevance({ ...record, description: `${record.description ?? ""}\n\n${evidence}` });
  return RANK[decideRelevance(augmented).verdict] > RANK[decideRelevance(base).verdict]
    ? { result: augmented, usedDocuments: true }
    : { result: base, usedDocuments: false };
}
