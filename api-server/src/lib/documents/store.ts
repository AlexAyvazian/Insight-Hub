/**
 * Persistence for the document inventory, cited sections and extraction job queue (Release C tables).
 *
 * Content cache: a document whose SHA-256 was already extracted is never extracted again; its sections are
 * re-used. A changed hash (new amendment, re-posted attachment) creates a new document version, supersedes the old
 * one, and reopens downstream decisions through the content hash.
 */
import { createHash, randomUUID } from "node:crypto";
import { rcPool } from "../releaseC/db";
import { ensureReleaseCSchema } from "../releaseC/schema";
import type { AttachmentRef, DocumentSection, ExtractionStatus, RetrievalStatus } from "./types";

export interface StoredDocument {
  id: string;
  opportunityKey: string;
  sourceUrl: string;
  role: string;
  title: string | null;
  sha256: string | null;
  retrievalStatus: RetrievalStatus;
  extractionStatus: ExtractionStatus;
  pageCount: number | null;
  extractedPageCount: number | null;
  extractionProvider: string | null;
  supersededBy: string | null;
}

export interface StoredSection extends DocumentSection {
  id: string;
  documentId: string;
  documentTitle: string | null;
  sourceUrl: string;
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toDocument(row: Record<string, unknown>): StoredDocument {
  return {
    id: String(row.id),
    opportunityKey: String(row.opportunity_key),
    sourceUrl: String(row.source_url),
    role: String(row.document_role),
    title: (row.title as string | null) ?? null,
    sha256: (row.sha256 as string | null) ?? null,
    retrievalStatus: row.retrieval_status as RetrievalStatus,
    extractionStatus: row.extraction_status as ExtractionStatus,
    pageCount: row.page_count == null ? null : Number(row.page_count),
    extractedPageCount: row.extracted_page_count == null ? null : Number(row.extracted_page_count),
    extractionProvider: (row.extraction_provider as string | null) ?? null,
    supersededBy: (row.superseded_by as string | null) ?? null,
  };
}

/** Registers attachments for an opportunity (idempotent per URL) and queues one extraction job per new document. */
export async function registerAttachments(
  opportunityKey: string,
  attachments: AttachmentRef[],
  priority: number,
): Promise<{ registered: number; queued: number }> {
  if (attachments.length === 0) return { registered: 0, queued: 0 };
  await ensureReleaseCSchema();
  let registered = 0;
  let queued = 0;
  for (const attachment of attachments) {
    const existing = await (await rcPool()).query(
      `SELECT id FROM opportunity_documents WHERE opportunity_key = $1 AND source_url = $2 AND superseded_by IS NULL LIMIT 1`,
      [opportunityKey, attachment.url],
    );
    let documentId = existing.rows[0]?.id as string | undefined;
    if (!documentId) {
      documentId = randomUUID();
      await (await rcPool()).query(
        `INSERT INTO opportunity_documents (id, opportunity_key, source_url, document_role, title, source_version, amended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [documentId, opportunityKey, attachment.url, attachment.role, attachment.title, attachment.sourceVersion, attachment.amendedAt],
      );
      registered += 1;
    }
    const job = await (await rcPool()).query(
      `INSERT INTO document_extraction_jobs (id, document_id, opportunity_key, priority)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (document_id) DO UPDATE SET
         priority = GREATEST(document_extraction_jobs.priority, EXCLUDED.priority),
         -- A previously finished document is re-checked (cheap hash comparison) when it is registered again.
         status = CASE WHEN document_extraction_jobs.status IN ('done','failed') AND document_extraction_jobs.updated_at < now() - interval '20 hours'
                       THEN 'queued' ELSE document_extraction_jobs.status END,
         next_attempt_at = CASE WHEN document_extraction_jobs.status IN ('done','failed') AND document_extraction_jobs.updated_at < now() - interval '20 hours'
                       THEN now() ELSE document_extraction_jobs.next_attempt_at END,
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [randomUUID(), documentId, opportunityKey, priority],
    );
    if (job.rows[0]?.inserted) queued += 1;
  }
  return { registered, queued };
}

export interface ClaimedJob {
  jobId: string;
  documentId: string;
  opportunityKey: string;
  attempts: number;
  document: StoredDocument;
}

/** Claims the most urgent due job with SKIP LOCKED so several workers never process the same document. */
export async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
  await ensureReleaseCSchema();
  const result = await (await rcPool()).query(
    `UPDATE document_extraction_jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM document_extraction_jobs
       WHERE (status IN ('queued','quota_wait') AND next_attempt_at <= now())
          OR (status = 'running' AND locked_at < now() - interval '15 minutes')
       ORDER BY priority DESC, next_attempt_at ASC
       FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, document_id, opportunity_key, attempts`,
    [workerId],
  );
  const job = result.rows[0];
  if (!job) return null;
  const doc = await (await rcPool()).query(`SELECT * FROM opportunity_documents WHERE id = $1`, [job.document_id]);
  if (!doc.rows[0]) {
    await finishJob(String(job.id), "failed", "document row missing");
    return null;
  }
  return {
    jobId: String(job.id),
    documentId: String(job.document_id),
    opportunityKey: String(job.opportunity_key),
    attempts: Number(job.attempts),
    document: toDocument(doc.rows[0]),
  };
}

export async function finishJob(
  jobId: string,
  status: "done" | "failed" | "quota_wait" | "queued",
  error: string | null = null,
  retryAt: Date | null = null,
): Promise<void> {
  await (await rcPool()).query(
    `UPDATE document_extraction_jobs SET status = $2, last_error = $3, next_attempt_at = coalesce($4, now()),
       locked_by = NULL, locked_at = NULL, updated_at = now() WHERE id = $1`,
    [jobId, status, error?.slice(0, 500) ?? null, retryAt],
  );
}

export async function findExtractedByHash(sha: string): Promise<StoredDocument | null> {
  const result = await (await rcPool()).query(
    `SELECT * FROM opportunity_documents WHERE sha256 = $1 AND extraction_status IN ('extracted','partial')
     ORDER BY (extraction_status = 'extracted') DESC, updated_at DESC LIMIT 1`,
    [sha],
  );
  return result.rows[0] ? toDocument(result.rows[0]) : null;
}

export async function updateDocument(id: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((key, index) => `${key} = $${index + 2}`);
  await (await rcPool()).query(
    `UPDATE opportunity_documents SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((key) => fields[key])],
  );
}

/**
 * Records a new content version: when the hash differs from the stored one, a new document row is created and the
 * old one is marked superseded (kept for the audit trail, never deleted).
 */
export async function recordDocumentVersion(
  document: StoredDocument,
  sha: string,
  fields: Record<string, unknown>,
): Promise<{ documentId: string; changed: boolean }> {
  if (!document.sha256 || document.sha256 === sha) {
    await updateDocument(document.id, { sha256: sha, ...fields });
    return { documentId: document.id, changed: Boolean(document.sha256 && document.sha256 !== sha) };
  }
  // Content that reverts to an earlier version reuses that version's row (the unique index allows one row per hash).
  const previous = await (await rcPool()).query(
    `SELECT id FROM opportunity_documents WHERE opportunity_key = $1 AND source_url = $2 AND sha256 = $3 AND id <> $4 LIMIT 1`,
    [document.opportunityKey, document.sourceUrl, sha, document.id],
  );
  const reused: string | undefined = previous.rows[0]?.id;
  const id = reused ?? randomUUID();
  if (reused) {
    await updateDocument(reused, { superseded_by: null, amended_at: new Date() });
  } else {
    await (await rcPool()).query(
      `INSERT INTO opportunity_documents (id, opportunity_key, opportunity_id, source_url, document_role, title, source_version, amended_at, sha256)
       SELECT $2, opportunity_key, opportunity_id, source_url, document_role, title, source_version, now(), $3 FROM opportunity_documents WHERE id = $1`,
      [document.id, id, sha],
    );
  }
  await updateDocument(document.id, { superseded_by: id });
  await updateDocument(id, fields);
  await (await rcPool()).query(
    `INSERT INTO opportunity_audit_log (id, opportunity_key, event, details) VALUES ($1,$2,'document_version_changed',$3)`,
    [randomUUID(), document.opportunityKey, JSON.stringify({ from: document.id, to: id, previousSha: document.sha256, sha, reusedVersion: Boolean(reused) })],
  );
  await (await rcPool()).query(
    `UPDATE document_extraction_jobs SET document_id = $2
     WHERE document_id = $1 AND NOT EXISTS (SELECT 1 FROM document_extraction_jobs WHERE document_id = $2)`,
    [document.id, id],
  );
  return { documentId: id, changed: true };
}

export async function replaceSections(documentId: string, opportunityKey: string, sections: DocumentSection[]): Promise<void> {
  await (await rcPool()).query(`DELETE FROM opportunity_document_sections WHERE document_id = $1`, [documentId]);
  for (const section of sections) {
    await (await rcPool()).query(
      `INSERT INTO opportunity_document_sections (id, document_id, opportunity_key, ordinal, page_start, page_end, heading, section_kind, text, char_count, sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [randomUUID(), documentId, opportunityKey, section.ordinal, section.pageStart, section.pageEnd, section.heading, section.kind, section.text, section.text.length, sha256Hex(section.text)],
    );
  }
}

export async function copySections(fromDocumentId: string, toDocumentId: string, opportunityKey: string): Promise<number> {
  // Replaces, never appends, so a reactivated row does not end up with duplicate sections.
  await (await rcPool()).query(`DELETE FROM opportunity_document_sections WHERE document_id = $1`, [toDocumentId]);
  const result = await (await rcPool()).query(
    `INSERT INTO opportunity_document_sections (id, document_id, opportunity_key, ordinal, page_start, page_end, heading, section_kind, text, char_count, sha256)
     SELECT gen_random_uuid()::text, $2, $3, ordinal, page_start, page_end, heading, section_kind, text, char_count, sha256
     FROM opportunity_document_sections WHERE document_id = $1`,
    [fromDocumentId, toDocumentId, opportunityKey],
  );
  return result.rowCount ?? 0;
}

export async function documentsFor(opportunityKey: string): Promise<StoredDocument[]> {
  await ensureReleaseCSchema();
  const result = await (await rcPool()).query(
    `SELECT * FROM opportunity_documents WHERE opportunity_key = $1 AND superseded_by IS NULL ORDER BY first_seen_at`,
    [opportunityKey],
  );
  return result.rows.map(toDocument);
}

export async function sectionsFor(opportunityKey: string): Promise<StoredSection[]> {
  await ensureReleaseCSchema();
  const result = await (await rcPool()).query(
    `SELECT s.*, d.title AS document_title, d.source_url FROM opportunity_document_sections s
     JOIN opportunity_documents d ON d.id = s.document_id
     WHERE s.opportunity_key = $1 AND d.superseded_by IS NULL ORDER BY d.first_seen_at, s.ordinal`,
    [opportunityKey],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    documentId: String(row.document_id),
    documentTitle: (row.document_title as string | null) ?? null,
    sourceUrl: String(row.source_url),
    ordinal: Number(row.ordinal),
    pageStart: row.page_start == null ? null : Number(row.page_start),
    pageEnd: row.page_end == null ? null : Number(row.page_end),
    heading: (row.heading as string | null) ?? null,
    kind: row.section_kind,
    text: String(row.text),
  }));
}

export async function queueStats(): Promise<Record<string, number>> {
  await ensureReleaseCSchema();
  const result = await (await rcPool()).query(`SELECT status, count(*)::int AS n FROM document_extraction_jobs GROUP BY status`);
  return Object.fromEntries(result.rows.map((row) => [String(row.status), Number(row.n)]));
}
