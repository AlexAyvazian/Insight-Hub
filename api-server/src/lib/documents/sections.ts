/**
 * Splits extracted pages into cited sections and classifies each section by role (scope of work, exclusions,
 * bidder qualifications, deadlines, place of performance, pricing, amendment, evaluation).
 *
 * Every section keeps its page range so later conclusions can cite "document X, pages 21-22". Long sections are
 * split on paragraph boundaries so evidence late in a document is never truncated away.
 */
import type { DocumentSection, ExtractedPage, SectionKind } from "./types";

const MAX_SECTION_CHARS = 6_000;
export const PAGE_MARKER_PREFIX = "[page ";
export const PAGE_MARKER = /\[page (\d+)\]/g;

const HEADING = /^(?:(?:section|part|article|attachment|exhibit|appendix)\s+[\w.-]+[:.\s-]*|[A-Z]?\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+|[IVXLC]{1,6}\.\s+)?[A-Z][A-Za-z0-9 ,&/()'-]{2,90}$/;

const KIND_PATTERNS: Array<[SectionKind, RegExp]> = [
  ["amendment", /\b(amendment|modification|addendum|amended|revised (?:due|closing) date|changes? to the solicitation)\b/i],
  ["exclusion", /\b(not (?:included|part of|within) (?:the|this) scope|excluded|exclusions?|out of scope|shall not (?:include|be required)|does not include|is not required)\b/i],
  ["qualification", /\b(minimum qualifications?|offeror (?:must|shall) (?:be|have|possess)|licen[cs]ed|certif(?:ied|ication)|accredit|registered in sam|set[- ]aside|small business|8\(a\)|hubzone|sdvosb|wosb|eligib|security clearance|past performance)\b/i],
  ["deadline", /\b(due date|closing date|response deadline|proposals? (?:are )?due|quotes? (?:are )?due|submission deadline|questions? (?:are )?due|no later than|offer due)\b/i],
  ["location", /\b(place of performance|performance location|work ?site|services? (?:will|shall) be (?:performed|provided) at|location of (?:work|services)|conus|oconus)\b/i],
  ["pricing", /\b(price schedule|pricing|clin\b|unit price|bid schedule|cost proposal|estimated quantit)\b/i],
  ["evaluation", /\b(evaluation (?:criteria|factors)|basis (?:for|of) award|best value|lowest price technically acceptable|lpta)\b/i],
  ["scope", /\b(scope of (?:work|services)|statement of (?:work|objectives)|performance work statement|\bpws\b|\bsow\b|requirements?|the contractor shall|services? (?:required|to be provided)|tasks?)\b/i],
];

export function classifySection(heading: string | null, text: string): SectionKind {
  const probe = `${heading ?? ""}\n${text.slice(0, 1_500)}`;
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (heading && pattern.test(heading)) return kind;
  }
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(probe)) return kind;
  }
  return "general";
}

function isHeading(line: string): boolean {
  const value = line.trim();
  if (value.length < 4 || value.length > 100) return false;
  if (/[.;,]$/.test(value) && !/^\d/.test(value)) return false;
  if (value === value.toUpperCase() && /[A-Z]{4,}/.test(value) && value.split(/\s+/).length <= 12) return true;
  return HEADING.test(value) && value.split(/\s+/).length <= 12;
}

interface Line {
  text: string;
  page: number;
}

interface Draft {
  heading: string | null;
  lines: Line[];
}

export function buildSections(pages: ExtractedPage[]): DocumentSection[] {
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (const page of pages) {
    if (!page.text.trim()) continue;
    for (const raw of page.text.split(/\n/)) {
      const line = raw.trim();
      if (!line) {
        current?.lines.push({ text: "", page: page.page });
        continue;
      }
      if (isHeading(line)) {
        if (current && current.lines.some((entry) => entry.text)) drafts.push(current);
        current = { heading: line.slice(0, 160), lines: [{ text: "", page: page.page }] };
        continue;
      }
      if (!current) current = { heading: null, lines: [] };
      current.lines.push({ text: line, page: page.page });
    }
  }
  if (current && current.lines.some((entry) => entry.text)) drafts.push(current);

  const sections: DocumentSection[] = [];
  for (const draft of drafts) {
    const parts = splitLong(draft.lines);
    parts.forEach((part, index) => {
      // A section that crosses a page break carries "[page N]" markers so a requirement inside it is cited to the
      // page it is actually on, not the section's first page.
      const rendered: string[] = [];
      let lastPage: number | null = null;
      for (const entry of part) {
        if (entry.text && lastPage !== null && entry.page !== lastPage) rendered.push(`${PAGE_MARKER_PREFIX}${entry.page}]`);
        if (entry.text) lastPage = entry.page;
        rendered.push(entry.text);
      }
      const text = rendered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (!text) return;
      const pagesWithText = part.filter((entry) => entry.text).map((entry) => entry.page);
      sections.push({
        ordinal: sections.length,
        pageStart: pagesWithText.length ? Math.min(...pagesWithText) : null,
        pageEnd: pagesWithText.length ? Math.max(...pagesWithText) : null,
        heading: parts.length > 1 ? `${draft.heading ?? "Untitled section"} (part ${index + 1}/${parts.length})` : draft.heading,
        kind: classifySection(draft.heading, text),
        text,
      });
    });
  }
  return sections;
}

/** Splits a long section on blank lines (paragraphs) so each part stays under MAX_SECTION_CHARS. */
function splitLong(lines: Line[]): Line[][] {
  const out: Line[][] = [];
  let buffer: Line[] = [];
  let size = 0;
  for (const line of lines) {
    const length = line.text.length + 1;
    if (size + length > MAX_SECTION_CHARS && buffer.length) {
      // Prefer to cut at the last paragraph break in the buffer.
      let cut = buffer.length;
      for (let i = buffer.length - 1; i > buffer.length / 2; i -= 1) {
        if (!buffer[i]!.text) {
          cut = i;
          break;
        }
      }
      out.push(buffer.slice(0, cut));
      buffer = buffer.slice(cut);
      size = buffer.reduce((sum, entry) => sum + entry.text.length + 1, 0);
    }
    if (length > MAX_SECTION_CHARS) {
      for (let i = 0; i < line.text.length; i += MAX_SECTION_CHARS) {
        out.push([{ text: line.text.slice(i, i + MAX_SECTION_CHARS), page: line.page }]);
      }
      continue;
    }
    buffer.push(line);
    size += length;
  }
  if (buffer.length) out.push(buffer);
  return out;
}
