/**
 * Codex review regressions for remote extraction: an accepted LLMWhisperer job is resumed, never resubmitted to
 * another account or to Nutrient; Nutrient reserves credits for every uploaded page; malformed attachment URLs do
 * not break discovery.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AccountLedger, MemoryLedgerStore, setSharedAccountLedgerForTests } from "../../providers/accountLedger";
import { clearFreeTierCredentialPoolState } from "../../providers/freeTierCredentialPool";
import { AcceptedJobError, clearPendingWhisperJobs, extractRemotely, nutrientPlannedCredits } from "../../documents/remoteExtractors";
import { discoverAttachments } from "../../documents/attachments";
import type { NormalizedOpportunity } from "../../providers/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setSharedAccountLedgerForTests(null);
  clearPendingWhisperJobs();
  clearFreeTierCredentialPoolState();
  delete process.env.LLMWHISPERER_API_KEY;
  delete process.env.LLMWHISPERER_API_KEY_2;
  delete process.env.NUTRIENT_API_KEY;
});

describe("remote extraction accounting", () => {
  it("resumes an accepted LLMWhisperer job instead of resubmitting it elsewhere", async () => {
    process.env.LLMWHISPERER_API_KEY = "whisper-primary-key-000000";
    process.env.LLMWHISPERER_API_KEY_2 = "whisper-second-key-0000000";
    process.env.NUTRIENT_API_KEY = "nutrient-key-0000000000000";
    setSharedAccountLedgerForTests(new AccountLedger(new MemoryLedgerStore()));
    const calls: string[] = [];
    let statusFails = true;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const key = new Headers(init?.headers).get("unstract-key") ?? "nutrient";
      const path = new URL(url).pathname.split("/").pop()!;
      calls.push(`${key.slice(0, 14)}:${path}`);
      if (path === "get-usage-info") return Response.json({ daily_quota: 100, today_page_count: 0 });
      if (path === "whisper") return new Response(JSON.stringify({ whisper_hash: "hash-1" }), { status: 202 });
      if (path === "whisper-status") return statusFails ? new Response("upstream timeout", { status: 503 }) : Response.json({ status: "processed" });
      if (path === "whisper-retrieve") return new Response("Page one text that is long enough to be good quality output.");
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const request = { bytes: new Uint8Array([1, 2, 3]), fileName: "a.pdf", pages: [1], pageCount: 1, scanned: true };

    await assert.rejects(extractRemotely(request), AcceptedJobError);
    assert.equal(calls.filter((c) => c.endsWith(":whisper")).length, 1, "submitted once");
    assert.ok(!calls.some((c) => c.startsWith("whisper-second")), "second account not used");
    assert.ok(!calls.some((c) => c.startsWith("nutrient")), "Nutrient fallback not used");

    statusFails = false;
    calls.length = 0;
    const result = await extractRemotely(request);
    assert.equal(result.provider, "llmwhisperer");
    assert.equal(calls.filter((c) => c.endsWith(":whisper")).length, 0, "resumed without resubmitting");
    assert.match(result.pages[0]!.text, /Page one/);
  });

  it("reserves Nutrient credits for the whole uploaded document", () => {
    assert.equal(nutrientPlannedCredits({ pageCount: 100, pages: [7], scanned: true }), 150);
    assert.equal(nutrientPlannedCredits({ pageCount: null, pages: null, scanned: false }), 1);
  });

  it("keeps valid attachments when one URL has a malformed percent escape", () => {
    const record = {
      externalId: "x",
      title: "Exams",
      agency: "City",
      type: "Solicitation",
      status: "active",
      source: "web",
      sourceUrl: "https://city.example.gov/bids/1",
      rawData: { attachments: [{ url: "https://city.example.gov/files/scope%ZZ.pdf" }, { url: "https://city.example.gov/files/sow.pdf" }] },
    } as unknown as NormalizedOpportunity;
    const urls = discoverAttachments(record).map((a) => a.url);
    assert.ok(urls.some((u) => u.endsWith("sow.pdf")));
  });
});

describe("document versions", () => {
  it("reuses the earlier version row when content reverts (A -> B -> A)", async () => {
    const { registerAttachments, documentsFor, recordDocumentVersion } = await import("../../documents/store");
    const key = `rc-test-${Date.now()}`;
    const url = "https://example.gov/files/sow.pdf";
    await registerAttachments(key, [{ url, title: "SOW", role: "sow", sourceVersion: null, amendedAt: null }], 1);
    let [doc] = await documentsFor(key);
    const a = await recordDocumentVersion(doc!, "a".repeat(64), { extraction_status: "extracted" });
    [doc] = await documentsFor(key);
    const b = await recordDocumentVersion(doc!, "b".repeat(64), { extraction_status: "extracted" });
    assert.notEqual(b.documentId, a.documentId);
    [doc] = await documentsFor(key);
    const back = await recordDocumentVersion(doc!, "a".repeat(64), { extraction_status: "extracted" });
    assert.equal(back.documentId, a.documentId, "the original row is reactivated");
    const current = await documentsFor(key);
    assert.equal(current.length, 1);
    assert.equal(current[0]!.id, a.documentId);
  });
});
