/**
 * Procurement authenticity (Release C false positives). Web discovery returns pages that carry Occu-Med service
 * vocabulary without being procurement notices: guidance articles, regulations, terms of service, aggregator listing
 * pages, addenda to unrelated bids. The deterministic pipeline used to auto-accept them at high confidence (15
 * ai_reference_agreed cases in the Release C benchmark). These tests pin the downgrade, and pin that legitimate
 * occupational-health solicitations found the same way are still accepted.
 */
import "./support/useFixtureProfile";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { NormalizedOpportunity } from "../../providers/types";
import { classifyProviderRecordRelevance } from "../../providers/providerQueryMatch";
import { decideRelevance } from "../relevanceDecision";
import { assessProcurementAuthenticity, isWebDiscoverySource, ownNoticeText } from "../procurementAuthenticity";
import { triageDiscoveryCandidate } from "../webIntelligence";
import { toRecord, type BenchmarkCase } from "../../releaseC/benchmark/harness";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(
  fs.readFileSync(path.resolve(here, "../../releaseC/benchmark/dataset.json"), "utf8"),
) as { cases: BenchmarkCase[] };
const byId = new Map(dataset.cases.map((c) => [c.caseId, c]));

function judge(record: NormalizedOpportunity) {
  const relevance = classifyProviderRecordRelevance(record);
  return { relevance, verdict: decideRelevance(relevance).verdict };
}
function judgeCase(caseId: string) {
  const c = byId.get(caseId);
  assert.ok(c, `${caseId} missing from dataset.json`);
  return judge(toRecord(c));
}
const highConfidenceAccept = (r: ReturnType<typeof judge>) =>
  r.verdict === "accept" && (r.relevance.confidence === "verified_explicit" || r.relevance.confidence === "strong_combination");

function webRecord(fields: Partial<NormalizedOpportunity> & { title: string; source: string }): NormalizedOpportunity {
  return {
    externalId: `test-${fields.title}`,
    agency: "",
    type: "Solicitation",
    status: "active",
    postedDate: new Date(),
    ...fields,
  } as NormalizedOpportunity;
}
const future = () => new Date(Date.now() + 21 * 24 * 3600 * 1000);

/** The 15 wrong high-confidence matches the benchmark reported before the authenticity check. */
const CLEAR_NON_PROCUREMENT = {
  "prod-1c313afa": "Occupational Health Provider RFP Checklist: Employer Guide (guidance article)",
  "prod-88a66887": "Aspen Federal Regulation Set: Transplant Centers (regulation)",
  "prod-04b96aaa": "Terms of Service - Dribbler (terms of service)",
  "prod-ebab8e88": "$255M HHS Staffing Contract: Are You Ready to Bid? (consultancy article)",
  "prod-e763961b": "Cable testing RFP whose only medical text is an aggregator's 'similar RFPs' section",
};
const AMBIGUOUS_HELD = {
  "prod-6480c149": "Corporate Procurement - AUDA-NEPAD (procurement listing page)",
  "prod-b9df8133": "Health Month Event Bids, RFP & Government Contracts (aggregator search page)",
  "prod-80d6abdb": "ADDENDUM #1 for RFP2026-01 - Security Services (addendum)",
  "prod-02d1ce20": "Missoula County Invitation for Bid Addendum (addendum)",
  "prod-5240995e": "SAM.gov notice type Justification (post-award)",
};
/**
 * Not web-page authenticity problems: a medications/vaccines supply contract and clinical laboratory testing /
 * research. The canonical profile has no out-of-scope rule covering them (its supply rules name kits, laboratory
 * supplies and equipment; laboratory testing is an in-scope component), so they are left alone and stay listed as
 * remaining benchmark false positives.
 */
const REMAINING_OUT_OF_AUTHENTICITY_SCOPE = ["prod-b8b5b4b4", "prod-5c5b2162", "prod-d62a22bf", "prod-69bb0a4e", "prod-20d9c3e5"];

describe("benchmark wrong high-confidence matches", () => {
  for (const [caseId, what] of Object.entries(CLEAR_NON_PROCUREMENT)) {
    it(`${caseId} is not accepted: ${what}`, () => {
      const r = judgeCase(caseId);
      assert.equal(byId.get(caseId)!.label, "not_relevant");
      assert.equal(r.verdict, "reject", `${caseId} -> ${r.verdict}/${r.relevance.confidence}`);
    });
  }
  for (const [caseId, what] of Object.entries(AMBIGUOUS_HELD)) {
    it(`${caseId} is held for review, not auto-accepted: ${what}`, () => {
      const r = judgeCase(caseId);
      assert.equal(byId.get(caseId)!.label, "not_relevant");
      assert.equal(highConfidenceAccept(r), false);
      assert.equal(r.verdict, "review", `${caseId} -> ${r.verdict}/${r.relevance.confidence}`);
    });
  }
  it("records the five remaining cases that no authenticity or profile rule covers", () => {
    for (const caseId of REMAINING_OUT_OF_AUTHENTICITY_SCOPE) {
      const c = byId.get(caseId)!;
      assert.equal(c.label, "not_relevant");
      const record = toRecord(c);
      const assessment = assessProcurementAuthenticity({ ...record, url: record.sourceUrl, pscCode: c.record.pscCode });
      assert.equal(assessment.action, "none", caseId);
    }
    assert.equal(Object.keys(CLEAR_NON_PROCUREMENT).length + Object.keys(AMBIGUOUS_HELD).length + REMAINING_OUT_OF_AUTHENTICITY_SCOPE.length, 15);
  });
});

describe("legitimate occupational-health opportunities are kept", () => {
  it("never downgrades a relevant benchmark case on authenticity grounds", () => {
    const relevant = dataset.cases.filter((c) => c.label === "relevant");
    assert.ok(relevant.length > 100);
    for (const c of relevant) {
      const r = judge(toRecord(c));
      // rej-008 is a pre-existing missed opportunity (a thin AI-discovery title), unrelated to authenticity.
      if (c.caseId !== "rej-008") assert.notEqual(r.verdict, "reject", `${c.caseId} rejected`);
      assert.ok(
        !r.relevance.reasonCodes.some((code) => code === "NOT_A_PROCUREMENT_NOTICE" || code === "PROCUREMENT_AUTHENTICITY_REVIEW_HOLD"),
        `${c.caseId} downgraded: ${r.relevance.rejectReason}`,
      );
    }
  });

  it("still auto-accepts agreed relevant web-discovery cases from aggregators and official hosts", () => {
    for (const caseId of ["prod-a666ee92", "prod-d68feffe", "prod-be70a2b1", "prod-1d7406b0", "prod-4ba4280d", "prod-ab0d9ce1", "prod-b2f5a4a5", "rej-009"]) {
      const c = byId.get(caseId)!;
      assert.equal(c.label, "relevant", caseId);
      assert.ok(isWebDiscoverySource(c.source), caseId);
      assert.equal(judgeCase(caseId).verdict, "accept", caseId);
    }
  });

  const handWritten: Array<{ name: string; record: NormalizedOpportunity }> = [
    {
      name: "city RFP for pre-employment physicals and drug testing",
      record: webRecord({
        source: "exa",
        title: "RFP 2026-14 Pre-Employment Physicals and Drug Testing Services",
        agency: "City of Riverton",
        description:
          "The City of Riverton is requesting proposals from qualified providers for pre-employment physical examinations, DOT drug and alcohol testing, and post-accident testing for city employees and applicants. Proposals are due by 2:00 PM.",
        sourceUrl: "https://www.rivertonwy.gov/bids/rfp-2026-14",
        responseDeadline: future(),
      }),
    },
    {
      name: "county DOT physicals bid",
      record: webRecord({
        source: "serper",
        title: "Invitation to Bid #26-031: DOT Physical Examinations for County Drivers",
        agency: "Example County Purchasing",
        description:
          "Example County invites sealed bids for DOT physical examinations and medical examiner certification for commercial drivers, including drug and alcohol testing of safety-sensitive employees. Bid opening date listed below.",
        sourceUrl: "https://www.examplecounty.org/Bids.aspx?BidID=412",
        responseDeadline: future(),
      }),
    },
    {
      name: "fire department annual medical exams solicitation on a .gov host",
      record: webRecord({
        source: "tinyfish",
        title: "Request for Proposals: Fire Department Annual Medical Examinations (NFPA 1582)",
        agency: "Springfield Fire Department",
        description:
          "Solicitation for annual firefighter medical examinations and fitness for duty evaluations consistent with NFPA 1582, including audiometric testing, spirometry, and cancer screenings for fire department personnel.",
        sourceUrl: "https://www.springfield-or.gov/procurement/rfp-26-07-annual-medical-examinations",
      }),
    },
    {
      name: "occupational health RFP mirrored by an aggregator with a similar-RFPs section",
      record: webRecord({
        source: "keenable",
        title: "Occupational Health Services (Request for Proposal) - City of Lakeside",
        description:
          "Request for proposal for occupational health services including pre-employment physicals, drug testing and respirator fit testing for city employees. Similar active RFPs: Janitorial Services (Request For Proposal).",
        sourceUrl: "https://starbridge.ai/rfp/occupational-health-services-lakeside",
      }),
    },
  ];
  for (const { name, record } of handWritten) {
    it(`accepts: ${name}`, () => {
      const r = judge(record);
      assert.equal(r.verdict, "accept", `${name}: ${r.verdict}/${r.relevance.confidence} ${r.relevance.rejectReason ?? ""}`);
      assert.equal(assessProcurementAuthenticity({ ...record, description: record.description, url: record.sourceUrl }).action, "none");
    });
  }

  it("keeps an ambiguous official-host announcement and an ambiguous generic title (not rejected)", () => {
    const news = judge(
      webRecord({
        source: "exa",
        title: "City Seeks Proposals for Firefighter Physicals",
        description: "The city is requesting proposals for annual firefighter physical examinations and medical surveillance. RFP documents are on the purchasing portal.",
        sourceUrl: "https://www.examplecity.gov/news/firefighter-physicals-rfp",
      }),
    );
    assert.notEqual(news.verdict, "reject");
    const generic = judge(
      webRecord({
        source: "langsearch",
        title: "Medical Services",
        description: "Request for proposal for pre-employment physical examinations and drug screening for county employees.",
        sourceUrl: "https://www.bidnetdirect.com/county/medical-services",
      }),
    );
    assert.notEqual(generic.verdict, "reject");
  });
});

describe("authenticity classification", () => {
  const page = (title: string, url: string, extra: Partial<Parameters<typeof assessProcurementAuthenticity>[0]> = {}) =>
    assessProcurementAuthenticity({ title, url, source: "exa", ...extra });

  it("rejects clear non-procurement pages", () => {
    assert.equal(page("Privacy Policy | Acme Occupational Health", "https://acmeoccmed.com/privacy-policy").action, "reject");
    assert.equal(page("How to Write an RFP for Occupational Health Services", "https://acmeoccmed.com/blog/rfp").kind, "guidance_article");
    assert.equal(page("How to Write an RFP for Occupational Health Services", "https://acmeoccmed.com/blog/rfp").action, "reject");
    assert.equal(page("Chapter 59A-3 Florida Administrative Code: Hospital Licensure", "https://flrules.org/59A-3").action, "reject");
    assert.equal(page("Our Services - Acme Occupational Health", "https://acmeoccmed.com/our-services").action, "reject");
    assert.equal(page("Notice of Intent to Award: Occupational Health Services", "https://example.gov/award").action, "reject");
  });

  it("holds ambiguous pages for review instead of rejecting them", () => {
    assert.equal(page("Occupational Health RFP Guidance for Departments", "https://procurement.example.gov/guidance").action, "review");
    assert.equal(page("CLOSED - RFP 25-019 Annual Physicals", "https://example.gov/bids/25-019").action, "review");
    assert.equal(page("Addendum No. 2 - RFP 26-04 Occupational Medical Services", "https://example.gov/bids/26-04").action, "review");
    assert.equal(page("Current Bids and RFPs - Example County", "https://examplecounty.gov/bids").action, "review");
    assert.equal(page("Drug testing RFPs", "https://bidaggregator.com/search?q=drug+testing").action, "review");
    assert.equal(page("Workplace Testing Program", "https://acmelabs.com/services/workplace").action, "review");
  });

  it("leaves real notices and structured official sources alone", () => {
    assert.equal(page("RFQ 26-114: Annual Physicals", "https://example.gov/bids/26-114").action, "none");
    assert.equal(page("Occupational Medicine Services for Locally Engaged Staff", "https://sam.gov/opp/abc/view").action, "none");
    const checklistOnSam = assessProcurementAuthenticity({ title: "Occupational Health Provider Checklist", url: "https://sam.gov/opp/x/view", source: "samGov" });
    assert.equal(checklistOnSam.action, "none");
    assert.equal(assessProcurementAuthenticity({ title: "Occupational medical Services", type: "Justification", source: "samGov" }).kind, "post_award_notice");
    assert.equal(assessProcurementAuthenticity({ title: "Occupational medical Services", type: "Combined Synopsis/Solicitation", source: "samGov" }).action, "none");
  });

  it("drops an aggregator's cross-listing section from the notice text", () => {
    assert.equal(ownNoticeText("Scope: annual physicals. Similar active RFPs: Drug Testing Services."), "Scope: annual physicals. ");
    assert.equal(ownNoticeText("No cross listing here."), "No cross listing here.");
  });
});

describe("web-discovery triage uses the same authenticity check", () => {
  it("skips clear non-procurement pages with a reason", () => {
    assert.deepEqual(
      triageDiscoveryCandidate({
        title: "Occupational Health Provider RFP Checklist: Employer Guide",
        content: "An occupational medicine provider checklist should ask vendors which services they perform: physical examinations, drug and alcohol testing, respirator fit testing.",
        url: "https://gulfcoastoccmed.com/occupational-health-provider-rfp-checklist",
      }),
      { keep: false, reason: "not_a_procurement_notice" },
    );
  });

  it("keeps listing pages and addenda only in the review band", () => {
    const t = triageDiscoveryCandidate({
      title: "Health Month Event Bids, RFP & Government Contracts",
      content: "Requests for proposals for pre-employment physical examinations and drug testing services for county employees.",
      url: "https://www.instantmarkets.com/q/health_month_event",
    });
    assert.deepEqual(t, { keep: true, band: "review" });
  });

  it("still accepts a genuine solicitation", () => {
    assert.deepEqual(
      triageDiscoveryCandidate({
        title: "Pre-Employment Physical Examination Services RFP",
        content: "Request for proposal for pre-employment physical examinations and DOT drug testing.",
        url: "https://example.gov/bids/1",
      }),
      { keep: true, band: "accept" },
    );
  });
});
