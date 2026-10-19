/**
 * Evidence drawn from the whole document corpus of an opportunity, not its first few thousand characters.
 *
 * Every stored section (all documents, all pages) is cut into overlapping windows, each window is scored for what a
 * qualification decision needs (purchased services, exclusions, eligibility restrictions, superseding amendments,
 * place and term), and the best windows fill the evidence budget. The chosen passages keep their citation (document,
 * page range, section id) and are presented in document order. Exclusions, eligibility restrictions and superseding
 * statements are also collected across the WHOLE corpus, whether or not they fit in the excerpt budget, so a
 * restriction on page 140 of a 200-page solicitation is still seen.
 */
import { profileLeadPhrases } from "../search/profileWebQueries";
import type { EvidenceSection } from "./requirements";

const WINDOW_CHARS = 1_400;
const WINDOW_OVERLAP = 200;

export interface Passage {
  sectionId: string | null;
  documentId: string | null;
  documentTitle: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  heading: string | null;
  kind: EvidenceSection["kind"];
  text: string;
  /** Offset of the passage inside its section (for reproducibility and citation checks). */
  offset: number;
  score: number;
  signals: string[];
}

export interface CorpusFinding {
  statement: string;
  citation: string;
  sectionId: string | null;
}

export interface CorpusEvidence {
  text: string;
  citations: string[];
  passages: Array<Pick<Passage, "sectionId" | "documentId" | "pageStart" | "pageEnd" | "offset" | "score" | "signals">>;
  /** Every section was read; this says how much of it the excerpt could carry. */
  coverage: { sections: number; documents: number; chars: number; windows: number; selected: number; excerptChars: number };
  exclusions: CorpusFinding[];
  eligibility: CorpusFinding[];
  superseding: CorpusFinding[];
}

const KIND_WEIGHT: Record<EvidenceSection["kind"], number> = {
  amendment: 6,
  scope: 5,
  exclusion: 5,
  qualification: 4,
  location: 2,
  evaluation: 1.5,
  deadline: 1.5,
  pricing: 1,
  general: 0,
};

export const EXCLUSION_PATTERN =
  /\b(not (?:be )?(?:included|required|part of|within)|excluded|exclusions?|out of scope|outside (?:the )?scope|shall not (?:provide|perform|include)|will not be (?:required|provided|performed))\b/i;
export const ELIGIBILITY_PATTERN =
  /\b(set[- ]aside|small business(?:es)? only|8\(a\)|sdvosb|service[- ]disabled veteran|hubzone|wosb|women[- ]owned|edwosb|local (?:vendor|business|bidder)s? (?:only|preference)|(?:must|shall) be (?:located|headquartered|based) (?:in|within)|licensed (?:to practice )?in the (?:state|commonwealth) of|(?:must|shall) (?:hold|possess|maintain) (?:a |an )?(?:valid |current )?(?:state )?licen[cs]e|only (?:vendors|offerors|bidders|firms) (?:that|who|registered)|registered (?:vendor|supplier) (?:in|with)|pre-?qualified (?:vendors|bidders)|minority[- ]owned|disadvantaged business enterprise|\bdbe\b|\bmbe\b|\bwbe\b)\b/i;
export const SUPERSEDING_PATTERN =
  /\b(supersed(?:es|ed|ing)|replac(?:es|ed) (?:in (?:its|their) entirety|the (?:original|previous|prior))|is (?:hereby )?(?:deleted|removed|revised|amended|cancel+ed|withdrawn|rescinded)|are (?:hereby )?(?:deleted|removed|revised|amended)|no longer (?:required|needed|included|part of)|(?:solicitation|requirement|notice) (?:has been|is) cancel+ed|(?:closing|due|response) date (?:is|has been) (?:extended|changed|revised))\b/i;
const PLACE_TERM = /\b(place of performance|period of performance|on[- ]site|mobile (?:unit|clinic)|base year|option year|contract term)\b/i;

function serviceTerms(): string[] {
  try {
    return profileLeadPhrases(undefined, 40)
      .map((phrase) => phrase.toLowerCase().trim())
      .filter((phrase) => phrase.length >= 4);
  } catch {
    return [];
  }
}

export function citationFor(section: Pick<EvidenceSection, "documentTitle" | "pageStart" | "pageEnd" | "heading">): string {
  const pages = section.pageStart != null ? `, p.${section.pageStart}${section.pageEnd && section.pageEnd !== section.pageStart ? `-${section.pageEnd}` : ""}` : "";
  return `[${section.documentTitle ?? "document"}${pages}${section.heading ? `, ${section.heading.slice(0, 60)}` : ""}]`;
}

function windows(section: EvidenceSection): Array<{ text: string; offset: number }> {
  const text = section.text;
  if (text.length <= WINDOW_CHARS) return [{ text, offset: 0 }];
  const out: Array<{ text: string; offset: number }> = [];
  for (let offset = 0; offset < text.length; offset += WINDOW_CHARS - WINDOW_OVERLAP) {
    out.push({ text: text.slice(offset, offset + WINDOW_CHARS), offset });
    if (offset + WINDOW_CHARS >= text.length) break;
  }
  return out;
}

function statementsOf(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.:])\s+(?=[A-Z(\[])|(?<=;)\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 20 && s.length <= 1_200);
}

function scoreWindow(text: string, kind: EvidenceSection["kind"], terms: string[]): { score: number; signals: string[] } {
  const lower = text.toLowerCase();
  const signals: string[] = [];
  let score = KIND_WEIGHT[kind] ?? 0;
  let termHits = 0;
  for (const term of terms) if (lower.includes(term)) termHits += 1;
  if (termHits > 0) {
    signals.push(`service_terms:${termHits}`);
    score += Math.min(12, termHits * 3);
  }
  if (EXCLUSION_PATTERN.test(text)) {
    signals.push("exclusion");
    score += 4;
  }
  if (ELIGIBILITY_PATTERN.test(text)) {
    signals.push("eligibility");
    score += 4;
  }
  if (SUPERSEDING_PATTERN.test(text)) {
    signals.push("superseding");
    score += 5;
  }
  if (PLACE_TERM.test(text)) {
    signals.push("place_or_term");
    score += 1.5;
  }
  return { score, signals };
}

/**
 * Cited evidence from every section, ranked for the decision and bounded by `maxChars`. Deterministic: ties keep
 * document/section order.
 */
export function corpusEvidence(sections: EvidenceSection[], maxChars = 12_000, terms: string[] = serviceTerms()): CorpusEvidence {
  const candidates: Passage[] = [];
  const exclusions: CorpusFinding[] = [];
  const eligibility: CorpusFinding[] = [];
  const superseding: CorpusFinding[] = [];
  const seenStatements = new Set<string>();
  let chars = 0;
  let order = 0;
  const position = new Map<Passage, number>();
  for (const section of sections) {
    chars += section.text.length;
    const cite = citationFor(section);
    for (const window of windows(section)) {
      const { score, signals } = scoreWindow(window.text, section.kind, terms);
      const passage: Passage = {
        sectionId: section.id,
        documentId: section.documentId,
        documentTitle: section.documentTitle,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        heading: section.heading,
        kind: section.kind,
        text: window.text,
        offset: window.offset,
        score,
        signals,
      };
      position.set(passage, order++);
      candidates.push(passage);
    }
    for (const statement of statementsOf(section.text)) {
      const key = statement.toLowerCase();
      if (seenStatements.has(key)) continue;
      const finding = { statement: statement.slice(0, 400), citation: cite, sectionId: section.id };
      let used = false;
      if (EXCLUSION_PATTERN.test(statement) && exclusions.length < 40) (exclusions.push(finding), (used = true));
      if (ELIGIBILITY_PATTERN.test(statement) && eligibility.length < 40) (eligibility.push(finding), (used = true));
      if (SUPERSEDING_PATTERN.test(statement) && superseding.length < 40) (superseding.push(finding), (used = true));
      if (used) seenStatements.add(key);
    }
  }

  const ranked = [...candidates].sort((a, b) => b.score - a.score || position.get(a)! - position.get(b)!);
  const chosen: Passage[] = [];
  let used = 0;
  for (const passage of ranked) {
    const cite = citationFor(passage);
    const cost = cite.length + passage.text.length + 2;
    if (used + cost > maxChars) {
      const room = maxChars - used - cite.length - 2;
      if (room >= 300 && passage.score > 0) {
        chosen.push({ ...passage, text: passage.text.slice(0, room) });
        position.set(chosen[chosen.length - 1]!, position.get(passage)!);
        used += cite.length + room + 2;
      }
      continue;
    }
    chosen.push(passage);
    used += cost;
    if (used >= maxChars - 300) break;
  }
  chosen.sort((a, b) => position.get(a)! - position.get(b)!);
  const parts = chosen.map((passage) => `${citationFor(passage)} ${passage.text}`);
  return {
    text: parts.join("\n\n"),
    citations: chosen.map((passage) => citationFor(passage)),
    passages: chosen.map(({ sectionId, documentId, pageStart, pageEnd, offset, score, signals }) => ({ sectionId, documentId, pageStart, pageEnd, offset, score, signals })),
    coverage: {
      sections: sections.length,
      documents: new Set(sections.map((section) => section.documentId)).size,
      chars,
      windows: candidates.length,
      selected: chosen.length,
      excerptChars: used,
    },
    exclusions,
    eligibility,
    superseding,
  };
}
