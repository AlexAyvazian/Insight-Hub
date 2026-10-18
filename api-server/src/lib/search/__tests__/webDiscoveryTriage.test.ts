/**
 * Task 04 (F-08, F-12, F-17, F-25): web discovery used to require full classifier *acceptance* from a short
 * title/snippet before a page was fetched, so generic but genuine solicitations were dropped unseen. Triage now
 * keeps review-band hits for bounded enrichment, records why every skipped hit was skipped, keeps the fetched text
 * instead of 600 characters, and never invents a buyer from a service category. This path is shared by web
 * discovery, CanadaBuys and SAM zero-result recovery; the primary SAM API path does not use it.
 */
import "./support/useFixtureProfile";
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { triageDiscoveryCandidate, webIntelligenceFetch } from "../webIntelligence";
import { websearchProvider } from "../../providers/websearch";
import { jinaProvider } from "../../providers/jina";
import { keenableProvider } from "../../providers/keenable";
import { browserbaseProvider } from "../../providers/browserbase";
import { firecrawlProvider } from "../../providers/firecrawl";
import { microlinkProvider } from "../../providers/microlink";

describe("pre-enrichment triage", () => {
  it("keeps a genuine solicitation with a generic title and thin snippet (review band)", () => {
    const t = triageDiscoveryCandidate({
      title: "RFQ 26-114: Annual Physicals",
      content: "City of Example bid opportunity. See portal for documents.",
      url: "https://example.gov/bids/26-114",
    });
    assert.deepEqual(t, { keep: true, band: "review" });
  });

  it("keeps clearly accepted hits", () => {
    const t = triageDiscoveryCandidate({
      title: "Pre-Employment Physical Examination Services RFP",
      content: "Request for proposal for pre-employment physical examinations and DOT drug testing.",
      url: "https://example.gov/bids/1",
    });
    assert.deepEqual(t, { keep: true, band: "accept" });
  });

  it("skips job boards, hard rejects, non-procurement and unrelated hits with a reason", () => {
    assert.deepEqual(
      triageDiscoveryCandidate({ title: "Occupational Health Nurse", content: "Apply now", url: "https://www.indeed.com/job/1" }),
      { keep: false, reason: "blocked_domain" },
    );
    assert.deepEqual(
      triageDiscoveryCandidate({ title: "Medical Examination Services Award Notice", content: "Contract awarded to Acme.", url: "https://example.gov/a" }),
      { keep: false, reason: "hard_reject" },
    );
    assert.deepEqual(
      triageDiscoveryCandidate({ title: "Annual employee physicals guide", content: "What to expect at your annual physical.", url: "https://example.org/blog" }),
      { keep: false, reason: "no_procurement_signal" },
    );
    const qa = triageDiscoveryCandidate({ title: "Construction QA Medical Center", content: "Request for proposal construction quality assurance; costs; provider", url: "https://example.gov/c" });
    assert.equal(qa.keep, false);
  });
});

describe("bounded enrichment end to end (mocked providers, no network)", () => {
  const extracted: string[] = [];
  const hits = Array.from({ length: 14 }, (_, i) => ({
    title: i < 12 ? `RFQ 26-${100 + i}: Annual Physicals` : `Janitorial Services Bid ${i}`,
    url: `https://example.gov/bids/${i}`,
    description: i < 12 ? "City bid opportunity. See portal." : "Request for proposal for janitorial services.",
    postedDate: new Date().toISOString(),
  }));

  before(() => {
    mock.method(websearchProvider, "isConfigured", async () => true);
    mock.method(websearchProvider, "fetch", async () => ({ records: hits, errors: [] }));
    mock.method(jinaProvider, "isConfigured", async () => true);
    mock.method(jinaProvider, "extractUrl", async (url: string) => {
      extracted.push(url);
      return `Request for proposal for annual pre-employment physical examinations and audiometric testing for city employees. ${"Scope detail. ".repeat(80)}`;
    });
    for (const provider of [keenableProvider, browserbaseProvider, firecrawlProvider, microlinkProvider]) {
      mock.method(provider, "isConfigured", async () => false);
    }
  });
  after(() => mock.restoreAll());

  it("fetches at most ENRICHMENT_MAX_URLS pages, prefers review-band hits, and accounts for skips", async () => {
    const result = await webIntelligenceFetch({
      discoveryQueries: ["occupational health rfp"],
      useWebsearch: true,
      useRssAggregator: false,
    });
    assert.ok(extracted.length <= 10, `enriched ${extracted.length}`);
    assert.ok(extracted.length > 0, "review-band hits were enriched");
    assert.ok(result.stats.reviewBandKept >= 10);
    const skipped = Object.values(result.stats.skippedByReason).reduce((a, b) => a + b, 0);
    assert.equal(result.stats.preFiltered + skipped, result.stats.totalCandidates);
    for (const opp of result.opportunities) {
      assert.ok(!/services$/i.test(opp.agency) || opp.agency === "Unknown Organization", `agency invented: ${opp.agency}`);
    }
    assert.ok(result.opportunities.length > 0, "enriched review-band hits produced opportunities");
    assert.ok(
      result.opportunities.some((o) => (o.description ?? "").length > 600),
      "fetched page text is kept beyond 600 characters",
    );
  });
});
