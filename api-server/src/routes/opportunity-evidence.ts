/**
 * Read-only evidence views for one opportunity (Opportunities wave 2):
 *   GET /opportunities/:id/versions   OCDS-style release history (tender, amendments, cancellation, updates)
 *   GET /opportunities/:id/documents  the full attachment inventory with processing status, page and section
 *                                     counts, and what is still unread (deferred, failed, needs OCR, too large)
 * Both degrade to empty lists when the Release C tables are unavailable; neither writes anything.
 */
import { Router } from "express";
import { eq } from "drizzle-orm";
import { rfpDb as db, opportunitiesTable } from "@workspace/db";
import { rcPool } from "../lib/releaseC/db";
import { ensureReleaseCSchema } from "../lib/releaseC/schema";
import { listOpportunityVersions } from "../lib/releaseC/versions";
import { isCurrentlyExtracted } from "../lib/documents/types";

const router = Router();

async function opportunityKeyFor(id: string): Promise<string | null> {
  const [row] = await db
    .select({ providerKey: opportunitiesTable.providerKey, noticeId: opportunitiesTable.noticeId })
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, id))
    .limit(1);
  if (!row) return null;
  return `provider:${row.providerKey ?? "manual"}:${String(row.noticeId ?? "").trim().toLowerCase()}`;
}

function safeLocation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

router.get("/opportunities/:id/versions", async (req, res) => {
  try {
    const key = await opportunityKeyFor(req.params.id);
    if (!key) return res.status(404).json({ error: "Opportunity not found" });
    const versions = await listOpportunityVersions(req.params.id).catch((): Awaited<ReturnType<typeof listOpportunityVersions>> => []);
    return res.json({
      opportunityId: req.params.id,
      versions: versions.map((version) => ({ ...version, sourceUrl: safeLocation(version.sourceUrl) })),
      amendments: versions.filter((version) => version.releaseTag === "amendment").length,
      cancelled: versions[0]?.releaseTag === "cancellation",
    });
  } catch (err) {
    req.log?.error(err);
    return res.status(500).json({ error: "Failed to load version history" });
  }
});

export type DocumentState = "read" | "partial" | "pending" | "deferred" | "needs_ocr" | "quota_wait" | "failed" | "inaccessible" | "too_large" | "unsupported" | "withdrawn";

export function documentState(row: { retrieval_status: string; extraction_status: string; superseded_by: string | null }): DocumentState {
  if (row.superseded_by === "withdrawn") return "withdrawn";
  if (row.retrieval_status === "deferred") return "deferred";
  if (row.retrieval_status === "too_large") return "too_large";
  if (row.retrieval_status === "blocked" || row.retrieval_status === "failed") return "inaccessible";
  if (row.retrieval_status === "unsupported" || row.extraction_status === "unsupported") return "unsupported";
  if (isCurrentlyExtracted({ extractionStatus: row.extraction_status, retrievalStatus: row.retrieval_status })) return "read";
  if (row.extraction_status === "partial") return "partial";
  if (row.extraction_status === "needs_ocr") return "needs_ocr";
  if (row.extraction_status === "quota_wait") return "quota_wait";
  if (row.extraction_status === "failed") return "failed";
  return "pending";
}

router.get("/opportunities/:id/documents", async (req, res) => {
  try {
    const key = await opportunityKeyFor(req.params.id);
    if (!key) return res.status(404).json({ error: "Opportunity not found" });
    await ensureReleaseCSchema();
    const result = await (await rcPool()).query(
      `SELECT d.id, d.source_url, d.title, d.document_role, d.content_type, d.byte_size, d.page_count, d.extracted_page_count,
              d.retrieval_status, d.extraction_status, d.extraction_method, d.sha256, d.superseded_by, d.amended_at,
              d.first_seen_at, d.last_checked_at,
              (SELECT count(*)::int FROM opportunity_document_sections s WHERE s.document_id = d.id) AS sections,
              (SELECT min(s.page_start) FROM opportunity_document_sections s WHERE s.document_id = d.id) AS first_page,
              (SELECT max(s.page_end) FROM opportunity_document_sections s WHERE s.document_id = d.id) AS last_page
         FROM opportunity_documents d
        WHERE d.opportunity_key = $1 AND (d.superseded_by IS NULL OR d.superseded_by = 'withdrawn')
        ORDER BY d.first_seen_at, d.id`,
      [key],
    );
    const documents = result.rows.map((row) => ({
      id: String(row.id),
      title: (row.title as string | null) ?? null,
      url: safeLocation(row.source_url),
      role: String(row.document_role),
      contentType: (row.content_type as string | null) ?? null,
      bytes: row.byte_size == null ? null : Number(row.byte_size),
      pages: row.page_count == null ? null : Number(row.page_count),
      pagesRead: row.extracted_page_count == null ? null : Number(row.extracted_page_count),
      sections: Number(row.sections ?? 0),
      pageRange: row.first_page == null ? null : [Number(row.first_page), Number(row.last_page ?? row.first_page)],
      state: documentState(row as { retrieval_status: string; extraction_status: string; superseded_by: string | null }),
      hash: row.sha256 ? String(row.sha256).slice(0, 16) : null,
      amendedAt: row.amended_at ? new Date(row.amended_at as string).toISOString() : null,
      firstSeenAt: new Date(row.first_seen_at as string).toISOString(),
      lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at as string).toISOString() : null,
    }));
    const byState = documents.reduce<Record<string, number>>((acc, doc) => ({ ...acc, [doc.state]: (acc[doc.state] ?? 0) + 1 }), {});
    const current = documents.filter((doc) => doc.state !== "withdrawn");
    const unread = current.filter((doc) => doc.state !== "read");
    return res.json({
      opportunityId: req.params.id,
      documents,
      summary: {
        listed: current.length,
        read: current.length - unread.length,
        unread: unread.length,
        withdrawn: documents.length - current.length,
        byState,
        // Never presented as fully assessed while anything listed is unread.
        complete: current.length > 0 && unread.length === 0,
      },
    });
  } catch (err) {
    req.log?.error(err);
    return res.status(500).json({ error: "Failed to load documents" });
  }
});

export default router;
