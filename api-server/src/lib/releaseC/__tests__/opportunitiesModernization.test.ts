/**
 * Opportunities modernization (the "Final Plan" waves 1-3): nothing is silently capped, amendments and exclusions
 * can take back an approval, and work shared by parallel discovery providers is done once.
 */
import "../../search/__tests__/support/useFixtureProfile";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import type { NormalizedOpportunity } from "../../providers/types";
import { discoverAttachmentsWithCoverage, MAX_ATTACHMENTS } from "../../documents/attachments";
import { parseDocumentNatively } from "../../documents/parsers";
import { buildAssessment, extractRequirementsWithCoverage, type EvidenceSection } from "../requirements";
import { classifyWithDocumentEvidence, contradictingStatements } from "../documentEvidence";
import { SharedWork, canonicalCandidateUrl } from "../../search/sharedWork";
import { summaryCacheVersion } from "../../../routes/opportunity-summary-v2";

const DAY_MS = 86_400_000;

function notice(extra: Partial<NormalizedOpportunity> = {}): NormalizedOpportunity {
  return {
    externalId: "mod-1",
    title: "Occupational Health and Employee Medical Examination Services",
    agency: "Example County",
    type: "Solicitation",
    status: "active",
    postedDate: new Date(Date.now() - 3 * DAY_MS),
    responseDeadline: new Date(Date.now() + 20 * DAY_MS),
    description:
      "The county requests proposals for pre-employment physical examinations, audiometric testing, spirometry, DOT drug testing, and medical surveillance services for its workforce.",
    sourceUrl: "https://example.gov/rfp/mod-1",
    source: "publicPortalProviders",
    ...extra,
  } as NormalizedOpportunity;
}

function section(i: number, text: string, kind: EvidenceSection["kind"] = "general"): EvidenceSection {
  return { id: `s${i}`, documentId: `d${i}`, documentTitle: `Doc ${i}`, sourceUrl: null, pageStart: 1, pageEnd: 1, heading: null, kind, text };
}

describe("attachment overflow", () => {
  it("counts attachments over the registration cap and keeps their URLs as listed", () => {
    const links = Array.from({ length: MAX_ATTACHMENTS + 7 }, (_, i) => `https://example.gov/files/attachment-${i}.pdf`);
    const discovery = discoverAttachmentsWithCoverage(notice({ rawData: { attachments: links } }));
    assert.equal(discovery.attachments.length, MAX_ATTACHMENTS);
    assert.equal(discovery.overflow, 8, "7 extra links plus the notice page itself");
    assert.ok(discovery.listedUrls.includes(links[links.length - 1]!), "an unregistered attachment is not treated as withdrawn");
  });

  it("never reports a capped document set complete", () => {
    const docs = [{ extractionStatus: "extracted", retrievalStatus: "fetched" }];
    const full = buildAssessment(notice(), [], [], { documents: docs, documentPipelineEnabled: true });
    const capped = buildAssessment(notice(), [], [], { documents: docs, documentPipelineEnabled: true, attachmentsNotRegistered: 3 });
    assert.equal(full.documentCompleteness.status, "pass");
    assert.equal(capped.documentCompleteness.status, "partial");
    assert.equal(capped.documentCompleteness.attachmentsNotRegistered, 3);
  });
});

describe("ZIP solicitation bundles", () => {
  it("reads each supported member with a traceable label and reports unread members", async () => {
    const docx = zipSync({
      "[Content_Types].xml": strToU8('<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      "word/document.xml": strToU8("<w:document><w:body><w:p><w:r><w:t>The contractor shall provide pre-employment physical examinations.</w:t></w:r></w:p></w:body></w:document>"),
    });
    const bundle = zipSync({
      "Solicitation/SOW.docx": docx,
      "Solicitation/notes.txt": strToU8("Questions are due no later than 30 days after posting."),
      "Solicitation/scan.jpg": new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      "__MACOSX/._SOW.docx": strToU8("junk"),
    });
    const parsed = await parseDocumentNatively(bundle, "application/zip", "https://example.gov/bundle.zip");
    assert.equal(parsed.format, "zip");
    const text = parsed.pages.map((page) => page.text).join("\n");
    assert.match(text, /\[Archive member: Solicitation\/SOW\.docx, page 1\]\nThe contractor shall provide pre-employment physical examinations\./);
    assert.match(text, /Archive member: Solicitation\/notes\.txt/);
    assert.ok(parsed.extractedPageCount < parsed.pageCount, "the unread scan keeps the bundle partial");
    assert.ok(parsed.warnings.some((w) => /1 document members not read/.test(w)));
  });
});

describe("requirement coverage beyond 400", () => {
  it("keeps material requirements from later documents when a long first document fills the cap", () => {
    const boilerplate = Array.from({ length: 30 }, (_, i) => `The offeror shall submit administrative form number ${i} with the proposal package.`).join("\n\n");
    const sections = [section(1, boilerplate, "pricing"), section(2, "The contractor shall perform annual audiometric testing for all firefighters.", "scope")];
    const capped = extractRequirementsWithCoverage(sections, 10);
    assert.equal(capped.found, 31);
    assert.equal(capped.omitted, 21);
    assert.ok(capped.requirements.some((r) => /audiometric/.test(r.text)), "the SOW requirement survives the cap");
  });
});

describe("documents can take back an automatic approval", () => {
  it("finds an amendment that deletes an Occu-Med service, ignoring boilerplate exclusions", () => {
    const evidence = [
      "[Amendment 0002, p.1] The requirement for pre-employment physical examinations is hereby deleted.",
      "[Terms, p.9] Workers' compensation claims are excluded from this clause.",
    ].join("\n\n");
    const found = contradictingStatements(evidence, notice());
    assert.equal(found.length, 1);
    assert.match(found[0]!, /hereby deleted/);
  });

  it("turns an accept into review when the documents contradict the notice", () => {
    const record = notice({
      rawData: { documentEvidence: { text: "[Amendment 0002, p.1] The requirement for pre-employment physical examinations and drug testing is hereby deleted." } },
    });
    const { result, contradictions } = classifyWithDocumentEvidence(record);
    assert.equal(contradictions.length, 1);
    assert.ok(result.reasonCodes.includes("DOCUMENT_CONTRADICTS_SCOPE"));
  });
});

describe("work shared by parallel discovery providers", () => {
  it("canonicalises tracking parameters, fragments and host case", () => {
    assert.equal(
      canonicalCandidateUrl("https://WWW.Example.gov/bids/123/?utm_source=x&b=2&a=1#top"),
      canonicalCandidateUrl("https://example.gov/bids/123?a=1&b=2&gclid=abc"),
    );
  });

  it("runs concurrent identical work once and reuses it", async () => {
    const shared = new SharedWork<string | null>(60_000, 10, (value) => value !== null);
    let calls = 0;
    const work = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "page text";
    };
    const results = await Promise.all([shared.run("k", work), shared.run("k", work), shared.run("k", work)]);
    assert.deepEqual(results, ["page text", "page text", "page text"]);
    assert.equal(await shared.run("k", work), "page text");
    assert.equal(calls, 1);
  });

  it("does not cache a failed fetch", async () => {
    const shared = new SharedWork<string | null>(60_000, 10, (value) => value !== null);
    let calls = 0;
    await shared.run("k", async () => ((calls += 1), null));
    await shared.run("k", async () => ((calls += 1), "ok"));
    assert.equal(calls, 2);
  });
});

describe("summary cache versioning", () => {
  it("changes when the documents or the assessment change", () => {
    const before = summaryCacheVersion({ rawData: { documentEvidence: { hashes: ["a"] }, requirementLedger: { assessment: { summary: "Scope pass" } } } }, "p1");
    const amended = summaryCacheVersion({ rawData: { documentEvidence: { hashes: ["a", "b"] }, requirementLedger: { assessment: { summary: "Scope pass" } } } }, "p1");
    const profile = summaryCacheVersion({ rawData: { documentEvidence: { hashes: ["a"] }, requirementLedger: { assessment: { summary: "Scope pass" } } } }, "p2");
    assert.notEqual(before, amended);
    assert.notEqual(before, profile);
  });
});
