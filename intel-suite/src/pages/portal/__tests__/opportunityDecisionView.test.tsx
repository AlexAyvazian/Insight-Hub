import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  citationDocument,
  citationPages,
  displayStateCounts,
  documentInventoryLine,
  opportunityDisplayState,
  providerStatusSummary,
} from "../../../components/opportunities/opportunityDecision";
import { OpportunityEvidenceView } from "../../../components/opportunities/OpportunityEvidencePanel";
import { OpportunityStateFilter } from "../../../components/opportunities/OpportunityDecisionState";
import { ProviderStatusChip } from "../../../components/opportunities/ProviderStatusIndicator";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const future = "2026-11-30T00:00:00Z";

function stored(state: string, extra: Record<string, unknown> = {}) {
  return {
    source: "stored", state, decisionVersion: 3, decidedAt: "2026-10-18T09:00:00Z", method: "ai-panel",
    holdCode: null, score: 82, reason: "Annual DOT physicals for the fleet workforce.", citations: [],
    current: true, stale: false, staleReason: null, authoritative: true, readTimeConflict: null, ...extra,
  };
}

describe("Opportunity decision state", () => {
  it("prefers the stored decision state", () => {
    for (const state of ["qualified", "needs_review", "provisional", "out_of_scope"]) {
      assert.equal(opportunityDisplayState({ responseDeadline: future, decision: stored(state) }, NOW), state);
    }
  });

  it("is closed past the deadline or when cancelled/archived, whatever the decision says", () => {
    assert.equal(opportunityDisplayState({ responseDeadline: "2026-10-01T00:00:00Z", decision: stored("qualified") }, NOW), "closed");
    assert.equal(opportunityDisplayState({ status: "archived", decision: stored("qualified") }, NOW), "closed");
    assert.equal(opportunityDisplayState({ status: "cancelled" }, NOW), "closed");
    assert.equal(opportunityDisplayState({ decision: stored("closed") }, NOW), "closed");
  });

  it("falls back to the listing classification when no decision is stored", () => {
    const none = { source: "none", state: null };
    assert.equal(opportunityDisplayState({ quality: { classification: "verified-open" }, relevance: { verdict: "accept" } }, NOW), "qualified");
    assert.equal(opportunityDisplayState({ decision: none, quality: { classification: "verified-open" }, relevance: { verdict: "review" } }, NOW), "needs_review");
    assert.equal(opportunityDisplayState({ quality: { classification: "discovery-only" } }, NOW), "provisional");
    assert.equal(opportunityDisplayState({ relevance: { verdict: "reject" } }, NOW), "out_of_scope");
    assert.equal(opportunityDisplayState({}, NOW), "needs_review");
    assert.equal(opportunityDisplayState({ quality: { classification: "closed" } }, NOW), "closed");
  });

  it("counts states and renders filter chips", () => {
    const counts = displayStateCounts([
      { decision: stored("qualified") },
      { decision: stored("qualified") },
      { status: "archived" },
    ], NOW);
    assert.equal(counts.qualified, 2);
    assert.equal(counts.closed, 1);
    let picked: string | null = "unset";
    const element = OpportunityStateFilter({ value: null, counts, onChange: (value) => { picked = value; } });
    const html = renderToStaticMarkup(element);
    assert.match(html, /Qualified/);
    assert.match(html, /Needs Review/);
    assert.match(html, /Out of Scope/);
    const buttons = React.Children.toArray((element.props as any).children).filter((child: any) => child?.type === "button") as any[];
    buttons[1].props.onClick();
    assert.equal(picked, "qualified");
  });
});

describe("Opportunity evidence view", () => {
  it("parses citation page numbers from section labels", () => {
    assert.equal(citationPages("[Statement of Work.pdf, p.4-5, Scope]"), "4-5");
    assert.equal(citationPages("[RFP, p.12]"), "12");
    assert.equal(citationPages("notice"), null);
    assert.equal(citationDocument("[Statement of Work.pdf, p.4-5, Scope]"), "Statement of Work.pdf");
    assert.equal(citationDocument("notice"), "Notice");
    assert.equal(citationDocument(null), "Notice");
  });

  it("never reports an inventory as complete while documents are unread", () => {
    assert.match(documentInventoryLine({ summary: { listed: 3, read: 1, unread: 2, withdrawn: 0 } }), /1 of 3 documents read · 2 unread/);
    assert.equal(documentInventoryLine({ summary: { listed: 0 } }), "No attachments listed for this notice.");
  });

  it("renders reasoning, cited pages, documents, versions and freshness", () => {
    const opp = {
      id: "o1", providerName: "samGov", samUrl: "https://sam.gov/opp/abc/view", responseDeadline: future,
      updatedAt: "2026-10-18T10:00:00Z",
      decision: stored("needs_review", {
        holdCode: "structured_document_pending", stale: true, staleReason: "notice_changed",
        primaryScope: { evidenced: true, terms: ["DOT physicals"], kind: "service", hold: null, source: "documents" },
        citations: [{ section: "[Statement of Work.pdf, p.7, Scope]", quote: "contractor shall perform DOT physical examinations", sectionId: "s1" }],
      }),
    };
    const html = renderToStaticMarkup(
      <OpportunityEvidenceView
        opp={opp}
        now={NOW}
        versions={{ status: "ready", data: { amendments: 1, versions: [
          { id: "v2", releaseTag: "amendment", changedFields: ["deadline"], observedAt: "2026-10-10T00:00:00Z" },
          { id: "v1", releaseTag: "tender", changedFields: [], observedAt: "2026-10-01T00:00:00Z" },
        ] } }}
        documents={{ status: "ready", data: {
          documents: [
            { id: "d1", title: "Statement of Work.pdf", state: "read", pages: 10, pagesRead: 10 },
            { id: "d2", title: "Pricing.xlsx", state: "deferred" },
          ],
          summary: { listed: 2, read: 1, unread: 1, withdrawn: 0, complete: false },
        } }}
      />,
    );
    assert.match(html, /Needs Review/);
    assert.match(html, /Hold: Structured document pending/);
    assert.match(html, /Annual DOT physicals/);
    assert.match(html, /Primary purchased scope:.*DOT physicals/);
    assert.match(html, /Statement of Work\.pdf · p\.7/);
    assert.match(html, /1 unread document/);
    assert.match(html, /Deferred/);
    assert.match(html, /Amendment/);
    assert.match(html, /changed Deadline/);
    assert.match(html, /SAM\.gov/);
    assert.match(html, /Decision is stale \(Notice changed\)/);
  });

  it("degrades gracefully for an older record without a decision or evidence", () => {
    const html = renderToStaticMarkup(
      <OpportunityEvidenceView
        opp={{ id: "o2", quality: { classification: "discovery-only", reasons: ["Search result only."] } }}
        now={NOW}
        versions={{ status: "error" }}
        documents={{ status: "loading" }}
      />,
    );
    assert.match(html, /Provisional/);
    assert.match(html, /No stored decision yet/);
    assert.match(html, /Search result only\./);
    assert.match(html, /No verified citations on record/);
    assert.match(html, /Version history unavailable/);
    assert.match(html, /Not yet decided/);
  });
});

describe("Provider status indicator", () => {
  it("summarizes accounts and purpose budgets, and is absent without data", () => {
    assert.equal(providerStatusSummary(null), null);
    assert.equal(providerStatusSummary({ accountUsage: [], orchestration: { purposeBudgets: [] } }), null);
    const summary = providerStatusSummary({
      accountUsage: [
        { pool: "search", slot: "a", provider: "exa", exhausted: false },
        { pool: "search", slot: "b", provider: "exa", exhausted: true },
      ],
      orchestration: { purposeBudgets: [
        { purpose: "search", calls: 10, limit: 100, remaining: 90 },
        { purpose: "ocr", calls: 5, limit: 5, remaining: 0 },
      ] },
    }, NOW)!;
    assert.equal(summary.accounts, 2);
    assert.equal(summary.exhausted, 1);
    assert.equal(summary.tone, "bad");
    const html = renderToStaticMarkup(<ProviderStatusChip summary={summary} />);
    assert.match(html, /1\/2 accounts available/);
    assert.match(html, /budget spent: OCR/);
  });
});
