/**
 * Opportunities wave 2: procurement versions, the full attachment inventory, and evidence from the whole corpus.
 */
import "../../search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedOpportunity } from "../../providers/types";
import { discoverAttachmentsWithCoverage, MAX_ATTACHMENTS } from "../../documents/attachments";
import { promoteDeferredDocuments, registerAttachments, DEFERRED_PRIORITY } from "../../documents/store";
import { isSeparateProcurement } from "../../ingestion/pipelineRules";
import { corpusEvidence } from "../passages";
import { classifyWithDocumentEvidence } from "../documentEvidence";
import { changedFields, crossSourceTag, recordOpportunityVersion, listOpportunityVersions, releaseTag, versionSnapshot } from "../versions";
import { documentState } from "../../../routes/opportunity-evidence";
import { rcPool } from "../db";
import { ensureReleaseCSchema } from "../schema";
import type { EvidenceSection } from "../requirements";

const DAY_MS = 86_400_000;
// Providers report statuses outside the normalized union (cancelled, withdrawn, open); versions read them as text.
const status = (value: string) => value as unknown as NormalizedOpportunity["status"];
// Database-backed cases run only where Postgres is actually reachable (some CI jobs set the URL without a server).
const hasDb = await (async () => {
  if (!process.env.RFP_DATABASE_URL) return false;
  try {
    await Promise.race([
      (await rcPool()).query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000).unref()),
    ]);
    return true;
  } catch {
    return false;
  }
})();
const run = `w2${Date.now().toString(36)}`;

function notice(extra: Partial<NormalizedOpportunity> = {}): NormalizedOpportunity {
  return {
    externalId: `${run}-1`,
    title: "Occupational Health and Employee Medical Examination Services",
    agency: "Example County",
    solicitationNumber: "RFP-2026-014",
    type: "Solicitation",
    status: "active",
    postedDate: new Date(Date.now() - 3 * DAY_MS),
    responseDeadline: new Date("2026-12-01T17:00:00Z"),
    description:
      "The county requests proposals for pre-employment physical examinations, audiometric testing, spirometry, DOT drug testing, and medical surveillance services for its workforce.",
    sourceUrl: "https://example.gov/rfp/w2-1",
    source: "publicPortalProviders",
    ...extra,
  } as NormalizedOpportunity;
}

function section(page: number, text: string, kind: EvidenceSection["kind"] = "general", documentId = "doc-1"): EvidenceSection {
  return { id: `${documentId}-s${page}`, documentId, documentTitle: "Solicitation", sourceUrl: null, pageStart: page, pageEnd: page, heading: null, kind, text };
}

describe("evidence from the whole document corpus", () => {
  const boilerplate = "The contractor shall comply with all applicable federal, state and local laws, regulations and ordinances. ".repeat(40);
  const corpus: EvidenceSection[] = [
    ...Array.from({ length: 139 }, (_, index) => section(index + 1, boilerplate)),
    section(140, "Eligibility: Only offerors licensed in the State of Oregon and located within Multnomah County may submit. Pre-employment physical examinations are required for all new hires.", "qualification"),
    ...Array.from({ length: 60 }, (_, index) => section(141 + index, boilerplate)),
  ];

  it("finds a restriction on page 140 of a 200-page solicitation and cites it", () => {
    const evidence = corpusEvidence(corpus, 12_000, ["pre-employment physical"]);
    assert.match(evidence.text, /\[Solicitation, p\.140\] Eligibility/);
    assert.equal(evidence.coverage.sections, 200, "every section was read");
    assert.ok(evidence.eligibility.some((finding) => finding.citation.includes("p.140")));
    assert.ok(evidence.text.length <= 12_000);
  });

  it("is reproducible and presents passages in document order", () => {
    const a = corpusEvidence(corpus, 6_000, ["pre-employment physical"]);
    const b = corpusEvidence(corpus, 6_000, ["pre-employment physical"]);
    assert.equal(a.text, b.text);
    const pages = a.passages.map((passage) => passage.pageStart ?? 0);
    assert.deepEqual(pages, [...pages].sort((x, y) => x - y));
  });

  it("reaches text deep inside one long section, not only its start", () => {
    const long = section(3, `${boilerplate}${boilerplate} Amendment 0003 supersedes Section C in its entirety. ${boilerplate}`, "general");
    const evidence = corpusEvidence([long], 3_000, []);
    assert.match(evidence.text, /supersedes Section C/);
    assert.equal(evidence.superseding.length, 1);
  });

  it("an exclusion found anywhere in the corpus takes away an automatic approval", () => {
    const record = notice({
      rawData: {
        documentEvidence: {
          text: "[Solicitation, p.2] The county seeks occupational health services for its workforce.",
          exclusions: [{ statement: "Pre-employment physical examinations and drug testing are not included in this contract.", citation: "[Solicitation, p.88]", sectionId: "x" }],
        },
      },
    });
    const { result, contradictions } = classifyWithDocumentEvidence(record);
    assert.equal(contradictions.length, 1);
    assert.ok(result.reasonCodes.includes("DOCUMENT_CONTRADICTS_SCOPE"));
  });
});

describe("procurement identity and versions", () => {
  it("keeps a re-issued procurement with a new solicitation number separate from the old one", () => {
    assert.equal(isSeparateProcurement("fingerprint", "RFP-2026-014", "RFP-2025-009"), true);
    assert.equal(isSeparateProcurement("url", "Lot 2", "Lot 1"), true);
    assert.equal(isSeparateProcurement("fingerprint", "RFP-2026-014", "rfp 2026 014"), false, "formatting is not a difference");
    assert.equal(isSeparateProcurement("fingerprint", "RFP-2026-014", null), false, "a record without a number is still a duplicate");
    assert.equal(isSeparateProcurement("solicitation", "A", "B"), false, "strong matches are never split");
    assert.equal(isSeparateProcurement("provider", "A", "B"), false);
  });

  it("tags tender, amendment, cancellation and plain updates", () => {
    const first = versionSnapshot(notice());
    assert.equal(releaseTag(null, first), "tender");
    const extended = versionSnapshot(notice({ responseDeadline: new Date("2026-12-15T17:00:00Z") }));
    assert.deepEqual(changedFields(first, extended), ["deadline"]);
    assert.equal(releaseTag(first, extended), "amendment");
    const cancelled = versionSnapshot(notice({ status: status("cancelled") }));
    assert.equal(releaseTag(first, cancelled), "cancellation");
    const contact = versionSnapshot(notice({ status: status("open") }));
    assert.equal(releaseTag(first, contact), "update");
  });

  it("detects a new source's cancellation independently of the previous source", () => {
    const active = versionSnapshot(notice());
    const cancelled = { ...active, status: "cancelled" };
    for (const previous of [cancelled, active, null]) {
      for (const field of ["status", "type", "title"] as const) {
        for (const marker of ["cancelled", "withdrawn", "rescinded", "terminated"]) {
          assert.equal(crossSourceTag(previous, { ...active, [field]: marker }), "cancellation", `${field}: ${marker}`);
        }
      }
      assert.equal(crossSourceTag(previous, { ...active, title: "Revised occupational health solicitation" }), "update");
    }
  });

  it("records each materially different observation once, with its history", { skip: !hasDb }, async () => {
    await ensureReleaseCSchema();
    const opportunityId = `opp-${run}`;
    const input = (record: NormalizedOpportunity) => ({ opportunityId, provider: "publicPortalProviders", providerNativeId: record.externalId!, rawRecordId: null, record });
    assert.equal(await recordOpportunityVersion(input(notice())), "tender");
    assert.equal(await recordOpportunityVersion(input(notice())), null, "an unchanged observation adds nothing");
    assert.equal(await recordOpportunityVersion(input(notice({ responseDeadline: new Date("2026-12-20T17:00:00Z") }))), "amendment");
    assert.equal(await recordOpportunityVersion(input(notice({ responseDeadline: new Date("2026-12-20T17:00:00Z"), status: status("withdrawn") }))), "cancellation");
    const versions = await listOpportunityVersions(opportunityId);
    assert.deepEqual(versions.map((version) => version.releaseTag), ["cancellation", "amendment", "tender"]);
    assert.deepEqual(versions[1]!.changedFields, ["deadline"]);
  });

  it("judges a change against the same provider's last view, so another provider's wording is not an amendment", { skip: !hasDb }, async () => {
    await ensureReleaseCSchema();
    const opportunityId = `opp-${run}-cross`;
    const observe = (provider: string, record: NormalizedOpportunity) =>
      recordOpportunityVersion({ opportunityId, provider, providerNativeId: record.externalId!, rawRecordId: null, record });
    assert.equal(await observe("samGov", notice()), "tender");
    const reworded = notice({ agency: "EXAMPLE COUNTY GOVERNMENT", description: "Occupational medical examinations for county staff." });
    assert.equal(await observe("tango", reworded), "update", "a second source's own wording is a cross-source update");
    assert.equal(await observe("samGov", notice()), null, "the first source's unchanged view adds nothing");
    assert.equal(await observe("tango", reworded), null);
    assert.equal(await observe("tango", { ...reworded, responseDeadline: new Date("2026-12-22T17:00:00Z") }), "amendment");
  });

  it("keeps aggregate portal tenants separate even when native ids and URLs coincide", { skip: !hasDb }, async () => {
    const opportunityId = `opp-${run}-tenants`;
    const a = notice({ rawData: { sourceId: "portal-a" } });
    const b = notice({ description: "The same procurement, described by a second portal.", rawData: { sourceId: "portal-b" } });
    const observe = (record: NormalizedOpportunity) => recordOpportunityVersion({
      opportunityId, provider: "publicPortalProviders", providerNativeId: record.externalId, rawRecordId: null, record,
    });
    assert.equal(await observe(a), "tender");
    assert.equal(await observe(b), "update");
    for (let index = 0; index < 2; index += 1) {
      assert.equal(await observe(a), null, "alternating portals must not manufacture amendments");
      assert.equal(await observe(b), null);
    }
    assert.equal(await observe({ ...a, responseDeadline: new Date("2026-12-22T17:00:00Z") }), "amendment");
    assert.equal(await observe(b), null, "the other tenant's baseline must still be used");
    const versions = await listOpportunityVersions(opportunityId);
    assert.equal(versions.length, 3);
    assert.deepEqual(versions[0]!.changedFields, ["deadline"], "lineage metadata is not a content change");
  });

  it("starts an identified tenant conservatively when legacy history has no source identity", { skip: !hasDb }, async () => {
    const opportunityId = `opp-${run}-legacy-tenant`;
    const observe = (record: NormalizedOpportunity) => recordOpportunityVersion({
      opportunityId, provider: "publicPortalProviders", providerNativeId: record.externalId, rawRecordId: null, record,
    });
    assert.equal(await observe(notice()), "tender");
    await (await rcPool()).query("UPDATE opportunity_versions SET snapshot = snapshot - 'sourceId' WHERE opportunity_id = $1", [opportunityId]);
    const tenant = notice({ description: "Portal-specific wording.", rawData: { sourceId: "portal-a" } });
    assert.equal(await observe(tenant), "update", "unknown legacy provenance cannot establish the tenant's baseline");
    assert.equal(await observe(tenant), null);
    assert.equal(await observe({ ...tenant, responseDeadline: new Date("2026-12-22T17:00:00Z") }), "amendment");
  });

  it("continues legacy provider-only history when the provider has no tenant identity", { skip: !hasDb }, async () => {
    const opportunityId = `opp-${run}-legacy-provider`;
    const observe = (record: NormalizedOpportunity) => recordOpportunityVersion({
      opportunityId, provider: "samGov", providerNativeId: record.externalId, rawRecordId: null, record,
    });
    assert.equal(await observe(notice()), "tender");
    await (await rcPool()).query("UPDATE opportunity_versions SET snapshot = snapshot - 'sourceId' WHERE opportunity_id = $1", [opportunityId]);
    assert.equal(await observe(notice()), null);
    assert.equal(await observe(notice({ responseDeadline: new Date("2026-12-22T17:00:00Z") })), "amendment");
  });

  it("records cancellation from a new portal even when another portal was already cancelled", { skip: !hasDb }, async () => {
    const opportunityId = `opp-${run}-cross-cancelled`;
    const observe = (record: NormalizedOpportunity) => recordOpportunityVersion({
      opportunityId, provider: "publicPortalProviders", providerNativeId: record.externalId, rawRecordId: null, record,
    });
    assert.equal(await observe(notice({ status: status("cancelled"), rawData: { sourceId: "portal-a" } })), "cancellation");
    const b = notice({ status: status("withdrawn"), description: "Withdrawal confirmed by the second portal.", rawData: { sourceId: "portal-b" } });
    assert.equal(await observe(b), "cancellation");
    assert.equal(await observe(b), null);
    assert.deepEqual((await listOpportunityVersions(opportunityId)).map((version) => version.releaseTag), ["cancellation", "cancellation"]);
  });

  it("records a new provider's cancellation after an already-cancelled source", { skip: !hasDb }, async () => {
    const opportunityId = `opp-${run}-provider-cancelled`;
    const observe = (provider: string, record: NormalizedOpportunity) => recordOpportunityVersion({
      opportunityId, provider, providerNativeId: record.externalId, rawRecordId: null, record,
    });
    assert.equal(await observe("samGov", notice({ status: status("cancelled") })), "cancellation");
    const second = notice({ status: status("cancelled"), description: "Cancellation confirmed independently." });
    assert.equal(await observe("tango", second), "cancellation", "the previous provider's cancellation must not suppress this evidence");
    assert.equal(await observe("tango", second), null);
  });
});

describe("full attachment inventory", () => {
  const many = (count: number) =>
    notice({ rawData: { attachments: Array.from({ length: count }, (_, index) => ({ url: `https://example.gov/docs/${run}/file-${index}.pdf`, name: `Exhibit ${index}` })) } });

  it("inventories attachments over the processing cap instead of only counting them", () => {
    const discovery = discoverAttachmentsWithCoverage(many(MAX_ATTACHMENTS + 15));
    assert.equal(discovery.attachments.length, MAX_ATTACHMENTS);
    assert.ok(discovery.deferred.length >= 15);
    assert.equal(discovery.overflow, discovery.deferred.length);
  });

  it("stores deferred attachments and feeds them to the worker in bounded batches", { skip: !hasDb }, async () => {
    await ensureReleaseCSchema();
    const key = `provider:test:${run}-inventory`;
    const discovery = discoverAttachmentsWithCoverage(many(MAX_ATTACHMENTS + 7));
    const registered = await registerAttachments(key, discovery.attachments.slice(0, 2), 1, { deferred: discovery.deferred });
    assert.ok(registered.deferred >= 7);
    const again = await registerAttachments(key, [], 1, { deferred: discovery.deferred });
    assert.equal(again.deferred, 0, "re-listing does not duplicate the inventory");
    const pool = await rcPool();
    const before = await pool.query(`SELECT count(*)::int AS n FROM opportunity_documents WHERE opportunity_key = $1 AND retrieval_status = 'deferred'`, [key]);
    assert.ok(Number(before.rows[0].n) >= 7);
    const promoted = await promoteDeferredDocuments(3, 10_000);
    assert.ok(promoted >= 1 && promoted <= 3, "at most one batch is promoted");
    const jobs = await pool.query(`SELECT count(*)::int AS n FROM document_extraction_jobs WHERE priority = $1 AND opportunity_key = $2`, [DEFERRED_PRIORITY, key]);
    assert.ok(Number(jobs.rows[0].n) <= 3);
    assert.equal(await promoteDeferredDocuments(3, 0), 0, "the daily bound stops promotion");
  });

  it("reports unread material by state", () => {
    assert.equal(documentState({ retrieval_status: "deferred", extraction_status: "pending", superseded_by: null }), "deferred");
    assert.equal(documentState({ retrieval_status: "fetched", extraction_status: "extracted", superseded_by: null }), "read");
    assert.equal(documentState({ retrieval_status: "fetched", extraction_status: "needs_ocr", superseded_by: null }), "needs_ocr");
    assert.equal(documentState({ retrieval_status: "blocked", extraction_status: "pending", superseded_by: null }), "inaccessible");
    assert.equal(documentState({ retrieval_status: "too_large", extraction_status: "pending", superseded_by: null }), "too_large");
    assert.equal(documentState({ retrieval_status: "fetched", extraction_status: "extracted", superseded_by: "withdrawn" }), "withdrawn");
  });
});
