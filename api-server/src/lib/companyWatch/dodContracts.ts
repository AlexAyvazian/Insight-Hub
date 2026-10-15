/**
 * Department of War (Defense) daily contract announcements: the official, free, same-day notice of every DoD
 * contract action valued at $7.5 million or more (https://www.war.gov/News/Contracts/).
 *
 * The RSS feed lists the daily announcement pages; each page is a series of paragraphs, one per contract action,
 * that start with the recipient ("Leidos Inc., Reston, Virginia, was awarded a $..."). Parsing is pure and tested;
 * fetching is separate so the pass can log exactly which step failed on the deployed service.
 */
import { createHash } from "node:crypto";
import { contractNumberKey, locationCountry, type OfficialAward } from "./officialAward";

export const DOD_CONTRACTS_RSS = "https://www.war.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=400&Site=945&max=15";

export interface FeedItem {
  title: string;
  link: string;
  pubDate: string | null;
  /** Decoded description HTML (some feeds carry the full announcement). */
  description: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "..." };

export function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

function tag(block: string, name: string): string {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return match ? decodeEntities(match[1]!.trim()) : "";
}

export function parseContractsRss(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const match of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = match[0];
    const link = tag(block, "link") || tag(block, "guid");
    if (!/^https?:\/\//i.test(link)) continue;
    items.push({ title: tag(block, "title"), link, pubDate: tag(block, "pubDate") || null, description: decodeEntities(tag(block, "description")) });
  }
  return items;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Contracts For Oct. 14, 2026" -> 2026-10-14; falls back to the RSS pubDate. */
export function announcementDate(title: string, pubDate: string | null): string | null {
  const match = /([A-Z][a-z]{2,8})\.?\s+(\d{1,2}),\s+(\d{4})/.exec(title);
  if (match) {
    const month = MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase());
    if (month >= 0) return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
  }
  const parsed = pubDate ? Date.parse(pubDate) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

/** Text blocks of an HTML document: <p>, <h1-6>, <div> leaves; tags stripped, whitespace collapsed. */
export function htmlBlocks(html: string): string[] {
  const cleaned = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ");
  const blocks: string[] = [];
  for (const match of cleaned.matchAll(/<(p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = decodeEntities(match[2]!.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) blocks.push(text);
  }
  return blocks;
}

const AWARD_VERB = /\b(?:(?:is|was|were|are|has|have)\s+(?:each\s+)?(?:been\s+)?(?:being\s+)?awarded|will\s+(?:each\s+)?(?:share|compete)|has\s+been\s+selected|have\s+been\s+selected)\b/i;
const MODIFICATION = /\b(?:modification|modifies|modified|P\d{5}|exercis(?:e|ed|ing)\s+(?:an?\s+|the\s+)?options?|option\s+(?:year|period)|undefinitized|increase[sd]?\s+(?:the\s+)?(?:ceiling|value))\b/i;
const CONTRACT_NO = /\b([A-Z][A-Z0-9]{5})-?(\d{2})-?([A-Z])-?([A-Z0-9]{4})\b/;
const MOD_NO = /\b([PA]\d{5})\b/;

export function parseAmount(text: string): number | null {
  const match = /\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)?/i.exec(text);
  if (!match) return null;
  const base = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const scale = match[2]?.toLowerCase() === "billion" ? 1e9 : match[2]?.toLowerCase() === "million" ? 1e6 : 1;
  return Math.round(base * scale);
}

/** Recipient text of a paragraph: everything before the award verb, or the list after "The following ...:". */
export function recipientSpan(paragraph: string): string | null {
  const verb = AWARD_VERB.exec(paragraph);
  if (!verb) return null;
  const before = paragraph.slice(0, verb.index).replace(/[,\s]+$/, "").trim();
  if (/^(?:the following|\w+\s+(?:companies|firms|contractors|vendors|awardees)|each of the following)\b/i.test(before) || before.length < 3) {
    const colon = paragraph.indexOf(":", verb.index);
    if (colon < 0) return null;
    const rest = paragraph.slice(colon + 1);
    const end = rest.search(/\.\s+(?=(?:Work|Each|This|The|Fiscal|Funds|Funding|Bids|Proposals|All)\b)/);
    return (end >= 0 ? rest.slice(0, end) : rest).trim() || null;
  }
  return before;
}

function firstMatch(re: RegExp, text: string): string | null {
  const match = re.exec(text);
  return match ? match[1]!.replace(/\s+/g, " ").trim() : null;
}

export function parseAnnouncement(html: string, sourceUrl: string, date: string | null): OfficialAward[] {
  const awards: OfficialAward[] = [];
  let section: string | null = null;
  for (const block of htmlBlocks(html)) {
    if (block.length <= 80 && block === block.toUpperCase() && /[A-Z]/.test(block) && !/\$/.test(block)) {
      section = block.replace(/\s+/g, " ").trim();
      continue;
    }
    if (block.length < 80 || !/\$\s?\d/.test(block)) continue;
    const span = recipientSpan(block);
    if (!span) continue;
    const contract = CONTRACT_NO.exec(block);
    const contractNumber = contract ? `${contract[1]}-${contract[2]}-${contract[3]}-${contract[4]}` : null;
    const modNumber = firstMatch(MOD_NO, block);
    const modification = MODIFICATION.test(block) ? true : /\bcontract\b/i.test(block) ? false : null;
    const amount = parseAmount(block);
    const workLocation = firstMatch(/Work will be performed (?:at|in)\s+(.+?)(?:,?\s+(?:with an?|and is expected|and will be completed|with work expected)|\.\s|\.$)/i, block);
    const activity = firstMatch(/(?:^|\.\s+)([A-Z][^.;]{3,200}?),?\s+(?:is|are) the contracting (?:activity|activities)/i, block);
    const completionDate = firstMatch(/(?:expected to be completed|estimated completion date of|completion date of|be completed by|will be complete by)\s+(?:in\s+|by\s+|on\s+)?([A-Z][a-z]+\.?\s+(?:\d{1,2},\s+)?\d{4})/i, block);
    const key = contractNumberKey(contractNumber);
    const awardKey = key
      ? `dod:${key}:${modNumber ?? (modification ? "mod" : "base")}:${date ?? "nodate"}:${amount ?? "na"}`
      : `dod:${createHash("sha1").update(`${sourceUrl}\u0000${block}`).digest("hex").slice(0, 20)}`;
    awards.push({
      awardKey,
      source: "dod_contract_announcement",
      recipientText: span.slice(0, 1500),
      recipientUei: null,
      awardingAgency: [section, activity].filter(Boolean).join(" — ") || null,
      amount,
      contractNumber,
      modification,
      actionDate: date,
      workLocation,
      popCountry: locationCountry(workLocation),
      description: block.slice(0, 3000),
      sourceUrl,
      completionDate,
    });
  }
  return awards;
}

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; InsightHub/1.0; +https://insight-hub-952b.onrender.com)",
  Accept: "text/html,application/xhtml+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
};

export async function fetchText(url: string, timeoutMs = 25_000, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetchImpl(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  const text = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, text };
}
