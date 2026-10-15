/**
 * Live US bid/solicitation rows from official Socrata open-data portals (SODA API). Unlike the Socrata catalog
 * search, which only finds dataset pages, these read the actual open solicitations:
 *   - NYC City Record Online (dg92-zbpx): every NYC agency procurement solicitation, with due dates and contacts
 *   - City of Los Angeles RAMP open bid opportunities (hf3r-utnq): City of LA, LAUSD and partner agencies
 *   - Montgomery County, MD solicitations (eeq6-nnwe)
 *   - State of Delaware open bids (2hnj-zwix): state agencies, school districts and colleges
 *
 * No key is required. SOCRATA_APP_TOKEN, when set, is sent as X-App-Token for a higher rate limit. Every record goes
 * through the same Neon-profile relevance gate as TED, and closed, cancelled or expired bids are dropped.
 */
import { createHash } from "crypto";

import type { FetchOptions, NormalizedOpportunity, ProviderFetchResult } from "./types";
import { classifyResult } from "../search/relevance";
import { decideRelevance } from "../search/relevanceDecision";

const NYC_URL = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const LA_RAMP_URL = "https://data.lacity.org/resource/hf3r-utnq.json";
const MONTGOMERY_URL = "https://data.montgomerycountymd.gov/resource/eeq6-nnwe.json";
const DELAWARE_URL = "https://data.delaware.gov/resource/2hnj-zwix.json";
const ROW_LIMIT = 1000;
const UNKNOWN_POSTED_DATE = new Date(0);

type Row = Record<string, unknown>;
export type UsOpenDataSource = "nycCityRecord" | "laRamp" | "montgomeryCountyMd" | "delawareMarketplace";

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(value: unknown): Date | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** SoQL floating-timestamp literal for "now". */
function soqlNow(): string {
  return new Date().toISOString().slice(0, 19);
}

function externalIdFor(prefix: string, seed: string): string {
  return `${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 20)}`;
}

function relevant(title: string, description: string | undefined, url: string): boolean {
  const classification = classifyResult({ title, snippet: description ?? "", url, allowHistorical: false });
  if (classification.matchedServiceCategories.length === 0) return false;
  return decideRelevance(classification).verdict !== "reject";
}

function baseRecord(
  source: UsOpenDataSource,
  portalName: string,
  geography: string,
): Pick<NormalizedOpportunity, "source" | "providerName"> & { rawData: Record<string, unknown> } {
  return {
    source: "internationalPublicPortals",
    providerName: "internationalPublicPortals",
    rawData: {
      providerName: "internationalPublicPortals",
      providerFamily: "us_open_data_procurement",
      internationalSource: source,
      portalName,
      geography,
      country: "US",
      directOfficialApi: true,
      authenticationRequired: false,
      evidenceType: "direct-structured",
      buyerProvenance: "official_structured",
      statusProvenance: "official_structured",
    },
  };
}

export function nycNoticeToOpportunity(row: Row): NormalizedOpportunity | null {
  const requestId = text(row.request_id);
  const title = text(row.short_title);
  if (!requestId || !title) return null;
  if (!/solicitation/i.test(text(row.type_of_notice_description) ?? "")) return null;
  const deadline = parseDate(row.due_date);
  if (deadline && deadline.getTime() < Date.now()) return null;

  const description = [
    text(row.additional_description_1) ? stripHtml(text(row.additional_description_1)!) : undefined,
    text(row.additional_description_2) ? stripHtml(text(row.additional_description_2)!) : undefined,
    text(row.category_description) ? `Category: ${text(row.category_description)}` : undefined,
    text(row.selection_method_description) ? `Method: ${text(row.selection_method_description)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 6000);
  const sourceUrl = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(requestId)}`;
  if (!relevant(title, description, sourceUrl)) return null;

  const base = baseRecord("nycCityRecord", "NYC City Record Online", "New York City, NY");
  return {
    ...base,
    externalId: externalIdFor("nyc-cr", requestId),
    title,
    agency: text(row.agency_name) ?? "City of New York",
    type: text(row.selection_method_description) ?? "Solicitation",
    status: "active",
    postedDate: parseDate(row.start_date) ?? UNKNOWN_POSTED_DATE,
    responseDeadline: deadline,
    description: description || undefined,
    location: "New York, NY",
    placeOfPerformance: "New York, NY",
    sourceUrl,
    solicitationNumber: text(row.pin) ?? requestId,
    rawData: {
      ...base.rawData,
      sourceConfidence: "high",
      deadlineProvenance: deadline ? "official_structured" : "unknown",
      descriptionProvenance: description ? "official_structured" : "unknown",
      contactName: text(row.contact_name),
      contactEmail: text(row.email),
      contactPhone: text(row.contact_phone),
      requestAddress: text(row.address_to_request),
      category: text(row.category_description),
    },
  };
}

export function laRampToOpportunity(row: Row): NormalizedOpportunity | null {
  const rampId = text(row.rampid);
  const title = text(row.title);
  if (!rampId || !title) return null;
  if (/cancel/i.test(title)) return null;
  if (/^(closed|awarded|cancel)/i.test(text(row.stagename) ?? "")) return null;
  const deadline = parseDate(row.closedate);
  // RAMP rows without a close date are not actionable; practice rows close in 2037.
  if (!deadline || deadline.getTime() < Date.now()) return null;
  if (deadline.getUTCFullYear() >= 2035) return null;

  const link = row.url && typeof row.url === "object" ? text((row.url as Row).url) : text(row.url);
  const sourceUrl = link ?? `https://www.rampla.org/s/opportunity-details?rampid=${encodeURIComponent(rampId)}`;
  const description = [text(row.category) ? `Category: ${text(row.category)}` : undefined, text(row.type)]
    .filter(Boolean)
    .join("\n");
  if (!relevant(title, description, sourceUrl)) return null;

  const base = baseRecord("laRamp", "Regional Alliance Marketplace for Procurement (RAMP, Los Angeles)", "Los Angeles, CA");
  return {
    ...base,
    externalId: externalIdFor("la-ramp", rampId),
    title,
    agency: text(row.department) ?? "City of Los Angeles",
    type: text(row.type) ?? "Solicitation",
    status: "active",
    postedDate: parseDate(row.bidpost) ?? UNKNOWN_POSTED_DATE,
    responseDeadline: deadline,
    description: description || undefined,
    location: "Los Angeles, CA",
    placeOfPerformance: "Los Angeles, CA",
    sourceUrl,
    solicitationNumber: rampId,
    rawData: {
      ...base.rawData,
      sourceConfidence: "high",
      deadlineProvenance: "official_structured",
      descriptionProvenance: description ? "official_structured" : "unknown",
      category: text(row.category),
      stage: text(row.stagename),
    },
  };
}

export function montgomeryToOpportunity(row: Row): NormalizedOpportunity | null {
  const number = text(row.number);
  const title = text(row.description);
  if (!number || !title) return null;
  if (!/^active$/i.test(text(row.status) ?? "")) return null;
  if (/^(y|yes|true)$/i.test(text(row.cancelledpostponed) ?? "")) return null;
  const deadline = parseDate(row.closingdate);
  if (deadline && deadline.getTime() < Date.now()) return null;

  const sourceUrl = `https://data.montgomerycountymd.gov/d/eeq6-nnwe?number=${encodeURIComponent(number)}`;
  const description = [text(row.type) ? `Solicitation type: ${text(row.type)}` : undefined]
    .filter(Boolean)
    .join("\n");
  if (!relevant(title, description, sourceUrl)) return null;

  const base = baseRecord("montgomeryCountyMd", "Montgomery County, MD Solicitations", "Montgomery County, MD");
  return {
    ...base,
    externalId: externalIdFor("mc-md", number),
    title,
    agency: text(row.department) ? `Montgomery County, MD - ${text(row.department)}` : "Montgomery County, MD",
    type: text(row.type) ?? "Solicitation",
    status: "active",
    postedDate: parseDate(row.issuancedate) ?? UNKNOWN_POSTED_DATE,
    responseDeadline: deadline,
    description: description || undefined,
    location: "Montgomery County, MD",
    placeOfPerformance: "Montgomery County, MD",
    sourceUrl,
    solicitationNumber: number,
    rawData: {
      ...base.rawData,
      // The dataset has no per-bid web page, so the link opens the dataset itself.
      sourceConfidence: "medium",
      deadlineProvenance: deadline ? "official_structured" : "unknown",
      descriptionProvenance: "official_structured",
      contactName: text(row.deptcontact),
    },
  };
}

export function delawareBidToOpportunity(row: Row): NormalizedOpportunity | null {
  const number = text(row.contractnumber);
  const title = text(row.contracttitle);
  if (!number || !title) return null;
  const deadline = parseDate(row.deadlinedate);
  if (!deadline || deadline.getTime() < Date.now()) return null;

  const link = row.bidurl && typeof row.bidurl === "object" ? text((row.bidurl as Row).url) : text(row.bidurl);
  const sourceUrl = link ?? `https://mmp.delaware.gov/Bids?number=${encodeURIComponent(number)}`;
  const unspsc = text(row.unspsc);
  const description = unspsc ? `UNSPSC segment/family: ${unspsc}` : undefined;
  if (!relevant(title, description, sourceUrl)) return null;

  const agencyCode = text(row.agencycode);
  const base = baseRecord("delawareMarketplace", "Delaware Bids (Marketplace)", "Delaware");
  return {
    ...base,
    externalId: externalIdFor("de-mmp", number),
    title,
    agency: agencyCode ? `State of Delaware (${agencyCode})` : "State of Delaware",
    type: "Solicitation",
    status: "active",
    postedDate: parseDate(row.opendate) ?? UNKNOWN_POSTED_DATE,
    responseDeadline: deadline,
    description,
    location: "Delaware",
    placeOfPerformance: "Delaware",
    sourceUrl,
    solicitationNumber: number,
    rawData: {
      ...base.rawData,
      sourceConfidence: "high",
      deadlineProvenance: "official_structured",
      descriptionProvenance: description ? "official_structured" : "unknown",
      agencyCode,
      unspsc,
    },
  };
}

async function fetchRows(baseUrl: string, where: string, order: string, signal?: AbortSignal): Promise<Row[]> {
  const params = new URLSearchParams({ $where: where, $order: order, $limit: String(ROW_LIMIT) });
  const headers: Record<string, string> = { accept: "application/json" };
  const appToken = process.env.SOCRATA_APP_TOKEN?.trim();
  if (appToken) headers["X-App-Token"] = appToken;
  const response = await fetch(`${baseUrl}?${params.toString()}`, { headers, signal });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Socrata SODA ${response.status}: ${body.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  const json = (await response.json()) as unknown;
  return Array.isArray(json) ? (json.filter((entry) => entry && typeof entry === "object") as Row[]) : [];
}

async function fetchSource(
  source: UsOpenDataSource,
  url: string,
  where: string,
  order: string,
  map: (row: Row) => NormalizedOpportunity | null,
  options: FetchOptions,
): Promise<ProviderFetchResult> {
  const rows = await fetchRows(url, where, order, options.signal);
  const records = rows.map(map).filter((record): record is NormalizedOpportunity => record != null);
  return {
    records,
    total: records.length,
    errors: [],
    diagnostics: {
      internationalSource: source,
      mode: "official-soda-api",
      apiAnonymous: !process.env.SOCRATA_APP_TOKEN,
      candidates: rows.length,
      accepted: records.length,
    },
  };
}

export const fetchNycCityRecord = (options: FetchOptions) =>
  fetchSource(
    "nycCityRecord",
    NYC_URL,
    `section_name='Procurement' AND type_of_notice_description='Solicitation' AND due_date > '${soqlNow()}'`,
    "start_date DESC",
    nycNoticeToOpportunity,
    options,
  );

export const fetchLaRamp = (options: FetchOptions) =>
  fetchSource("laRamp", LA_RAMP_URL, `closedate > '${soqlNow()}'`, "bidpost DESC", laRampToOpportunity, options);

export const fetchMontgomeryCounty = (options: FetchOptions) =>
  fetchSource(
    "montgomeryCountyMd",
    MONTGOMERY_URL,
    `status='Active' AND closingdate > '${soqlNow()}'`,
    "issuancedate DESC",
    montgomeryToOpportunity,
    options,
  );

export const fetchDelawareBids = (options: FetchOptions) =>
  fetchSource(
    "delawareMarketplace",
    DELAWARE_URL,
    `deadlinedate > '${soqlNow()}'`,
    "opendate DESC",
    delawareBidToOpportunity,
    options,
  );
