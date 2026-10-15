/**
 * Keyless official procurement APIs that complement SAM.gov / TED / CanadaBuys:
 *   - UK Find a Tender Service (OCDS release packages)
 *   - UK Contracts Finder (OCDS release packages)
 *   - World Bank procurement notices (search.worldbank.org)
 *
 * None of them needs an API key. They are mapped into NormalizedOpportunity records and held to the same
 * profile-driven relevance gate as TED: a record is kept only when the Neon relevance profile recognises Occu-Med
 * service evidence in it (or a profile CPV anchor), and expired notices are dropped.
 */
import { createHash } from "crypto";

import type { FetchOptions, NormalizedOpportunity, ProviderFetchResult } from "./types";
import { classifyResult } from "../search/relevance";
import { decideRelevance, matchDiscoveryCode } from "../search/relevanceDecision";
import { profileLeadQueries } from "./profileQueryTerms";

const FIND_A_TENDER_URL = "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages";
const FIND_A_TENDER_NOTICE_BASE = "https://www.find-tender.service.gov.uk/Notice";
const CONTRACTS_FINDER_URL = "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search";
const CONTRACTS_FINDER_NOTICE_BASE = "https://www.contractsfinder.service.gov.uk/Notice";
const WORLD_BANK_URL = "https://search.worldbank.org/api/v2/procnotices";
const WORLD_BANK_NOTICE_BASE = "https://projects.worldbank.org/en/projects-operations/procurement-detail";

const OCDS_PAGE_LIMIT = 100;
const OCDS_MAX_PAGES = 4;
const WORLD_BANK_ROWS = 50;
const WORLD_BANK_MAX_QUERIES = 3;
const DEFAULT_WINDOW_DAYS = 14;
const UNKNOWN_POSTED_DATE = new Date(0);

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function parseDate(value: unknown): Date | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function externalIdFor(prefix: string, seed: string): string {
  return `${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 20)}`;
}

function windowDays(options: FetchOptions): number {
  const days = options.dateRange ?? DEFAULT_WINDOW_DAYS;
  return Math.max(1, Math.min(60, Math.round(days)));
}

function ocdsTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19);
}

async function getJson(url: string, signal: AbortSignal | undefined, label: string): Promise<Json> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      `${label} ${response.status}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}: ${body.replace(/\s+/g, " ").slice(0, 200)}`,
    );
  }
  const json = (await response.json()) as unknown;
  return asObject(json) ?? {};
}

/** The next-page cursor of an OCDS release package, wherever the publisher puts it. */
export function ocdsNextCursor(pkg: Json): string | undefined {
  const links = asObject(pkg.links);
  const next = text(links?.next) ?? text(pkg.nextCursor) ?? text(pkg.cursor);
  if (!next) return undefined;
  if (/^[A-Za-z0-9=]+$/.test(next)) return next;
  try {
    return new URL(next).searchParams.get("cursor") ?? undefined;
  } catch {
    return undefined;
  }
}

function cpvCodesOf(tender: Json): string[] {
  const codes: string[] = [];
  const add = (classification: unknown) => {
    const entry = asObject(classification);
    if (!entry) return;
    const scheme = text(entry.scheme)?.toUpperCase();
    const id = text(entry.id);
    if (id && (!scheme || scheme === "CPV")) codes.push(id);
  };
  add(tender.classification);
  for (const item of asArray(tender.items)) {
    const object = asObject(item);
    if (!object) continue;
    add(object.classification);
    for (const extra of asArray(object.additionalClassifications)) add(extra);
  }
  for (const lot of asArray(tender.lots)) {
    for (const extra of asArray(asObject(lot)?.additionalClassifications)) add(extra);
  }
  return Array.from(new Set(codes));
}

/** True when the relevance gate lets the record through: profile service evidence, or a profile CPV anchor. */
function passesRelevance(title: string, description: string | undefined, url: string, cpvCodes: string[]): boolean {
  const classification = classifyResult({ title, snippet: description ?? "", url, allowHistorical: false });
  const anchored = cpvCodes.some((code) => matchDiscoveryCode("CPV", code)?.effect === "include_anchor");
  if (classification.matchedServiceCategories.length === 0 && !anchored) return false;
  if (decideRelevance(classification).verdict === "reject" && !anchored) return false;
  return true;
}

export type OcdsPortal = "findATender" | "contractsFinder";

const OCDS_PORTALS: Record<OcdsPortal, { name: string; noticeBase: string; idPattern: RegExp; prefix: string }> = {
  findATender: {
    name: "UK Find a Tender Service",
    noticeBase: FIND_A_TENDER_NOTICE_BASE,
    idPattern: /\d{6}-\d{4}/,
    prefix: "uk-fts",
  },
  contractsFinder: {
    name: "UK Contracts Finder",
    noticeBase: CONTRACTS_FINDER_NOTICE_BASE,
    idPattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    prefix: "uk-cf",
  },
};

/** Map one OCDS release from a UK portal to an opportunity; null when it is not an open, relevant tender. */
export function ocdsReleaseToOpportunity(release: Json, portal: OcdsPortal): NormalizedOpportunity | null {
  const meta = OCDS_PORTALS[portal];
  const tags = asArray(release.tag).map((tag) => String(tag).toLowerCase());
  // Awards, contract changes and cancellations are not bid opportunities.
  if (tags.length > 0 && !tags.some((tag) => tag.startsWith("tender") || tag === "planning")) return null;
  if (tags.some((tag) => tag.includes("cancel"))) return null;

  const tender = asObject(release.tender);
  if (!tender) return null;
  const status = text(tender.status)?.toLowerCase();
  if (status && ["cancelled", "canceled", "unsuccessful", "withdrawn", "complete"].includes(status)) return null;

  const title = text(tender.title);
  if (!title) return null;
  const description = text(tender.description) ?? text(release.description);

  const noticeId = [text(release.id), text(release.ocid)]
    .map((id) => (id ? id.match(meta.idPattern)?.[0] : undefined))
    .find((id): id is string => Boolean(id));
  const sourceUrl = noticeId ? `${meta.noticeBase}/${noticeId}` : meta.noticeBase.replace(/\/Notice$/, "");

  const cpvCodes = cpvCodesOf(tender);
  if (!passesRelevance(title, description, sourceUrl, cpvCodes)) return null;

  const deadline = parseDate(asObject(tender.tenderPeriod)?.endDate);
  if (deadline && deadline.getTime() < Date.now()) return null;

  const partyBuyer = asArray(release.parties)
    .map(asObject)
    .find((party) => asArray(party?.roles).includes("buyer"));
  const buyerName = text(asObject(release.buyer)?.name) ?? text(partyBuyer?.name) ?? "UK public buyer";
  const value = asObject(tender.value);
  const amount = typeof value?.amount === "number" && value.amount > 0 ? value.amount : undefined;
  const deliveryRegion = text(
    asObject(asObject(asArray(tender.items)[0])?.deliveryAddress)?.region ??
      asObject(asObject(asArray(tender.items)[0])?.deliveryAddress)?.countryName,
  );
  const location = deliveryRegion ?? "United Kingdom";

  return {
    externalId: externalIdFor(meta.prefix, noticeId ?? text(release.ocid) ?? `${title}|${buyerName}`),
    title,
    agency: buyerName,
    type: tags.includes("planning") ? "Planning notice" : "Solicitation",
    status: "active",
    postedDate: parseDate(release.date) ?? UNKNOWN_POSTED_DATE,
    responseDeadline: deadline,
    description,
    location,
    placeOfPerformance: location,
    estimatedValue: amount,
    sourceUrl,
    solicitationNumber: noticeId ?? text(release.ocid),
    source: "internationalPublicPortals",
    providerName: "internationalPublicPortals",
    rawData: {
      providerName: "internationalPublicPortals",
      providerFamily: "international_public_procurement",
      internationalSource: portal,
      portalName: meta.name,
      geography: "United Kingdom",
      country: "GB",
      currency: text(value?.currency),
      cpv: cpvCodes[0],
      cpvCodes,
      directOfficialApi: true,
      authenticationRequired: false,
      sourceConfidence: "high",
      evidenceType: "direct-structured",
      buyerProvenance: "official_structured",
      deadlineProvenance: deadline ? "official_structured" : "unknown",
      statusProvenance: "official_structured",
      descriptionProvenance: description ? "official_structured" : "unknown",
      ocid: text(release.ocid),
    },
  };
}

async function fetchOcdsPortal(portal: OcdsPortal, options: FetchOptions): Promise<ProviderFetchResult> {
  const meta = OCDS_PORTALS[portal];
  const since = new Date(Date.now() - windowDays(options) * 24 * 60 * 60 * 1000);
  const records: NormalizedOpportunity[] = [];
  const errors: string[] = [];
  let scanned = 0;
  let pages = 0;
  let cursor: string | undefined;

  while (pages < OCDS_MAX_PAGES) {
    const params = new URLSearchParams({ limit: String(OCDS_PAGE_LIMIT), stages: "tender" });
    if (portal === "findATender") params.set("updatedFrom", ocdsTimestamp(since));
    else params.set("publishedFrom", since.toISOString().slice(0, 10));
    if (cursor) params.set("cursor", cursor);
    const base = portal === "findATender" ? FIND_A_TENDER_URL : CONTRACTS_FINDER_URL;
    let pkg: Json;
    try {
      pkg = await getJson(`${base}?${params.toString()}`, options.signal, `${meta.name} API`);
    } catch (error) {
      // Keep whatever earlier pages produced; surface the failure.
      errors.push(error instanceof Error ? error.message : String(error));
      break;
    }
    pages += 1;
    const releases = asArray(pkg.releases).map(asObject).filter((entry): entry is Json => Boolean(entry));
    scanned += releases.length;
    for (const release of releases) {
      const record = ocdsReleaseToOpportunity(release, portal);
      if (record) records.push(record);
    }
    const next = ocdsNextCursor(pkg);
    if (!next || next === cursor || releases.length === 0) break;
    cursor = next;
  }

  return {
    records,
    total: records.length,
    errors,
    diagnostics: {
      internationalSource: portal,
      mode: "official-ocds-api",
      apiAnonymous: true,
      pages,
      candidates: scanned,
      accepted: records.length,
      windowDays: windowDays(options),
    },
  };
}

export const fetchFindATender = (options: FetchOptions) => fetchOcdsPortal("findATender", options);
export const fetchContractsFinder = (options: FetchOptions) => fetchOcdsPortal("contractsFinder", options);

/** World Bank search terms: the profile's lead service queries, plus caller keywords. */
export function buildWorldBankQueries(keywords?: string): string[] {
  const queries = profileLeadQueries(WORLD_BANK_MAX_QUERIES).map((query) => query.replace(/"/g, "").trim());
  const focus = keywords?.trim().replace(/"/g, "").slice(0, 120);
  if (focus) queries.unshift(focus);
  return Array.from(new Set(queries.filter(Boolean))).slice(0, WORLD_BANK_MAX_QUERIES);
}

/** Map one World Bank procurement notice; null for awards, expired notices and irrelevant notices. */
export function worldBankNoticeToOpportunity(notice: Json): NormalizedOpportunity | null {
  const id = text(notice.id);
  if (!id) return null;
  const noticeType = text(notice.notice_type) ?? "Procurement notice";
  if (/award/i.test(noticeType)) return null;
  if (/cancel/i.test(text(notice.notice_status) ?? "")) return null;

  const description = text(notice.bid_description);
  const project = text(notice.project_name);
  const title = description ?? project;
  if (!title) return null;
  const body = [description, project, stripHtml(text(notice.notice_text) ?? "").slice(0, 2000)]
    .filter(Boolean)
    .join("\n\n");
  const sourceUrl = `${WORLD_BANK_NOTICE_BASE}/${encodeURIComponent(id)}`;
  if (!passesRelevance(title, body, sourceUrl, [])) return null;

  const deadline = parseDate(notice.submission_date);
  if (deadline && deadline.getTime() < Date.now()) return null;
  const country = text(notice.project_ctry_name);

  return {
    externalId: externalIdFor("wb", id),
    title,
    agency: project ? `World Bank borrower: ${project}` : "World Bank-financed project",
    type: noticeType,
    status: "active",
    postedDate: parseDate(notice.noticedate) ?? UNKNOWN_POSTED_DATE,
    responseDeadline: deadline,
    description: body || undefined,
    location: country,
    placeOfPerformance: country,
    sourceUrl,
    solicitationNumber: text(notice.bid_reference_no) ?? id,
    source: "internationalPublicPortals",
    providerName: "internationalPublicPortals",
    rawData: {
      providerName: "internationalPublicPortals",
      providerFamily: "international_public_procurement",
      internationalSource: "worldBank",
      portalName: "World Bank Procurement Notices",
      geography: country ?? "International",
      country,
      projectId: text(notice.project_id),
      procurementMethod: text(notice.procurement_method_name),
      directOfficialApi: true,
      authenticationRequired: false,
      sourceConfidence: "high",
      evidenceType: "direct-structured",
      buyerProvenance: "official_structured",
      deadlineProvenance: deadline ? "official_structured" : "unknown",
      statusProvenance: "official_structured",
      descriptionProvenance: description ? "official_structured" : "unknown",
    },
  };
}

export async function fetchWorldBank(options: FetchOptions): Promise<ProviderFetchResult> {
  const queries = buildWorldBankQueries(options.keywords);
  const records: NormalizedOpportunity[] = [];
  const errors: string[] = [];
  let scanned = 0;
  const seen = new Set<string>();

  for (const query of queries) {
    const params = new URLSearchParams({
      format: "json",
      apilang: "en",
      rows: String(WORLD_BANK_ROWS),
      qterm: query,
      srt: "noticedate",
      order: "desc",
    });
    let json: Json;
    try {
      json = await getJson(`${WORLD_BANK_URL}?${params.toString()}`, options.signal, "World Bank procurement API");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    // The API returns notices as an array, or as an object keyed by notice id.
    const raw = json.procnotices;
    const notices = (Array.isArray(raw) ? raw : Object.values(asObject(raw) ?? {}))
      .map(asObject)
      .filter((entry): entry is Json => Boolean(entry));
    scanned += notices.length;
    for (const notice of notices) {
      const record = worldBankNoticeToOpportunity(notice);
      if (!record || seen.has(record.externalId)) continue;
      seen.add(record.externalId);
      records.push(record);
    }
  }

  return {
    records,
    total: records.length,
    errors,
    diagnostics: {
      internationalSource: "worldBank",
      mode: "official-search-api",
      apiAnonymous: true,
      queryCount: queries.length,
      queries,
      candidates: scanned,
      accepted: records.length,
    },
  };
}
