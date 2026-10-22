/**
 * Procurement version history, modelled on OCDS releases: the canonical opportunity is the procurement process
 * (its id plays the role of the OCID), and every materially different observation of it from a source is a release
 * with a tag (tender, amendment, cancellation, update), the fields that changed, the provider record it came from
 * and the raw record id. Nothing is overwritten: the canonical row keeps the latest fields, this table keeps how
 * they got there, including amendments and withdrawals.
 */
import { createHash, randomUUID } from "node:crypto";
import type { NormalizedOpportunity } from "../providers/types";
import { discoverAttachmentsWithCoverage } from "../documents/attachments";
import { rcPool } from "./db";
import { opportunityKey } from "./identity";
import { ensureReleaseCSchema } from "./schema";

export type ReleaseTag = "tender" | "amendment" | "cancellation" | "update";

export interface VersionSnapshot {
  title: string;
  agency: string;
  solicitation: string;
  type: string;
  status: string;
  deadline: string;
  setAside: string;
  place: string;
  naics: string;
  modified: string;
  description: string;
  attachments: string;
  sourceUrl: string;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

function iso(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function versionSnapshot(record: NormalizedOpportunity): VersionSnapshot {
  const raw = (record.rawData ?? {}) as Record<string, unknown>;
  let attachments = "";
  try {
    attachments = hash(discoverAttachmentsWithCoverage(record).listedUrls.slice().sort().join("\n"));
  } catch {
    attachments = "";
  }
  return {
    title: (record.title ?? "").trim(),
    agency: (record.agency ?? "").trim(),
    solicitation: (record.solicitationNumber ?? "").trim(),
    type: (record.type ?? "").trim(),
    status: (record.status ?? "").trim(),
    deadline: iso(record.responseDeadline),
    setAside: (record.setAside ?? "").trim(),
    place: (record.placeOfPerformance ?? "").trim(),
    naics: (record.naicsCode ?? "").trim(),
    modified: typeof raw.modifiedDate === "string" ? raw.modifiedDate : "",
    description: hash((record.description ?? "").replace(/\s+/g, " ").trim()),
    attachments,
    sourceUrl: (record.sourceUrl ?? "").trim(),
  };
}

const CANCELLED = /\b(cancel+(?:ed|ation)?|withdrawn|rescinded|terminated)\b/i;
const AMENDED = /\b(amend(?:ment|ed)?|modif(?:ication|ied)|addendum|revised|revision)\b/i;
// A change to one of these fields changes what is being bought or when it closes: an amendment.
const MATERIAL: Array<keyof VersionSnapshot> = ["deadline", "description", "attachments", "setAside", "place", "naics", "solicitation", "title"];

export function changedFields(previous: VersionSnapshot | null, next: VersionSnapshot): string[] {
  if (!previous) return [];
  return (Object.keys(next) as Array<keyof VersionSnapshot>).filter((key) => (previous[key] ?? "") !== (next[key] ?? ""));
}

export function releaseTag(previous: VersionSnapshot | null, next: VersionSnapshot): ReleaseTag {
  if (!previous) return CANCELLED.test(`${next.type} ${next.status}`) ? "cancellation" : "tender";
  const nowCancelled = CANCELLED.test(`${next.type} ${next.status} ${next.title}`);
  const wasCancelled = CANCELLED.test(`${previous.type} ${previous.status} ${previous.title}`);
  if (nowCancelled && !wasCancelled) return "cancellation";
  const changed = changedFields(previous, next);
  if (AMENDED.test(`${next.type} ${next.title}`) && changed.length > 0) return "amendment";
  if (changed.some((field) => MATERIAL.includes(field as keyof VersionSnapshot))) return "amendment";
  return "update";
}

/** A further provider's first view of a procurement already on record: a cancellation if it says so, else an update. */
export function crossSourceTag(_previous: VersionSnapshot | null, next: VersionSnapshot): ReleaseTag {
  return CANCELLED.test(`${next.type} ${next.status} ${next.title}`) ? "cancellation" : "update";
}

export function snapshotHash(snapshot: VersionSnapshot): string {
  return hash(JSON.stringify(snapshot));
}

/**
 * Appends a release when this provider's view of the procurement differs from the last one recorded. Returns the
 * tag, or null when nothing changed.
 */
export async function recordOpportunityVersion(input: {
  opportunityId: string;
  provider: string;
  providerNativeId: string;
  rawRecordId: string | null;
  record: NormalizedOpportunity;
}): Promise<ReleaseTag | null> {
  await ensureReleaseCSchema();
  const pool = await rcPool();
  const snapshot = versionSnapshot(input.record);
  const contentHash = snapshotHash(snapshot);
  const sourceId = typeof input.record.rawData?.sourceId === "string" ? input.record.rawData.sourceId.trim() || null : null;
  // Each provider describes a notice in its own words (agency naming, description, attachment list), so a change is
  // judged against this source's own previous observation, including the tenant of an aggregate provider.
  // Legacy snapshots without a sourceId cannot establish a tenant's lineage: start it with a cross-source update
  // rather than guessing which tenant supplied the old view. Providers without sourceId keep their old lineage.
  const latest = await pool.query(
    `(SELECT 'same' AS which, content_hash, snapshot FROM opportunity_versions WHERE opportunity_id = $1 AND provider = $2
       AND (snapshot->>'sourceId') IS NOT DISTINCT FROM $3::text
       ORDER BY observed_at DESC, id DESC LIMIT 1)
     UNION ALL
     (SELECT 'any' AS which, content_hash, snapshot FROM opportunity_versions WHERE opportunity_id = $1
       ORDER BY observed_at DESC, id DESC LIMIT 1)`,
    [input.opportunityId, input.provider, sourceId],
  );
  type Row = { which: "same" | "any"; content_hash?: string; snapshot?: VersionSnapshot };
  const rows = latest.rows as Row[];
  const sameProvider = rows.find((row) => row.which === "same");
  const anyProvider = rows.find((row) => row.which === "any");
  if (sameProvider?.content_hash === contentHash || anyProvider?.content_hash === contentHash) return null;
  const previous = (sameProvider ?? anyProvider)?.snapshot ?? null;
  const tag = sameProvider || !anyProvider ? releaseTag(previous, snapshot) : crossSourceTag(previous, snapshot);
  await pool.query(
    `INSERT INTO opportunity_versions (id, opportunity_id, opportunity_key, provider, provider_native_id, raw_record_id,
       release_tag, content_hash, snapshot, changed_fields, solicitation_number, source_url, source_modified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
    [
      randomUUID(),
      input.opportunityId,
      opportunityKey(input.record),
      input.provider,
      input.providerNativeId,
      input.rawRecordId,
      tag,
      contentHash,
      // Lineage is stored as metadata, outside the content hash and changed-field comparison.
      JSON.stringify({ ...snapshot, sourceId }),
      JSON.stringify(changedFields(previous, snapshot)),
      snapshot.solicitation || null,
      snapshot.sourceUrl || null,
      snapshot.modified || null,
    ],
  );
  return tag;
}

export interface OpportunityVersionRow {
  id: string;
  provider: string;
  releaseTag: ReleaseTag;
  changedFields: string[];
  solicitationNumber: string | null;
  sourceUrl: string | null;
  sourceModified: string | null;
  observedAt: string;
  deadline: string | null;
  title: string | null;
}

export async function listOpportunityVersions(opportunityId: string, limit = 50): Promise<OpportunityVersionRow[]> {
  await ensureReleaseCSchema();
  const result = await (await rcPool()).query(
    `SELECT id, provider, release_tag, changed_fields, solicitation_number, source_url, source_modified, observed_at, snapshot
       FROM opportunity_versions WHERE opportunity_id = $1 ORDER BY observed_at DESC, id DESC LIMIT $2`,
    [opportunityId, limit],
  );
  return result.rows.map((row) => {
    const snapshot = (row.snapshot ?? {}) as Partial<VersionSnapshot>;
    return {
      id: String(row.id),
      provider: String(row.provider),
      releaseTag: row.release_tag as ReleaseTag,
      changedFields: Array.isArray(row.changed_fields) ? row.changed_fields.map(String) : [],
      solicitationNumber: (row.solicitation_number as string | null) ?? null,
      sourceUrl: (row.source_url as string | null) ?? null,
      sourceModified: (row.source_modified as string | null) ?? null,
      observedAt: new Date(row.observed_at as string).toISOString(),
      deadline: snapshot.deadline || null,
      title: snapshot.title || null,
    };
  });
}
