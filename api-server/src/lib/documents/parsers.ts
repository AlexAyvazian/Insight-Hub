/**
 * Open-source, in-process document parsers for the extraction worker (never the web process).
 *
 * PDF: pdf.js via unpdf, one entry per page, image-only pages flagged for OCR.
 * DOCX / XLSX: unzipped with fflate and read from their XML parts; explicit page breaks become page boundaries,
 *   worksheets become pages. Archive members are size-checked before inflation (zip-bomb guard).
 * HTML / text: scripts, styles and markup removed; one logical page.
 * Legacy .doc/.xls, images and unknown formats are reported as needing a remote extractor, never guessed.
 */
import { unzipSync, strFromU8 } from "fflate";
import type { DocumentFormat, ExtractedPage, ParsedDocument } from "./types";

export const MAX_UNZIPPED_BYTES = 60 * 1024 * 1024;
const MIN_TEXT_CHARS_PER_PAGE = 25;

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function detectFormat(bytes: Uint8Array, contentType = "", url = ""): DocumentFormat {
  const lowerUrl = url.toLowerCase().split(/[?#]/)[0] ?? "";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    try {
      const parts = unzipSync(bytes, { filter: (file) => file.name === "[Content_Types].xml" && file.originalSize < 1_000_000 });
      const manifest = parts["[Content_Types].xml"];
      if (!manifest) return "zip";
      const types = strFromU8(manifest);
      if (types.includes("wordprocessingml")) return "docx";
      if (types.includes("spreadsheetml")) return "xlsx";
      return "unsupported";
    } catch {
      return "unsupported";
    }
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return "legacy_office"; // OLE2 .doc/.xls
  if (
    startsWith(bytes, [0xff, 0xd8, 0xff]) ||
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ||
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return "image";
  }
  const type = contentType.toLowerCase();
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 2048)).toLowerCase();
  if (type.includes("html") || /<!doctype html|<html[\s>]/.test(head) || /\.html?$/.test(lowerUrl)) return "html";
  if (type.startsWith("text/") || /\.(txt|csv)$/.test(lowerUrl)) return "text";
  return "unsupported";
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function safeUnzip(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  let total = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      if (!wanted(file.name)) return false;
      total += file.originalSize;
      if (file.originalSize > MAX_UNZIPPED_BYTES || total > MAX_UNZIPPED_BYTES) {
        throw new Error(`Archive member ${file.name} inflates beyond ${MAX_UNZIPPED_BYTES} bytes`);
      }
      return true;
    },
  });
}

function finalise(format: DocumentFormat, pages: ExtractedPage[], method: string, warnings: string[] = []): ParsedDocument {
  return {
    format,
    pageCount: pages.length,
    pages,
    extractedPageCount: pages.filter((page) => !page.needsOcr).length,
    method,
    warnings,
  };
}

export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js mutates/transfers the buffer; give it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, disableFontFace: true } as never);
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pageTexts = Array.isArray(text) ? text : [String(text)];
    const pages: ExtractedPage[] = [];
    for (let index = 0; index < totalPages; index += 1) {
      const value = (pageTexts[index] ?? "").replace(/[ \t]+/g, " ").trim();
      pages.push({ page: index + 1, text: value, needsOcr: value.replace(/\s/g, "").length < MIN_TEXT_CHARS_PER_PAGE });
    }
    return finalise("pdf", pages, "pdfjs-text-layer");
  } finally {
    await (pdf as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

export function parseDocx(bytes: Uint8Array): ParsedDocument {
  const files = safeUnzip(bytes, (name) => name === "word/document.xml" || /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(name));
  const documentXml = files["word/document.xml"];
  if (!documentXml) return finalise("docx", [], "docx-xml", ["word/document.xml missing"]);
  const xml = strFromU8(documentXml);
  const pages: string[][] = [[]];
  // Walk paragraphs in order. Only explicit page breaks start a new page: Word also writes a
  // lastRenderedPageBreak marker for the same boundary, so counting both would double-count pages. Text before a
  // break stays on the current page and text after it starts the next one.
  for (const paragraph of xml.split(/<\/w:p>/)) {
    let buffer = "";
    const flush = () => {
      const text = decodeXmlEntities(buffer).trim();
      if (text) pages[pages.length - 1]!.push(text);
      buffer = "";
    };
    for (const match of paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/?>/g)) {
      if (match[1] !== undefined) buffer += match[1];
      else if (match[0].startsWith("<w:tab")) buffer += "\t";
      else if (/w:type="page"/.test(match[0])) {
        flush();
        pages.push([]);
      } else buffer += "\n";
    }
    flush();
  }
  const extra = Object.entries(files)
    .filter(([name]) => name !== "word/document.xml")
    .map(([, value]) => decodeXmlEntities(strFromU8(value).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out = pages
    .map((lines, index) => ({ page: index + 1, text: lines.join("\n"), needsOcr: false }))
    .filter((page, index, all) => page.text || index === 0 || index < all.length - 1);
  if (extra.length && out.length) out[out.length - 1]!.text += `\n\n[Headers, footers and notes]\n${extra.join("\n")}`;
  return finalise("docx", out, "docx-xml");
}

export function parseXlsx(bytes: Uint8Array): ParsedDocument {
  const files = safeUnzip(bytes, (name) => name === "xl/sharedStrings.xml" || name === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const shared: string[] = [];
  const sharedXml = files["xl/sharedStrings.xml"] ? strFromU8(files["xl/sharedStrings.xml"]) : "";
  for (const item of sharedXml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    shared.push(decodeXmlEntities((item.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  }
  const workbook = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const sheetNames = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((match) => decodeXmlEntities(match[1]!));
  const sheets = Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  const pages: ExtractedPage[] = sheets.map((name, index) => {
    const xml = strFromU8(files[name]!);
    const rows = (xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []).map((row) =>
      (row.match(/<c\b[\s\S]*?(?:\/>|<\/c>)/g) ?? [])
        .map((cell) => {
          const type = cell.match(/\bt="([^"]+)"/)?.[1];
          const value = cell.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          const inline = cell.match(/<is>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1];
          if (type === "s" && value != null) return shared[Number(value)] ?? "";
          if (inline != null) return decodeXmlEntities(inline);
          return value != null ? decodeXmlEntities(value) : "";
        })
        .join("\t")
        .trim(),
    );
    const title = sheetNames[index] ?? `Sheet ${index + 1}`;
    return { page: index + 1, text: `[Worksheet: ${title}]\n${rows.filter(Boolean).join("\n")}`, needsOcr: false };
  });
  return finalise("xlsx", pages, "xlsx-xml");
}

export function htmlToText(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg|iframe|object)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

export function parseHtml(bytes: Uint8Array): ParsedDocument {
  const text = htmlToText(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  return finalise("html", [{ page: 1, text, needsOcr: false }], "html-text");
}

export function parseText(bytes: Uint8Array): ParsedDocument {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  return finalise("text", [{ page: 1, text, needsOcr: false }], "plain-text");
}

/** Parses a document natively. Formats that need a remote extractor return pages flagged `needsOcr`. */
export async function parseDocumentNatively(bytes: Uint8Array, contentType = "", url = ""): Promise<ParsedDocument> {
  const format = detectFormat(bytes, contentType, url);
  switch (format) {
    case "pdf":
      return parsePdf(bytes);
    case "docx":
      return parseDocx(bytes);
    case "xlsx":
      return parseXlsx(bytes);
    case "html":
      return parseHtml(bytes);
    case "text":
      return parseText(bytes);
    case "legacy_office":
    case "image":
      return { format, pageCount: 1, pages: [{ page: 1, text: "", needsOcr: true }], extractedPageCount: 0, method: "none", warnings: [`${format} requires a remote extractor`] };
    default:
      return { format, pageCount: 0, pages: [], extractedPageCount: 0, method: "none", warnings: [`unsupported format (${contentType || "unknown"})`] };
  }
}
