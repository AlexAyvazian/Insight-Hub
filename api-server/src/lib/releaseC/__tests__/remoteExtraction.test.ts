/**
 * Codex review regressions for remote extraction: an accepted LLMWhisperer job is resumed, never resubmitted to
 * another account or to Nutrient; Nutrient reserves credits for every uploaded page; malformed attachment URLs do
 * not break discovery.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AccountLedger, MemoryLedgerStore, setSharedAccountLedgerForTests } from "../../providers/accountLedger";
import { clearFreeTierCredentialPoolState } from "../../providers/freeTierCredentialPool";
import { AcceptedJobError, UNKNOWN_PAGE_COUNT_CAP, acceptedJobError, clearPendingWhisperJobs, extractRemotely, nutrientPlannedCredits } from "../../documents/remoteExtractors";
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
  it("resumes an accepted LLMWhisperer job (even after a restart) instead of resubmitting it elsewhere", async () => {
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
    const request = { bytes: new TextEncoder().encode(`doc-${Date.now()}-${Math.random()}`), fileName: "a.pdf", pages: [1], pageCount: 1, scanned: true };

    const before = Date.now();
    const rejection = await extractRemotely(request).then(() => null, (error: unknown) => error);
    assert.ok(rejection instanceof AcceptedJobError);
    assert.ok(rejection.submittedAt >= before && rejection.submittedAt <= Date.now(), "carries when the job was accepted");
    assert.equal(acceptedJobError(new Error("wrapped", { cause: rejection })), rejection, "found behind a wrapping error");
    assert.equal(calls.filter((c) => c.endsWith(":whisper")).length, 1, "submitted once");
    assert.ok(!calls.some((c) => c.startsWith("whisper-second")), "second account not used");
    assert.ok(!calls.some((c) => c.startsWith("nutrient")), "Nutrient fallback not used");

    statusFails = false;
    calls.length = 0;
    clearPendingWhisperJobs(); // simulates a worker restart: only the persisted job remains
    const result = await extractRemotely(request);
    assert.equal(result.provider, "llmwhisperer");
    assert.equal(calls.filter((c) => c.endsWith(":whisper")).length, 0, "resumed without resubmitting");
    assert.match(result.pages[0]!.text, /Page one/);
  });

  it("flags an unknown-length document cut off at the page cap", async () => {
    process.env.LLMWHISPERER_API_KEY = "whisper-primary-key-000000";
    setSharedAccountLedgerForTests(new AccountLedger(new MemoryLedgerStore()));
    let pageTotal = UNKNOWN_PAGE_COUNT_CAP;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname.split("/").pop()!;
      if (path === "get-usage-info") return Response.json({ daily_quota: 100, today_page_count: 0 });
      if (path === "whisper") return new Response(JSON.stringify({ whisper_hash: `hash-${pageTotal}` }), { status: 202 });
      if (path === "whisper-status") return Response.json({ status: "processed" });
      if (path === "whisper-retrieve") {
        return new Response(Array.from({ length: pageTotal }, (_v, i) => `Page ${i + 1} text long enough to count.`).join("<<<INSIGHT_HUB_PAGE_BREAK>>>"));
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const request = (tag: string) => ({ bytes: new TextEncoder().encode(`legacy-${tag}-${Math.random()}`), fileName: "a.doc", pages: null, pageCount: null, scanned: false });

    const capped = await extractRemotely(request("long"));
    assert.equal(capped.pages.length, UNKNOWN_PAGE_COUNT_CAP);
    assert.equal(capped.capped, true, "reaching the cap does not prove the document ended");

    pageTotal = 3;
    const short = await extractRemotely(request("short"));
    assert.equal(short.capped, false, "a document that ends before the cap is complete");
  });

  it("reserves Nutrient credits for the whole uploaded document", () => {
    assert.equal(nutrientPlannedCredits({ pageCount: 100, pages: [7], scanned: true }), 150);
    assert.equal(nutrientPlannedCredits({ pageCount: null, pages: null, scanned: false }), 20, "unknown page count plans the conservative cap");
  });

  it("never sends a document with an unknown page count to Nutrient", async () => {
    process.env.NUTRIENT_API_KEY = "nutrient-key-0000000000000";
    setSharedAccountLedgerForTests(new AccountLedger(new MemoryLedgerStore()));
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const request = { bytes: new TextEncoder().encode("legacy-doc"), fileName: "a.doc", pages: null, pageCount: null, scanned: true };
    await assert.rejects(extractRemotely(request), /page count unknown/);
    assert.equal(calls, 0);
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

  it("resolves relative document links against the notice URL", () => {
    const record = {
      externalId: "y",
      title: "Exams",
      agency: "City",
      type: "Solicitation",
      status: "active",
      source: "web",
      sourceUrl: "https://city.example.gov/bids/42/view",
      description: '<a href="/documents/specification.pdf">Specification</a> <a href="addendum-1.pdf">Addendum 1</a>',
      rawData: {},
    } as unknown as NormalizedOpportunity;
    const urls = discoverAttachments(record).map((a) => a.url);
    assert.ok(urls.includes("https://city.example.gov/documents/specification.pdf"), urls.join(" "));
    assert.ok(urls.includes("https://city.example.gov/bids/42/addendum-1.pdf"), urls.join(" "));
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

describe("judgment hash document identities", () => {
  it("changes the document identities as soon as a new attachment is listed, before it is fetched", async () => {
    const { loadDocumentContext } = await import("../documentEvidence");
    const { releaseCFlags } = await import("../flags");
    const flags = { ...releaseCFlags({}), documentPipeline: true };
    const key = `rc-hash-${Date.now()}`;
    const record = (urls: string[]) =>
      ({
        externalId: key,
        title: "Exams",
        agency: "City",
        type: "Solicitation",
        status: "active",
        source: "web",
        sourceUrl: "https://city.example.gov/bids/7",
        rawData: { attachments: urls.map((url) => ({ url })) },
      }) as unknown as NormalizedOpportunity;
    const before = await loadDocumentContext(record(["https://city.example.gov/files/sow.pdf"]), key, flags);
    const after = await loadDocumentContext(
      record(["https://city.example.gov/files/sow.pdf", "https://city.example.gov/files/amendment-1.pdf"]),
      key,
      flags,
    );
    assert.equal(before.error, null);
    assert.ok(before.documentHashes.length >= 1);
    assert.equal(after.documentHashes.length, before.documentHashes.length + 1, "the unfetched amendment counts");
    assert.notDeepEqual([...after.documentHashes].sort(), [...before.documentHashes].sort());
  });
});

describe("withdrawn attachments", () => {
  it("retires documents an authoritative notice no longer lists and restores them when relisted", async () => {
    const { registerAttachments, documentsFor } = await import("../../documents/store");
    const key = `rc-withdraw-${Date.now()}`;
    const ref = (url: string) => ({ url, title: null, role: "attachment" as const, sourceVersion: null, amendedAt: null });
    const sow = "https://example.gov/files/sow.pdf";
    const pws = "https://example.gov/files/pws.pdf";
    await registerAttachments(key, [ref(sow), ref(pws)], 1, { authoritative: true });
    assert.equal((await documentsFor(key)).length, 2);

    // A record without an explicit attachment list says nothing about withdrawals.
    await registerAttachments(key, [], 1);
    assert.equal((await documentsFor(key)).length, 2);

    // The amended notice lists no attachments at all.
    const result = await registerAttachments(key, [], 1, { authoritative: true });
    assert.equal(result.withdrawn, 2);
    assert.equal((await documentsFor(key)).length, 0);

    await registerAttachments(key, [ref(sow)], 1, { authoritative: true });
    const current = await documentsFor(key);
    assert.deepEqual(current.map((d) => d.sourceUrl), [sow], "the relisted attachment is restored, not duplicated");
    assert.equal(current[0]!.retrievalStatus, "recheck", "its earlier text is not evidence until it is re-checked");
    const { rcPool } = await import("../db");
    const job = await (await rcPool()).query(`SELECT status, next_attempt_at <= now() AS due FROM document_extraction_jobs WHERE document_id = $1`, [current[0]!.id]);
    assert.equal(job.rows[0]?.status, "queued");
    assert.equal(job.rows[0]?.due, true, "the re-check is due now");
  });
});

describe("SAM.gov notice description", () => {
  it("accepts the HAL JSON that noticedesc returns and extracts its HTML description", async () => {
    const { ALLOWED_TYPES, samDescription } = await import("../../documents/worker");
    assert.ok(ALLOWED_TYPES.some((type) => "application/hal+json".startsWith(type)));
    const body = new TextEncoder().encode(JSON.stringify({ description: "<p>Provide <b>pre-employment physicals</b> and DOT exams.</p>", _links: {} }));
    const parsed = samDescription(body, "application/hal+json");
    assert.equal(parsed?.method, "sam-noticedesc");
    assert.match(parsed!.pages[0]!.text, /pre-employment physicals and DOT exams/);
  });
});
