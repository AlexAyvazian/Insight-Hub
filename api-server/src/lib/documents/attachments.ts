/**
 * Finds the official documents behind an opportunity record: SAM.gov resource links and description endpoint,
 * attachment arrays that other adapters keep in rawData, document links inside the notice HTML/description, and
 * the notice page itself for non-SAM sources. Only http(s) URLs that pass the synchronous SSRF pre-check are
 * returned; the worker re-validates every URL (with DNS) before fetching.
 */
import type { NormalizedOpportunity } from "../providers/types";
import { isObviouslyUnsafeUrl } from "../security/safeUrl";
import type { AttachmentRef, DocumentRole } from "./types";

const DOCUMENT_LINK = /\.(pdf|docx?|xlsx?|txt|rtf|zip)(?:$|[?#])|\/(?:download|attachment|attachments|files?|documents?|resources)\//i;
// Registration cap per notice. Attachments beyond it are counted (never silently dropped) and their URLs still
// count as listed, so they are not mistaken for withdrawn ones; the document set is reported incomplete.
export const MAX_ATTACHMENTS = Math.max(10, Number(process.env.DOCUMENT_MAX_ATTACHMENTS ?? 120) || 120);

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function roleFor(url: string, title: string | null): DocumentRole {
  const probe = `${title ?? ""} ${safeDecode(url.split("?")[0] ?? "")}`.toLowerCase();
  if (/amend|modif|addend|\bmod\s?\d/.test(probe)) return "amendment";
  if (/\bsow\b|statement of work|\bpws\b|performance work|scope of (?:work|services)|statement of objectives/.test(probe)) return "sow";
  if (/q\s?&\s?a|questions|answers|clarification/.test(probe)) return "qa";
  if (/pric|bid schedule|clin|cost/.test(probe)) return "pricing";
  return "attachment";
}

interface Collector {
  out: AttachmentRef[];
  seen: Set<string>;
  overflow: string[];
}

function pushUnique(collector: Collector, url: string | undefined | null, title: string | null, extra: Partial<AttachmentRef> = {}) {
  const { out, seen } = collector;
  if (!url || typeof url !== "string") return;
  let normalized: string;
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    normalized = parsed.toString();
  } catch {
    return;
  }
  if (isObviouslyUnsafeUrl(normalized) || seen.has(normalized)) return;
  seen.add(normalized);
  if (out.length >= MAX_ATTACHMENTS) {
    collector.overflow.push(normalized);
    return;
  }
  out.push({ url: normalized, title, role: extra.role ?? roleFor(normalized, title), sourceVersion: extra.sourceVersion ?? null, amendedAt: extra.amendedAt ?? null });
}

function linksIn(text: string): Array<{ url: string; title: string | null }> {
  const links: Array<{ url: string; title: string | null }> = [];
  for (const match of text.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({ url: match[1]!, title: match[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || null });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) links.push({ url: match[0]!, title: null });
  return links;
}

/** Relative links (e.g. "/documents/spec.pdf") are resolved against the notice page; absolute ones pass through. */
function absoluteUrl(url: string | undefined | null, base: string | null): string | undefined {
  if (!url || typeof url !== "string") return undefined;
  try {
    return new URL(url.trim(), base ?? undefined).toString();
  } catch {
    return undefined;
  }
}

const ATTACHMENT_LIST_KEYS = ["resourceLinks", "attachments", "documents", "files", "bidDocuments", "solicitationDocuments"];

/** True when the record carries an explicit attachment list, so attachments missing from it were withdrawn. */
export function hasAuthoritativeAttachmentList(record: NormalizedOpportunity): boolean {
  const raw = (record.rawData ?? {}) as Record<string, unknown>;
  return ATTACHMENT_LIST_KEYS.some((key) => Array.isArray(raw[key]));
}

export function discoverAttachments(record: NormalizedOpportunity): AttachmentRef[] {
  return discoverAttachmentsWithCoverage(record).attachments;
}

export interface AttachmentDiscovery {
  attachments: AttachmentRef[];
  /** Every listed URL, registered or not; withdrawal checks compare against this, never the capped list. */
  listedUrls: string[];
  /** Listed attachments over the registration cap. */
  overflow: number;
}

export function discoverAttachmentsWithCoverage(record: NormalizedOpportunity): AttachmentDiscovery {
  const base = record.sourceUrl && /^https?:\/\//i.test(record.sourceUrl) ? record.sourceUrl : null;
  const collector: Collector = { out: [], seen: new Set<string>(), overflow: [] };
  const raw = (record.rawData ?? {}) as Record<string, unknown>;
  const modified = typeof raw.modifiedDate === "string" ? raw.modifiedDate : typeof raw.postedDate === "string" ? raw.postedDate : null;

  // SAM.gov: the full description lives behind the noticedesc link and attachments behind resourceLinks.
  if (typeof raw.samDescriptionUrl === "string") {
    pushUnique(collector, raw.samDescriptionUrl, "SAM.gov notice description", { role: "notice", sourceVersion: modified });
  } else if (typeof raw.description === "string" && /^https:\/\/api\.sam\.gov\//i.test(raw.description)) {
    pushUnique(collector, raw.description, "SAM.gov notice description", { role: "notice", sourceVersion: modified });
  }
  if (Array.isArray(raw.resourceLinks)) {
    raw.resourceLinks.forEach((link, index) => {
      if (typeof link === "string") pushUnique(collector, link, `SAM.gov attachment ${index + 1}`, { sourceVersion: modified });
    });
  }

  // Generic attachment arrays kept by portal adapters.
  for (const key of ["attachments", "documents", "files", "bidDocuments", "solicitationDocuments"]) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") pushUnique(collector, absoluteUrl(item, base), null);
      else if (item && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        const url = [entry.url, entry.href, entry.link, entry.downloadUrl, entry.fileUrl].find((v) => typeof v === "string") as string | undefined;
        const title = [entry.name, entry.title, entry.fileName, entry.filename].find((v) => typeof v === "string") as string | undefined;
        pushUnique(collector, absoluteUrl(url, base), title ?? null);
      }
    }
  }

  // Document links mentioned in the description or stored notice HTML.
  for (const text of [record.description ?? "", typeof raw.html === "string" ? raw.html : ""]) {
    for (const link of linksIn(text)) {
      if (DOCUMENT_LINK.test(link.url)) pushUnique(collector, absoluteUrl(link.url, base), link.title);
    }
  }

  // The notice page itself (SAM.gov view pages are client-rendered and carry no text, so they are skipped).
  if (record.sourceUrl && !isSamViewPage(record.sourceUrl)) {
    pushUnique(collector, record.sourceUrl, record.title ?? "Notice page", { role: "notice" });
  }
  return {
    attachments: collector.out,
    listedUrls: [...collector.out.map((a) => a.url), ...collector.overflow],
    overflow: collector.overflow.length,
  };
}

function isSamViewPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)sam\.gov$/i.test(parsed.hostname) && parsed.pathname.toLowerCase().startsWith("/opp/");
  } catch {
    return false;
  }
}

/** Hosts that need the SAM.gov API key appended (official API endpoints only). */
export function needsSamApiKey(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    // SAM.gov API endpoints, including resource downloads served from sam.gov/api/...
    return host === "api.sam.gov" || ((host === "sam.gov" || host.endsWith(".sam.gov")) && parsed.pathname.toLowerCase().startsWith("/api/"));
  } catch {
    return false;
  }
}
