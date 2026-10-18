export type DocumentFormat = "pdf" | "docx" | "xlsx" | "html" | "text" | "legacy_office" | "image" | "zip" | "unsupported";

export type DocumentRole = "notice" | "sow" | "amendment" | "attachment" | "qa" | "pricing";

/** One extracted page (or sheet / logical block for formats without pages). `page` is 1-based. */
export interface ExtractedPage {
  page: number;
  text: string;
  /** True when the page had no extractable text layer (scanned image) and needs OCR. */
  needsOcr: boolean;
}

export interface ParsedDocument {
  format: DocumentFormat;
  pageCount: number;
  pages: ExtractedPage[];
  /** Pages whose text was obtained (natively or by OCR). */
  extractedPageCount: number;
  method: string;
  warnings: string[];
}

export type SectionKind =
  | "scope"
  | "exclusion"
  | "qualification"
  | "deadline"
  | "location"
  | "pricing"
  | "amendment"
  | "evaluation"
  | "general";

export interface DocumentSection {
  ordinal: number;
  pageStart: number | null;
  pageEnd: number | null;
  heading: string | null;
  kind: SectionKind;
  text: string;
}

export interface AttachmentRef {
  url: string;
  title: string | null;
  role: DocumentRole;
  /** Provider version marker (amendment number, modified date) when the source exposes one. */
  sourceVersion: string | null;
  amendedAt: Date | null;
}

export type RetrievalStatus = "pending" | "fetched" | "failed" | "blocked" | "unsupported" | "too_large";

export type ExtractionStatus = "pending" | "extracted" | "partial" | "failed" | "needs_ocr" | "quota_wait" | "unsupported";
