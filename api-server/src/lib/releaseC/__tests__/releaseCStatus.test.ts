/**
 * Release C operator status: the read-only status and credential endpoints report real state without key material
 * or URL credentials, and the slot probe uses only free usage/balance endpoints.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it, mock } from "node:test";
import express from "express";
import { FreeTierCredentialPool } from "../../providers/freeTierCredentialPool";

describe("credential slot probe", () => {
  it("reports configured, missing and duplicate slots and redacts the key from probe errors", async () => {
    process.env.STATUS_TEST_KEY_A = "key-aaaaaaaaaaaaaaaa";
    process.env.STATUS_TEST_KEY_B = "key-aaaaaaaaaaaaaaaa";
    delete process.env.STATUS_TEST_KEY_C;
    process.env.STATUS_TEST_KEY_D = "key-dddddddddddddddd";
    const pool = new FreeTierCredentialPool("status-test-pool", [
      { envKey: "STATUS_TEST_KEY_A" },
      { envKey: "STATUS_TEST_KEY_B" },
      { envKey: "STATUS_TEST_KEY_C" },
      { envKey: "STATUS_TEST_KEY_D" },
    ]);
    const probed: string[] = [];
    const result = await pool.probeSlots(async (apiKey, slot) => {
      probed.push(slot);
      if (slot === "STATUS_TEST_KEY_D") throw new Error(`denied for ${apiKey}`);
      return { limit: 100, remaining: 60, usedToday: 40, source: "test" };
    });
    assert.deepEqual(probed, ["STATUS_TEST_KEY_A", "STATUS_TEST_KEY_D"]);
    assert.equal(result[0]!.ok, true);
    assert.equal(result[0]!.remaining, 60);
    assert.equal(result[1]!.duplicateOf, "STATUS_TEST_KEY_A");
    assert.equal(result[1]!.ok, null);
    assert.equal(result[2]!.configured, false);
    assert.equal(result[3]!.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /key-aaaa|key-dddd/);
  });
});

describe("Release C status endpoints", () => {
  let server: ReturnType<express.Express["listen"]>;
  let base = "";
  const realFetch = globalThis.fetch;

  before(async () => {
    const { default: router } = await import("../../../routes/release-c-status");
    const app = express();
    app.use("/api", router);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  after(() => {
    server?.close();
    mock.restoreAll();
  });

  it("returns document, queue and usage state with URL credentials stripped", async () => {
    const { rcPool } = await import("../db");
    const { ensureReleaseCSchema } = await import("../schema");
    await ensureReleaseCSchema();
    const id = `status-doc-${Date.now()}`;
    await (await rcPool()).query(
      `INSERT INTO opportunity_documents (id, opportunity_key, source_url, retrieval_status, retrieval_error, extraction_status, extraction_method, page_count, extracted_page_count)
       VALUES ($1, 'status-test', 'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/abc/download?api_key=SECRETKEY123', 'fetched',
               'failed https://sam.gov/x?api_key=SECRETKEY123', 'partial', 'pdfjs+capped', 30, 20)`,
      [id],
    );
    const response = await realFetch(`${base}/release-c/status`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /SECRETKEY123|api_key=/);
    const body = JSON.parse(text);
    assert.ok(body.flags);
    assert.ok(body.documentWorker);
    const recent = body.documents.recent.find((d: { id: string }) => d.id === id);
    assert.equal(recent.source_url, "sam.gov/api/prod/opps/v3/opportunities/resources/files/abc/download");
    assert.ok(body.documents.byStatus.some((s: { extraction_status: string; method: string }) => s.extraction_status === "partial" && s.method === "pdfjs+capped"));
    assert.ok(Array.isArray(body.accountUsage));
    assert.equal(typeof body.reviewQueue.dueNow, "number");
    await (await rcPool()).query(`DELETE FROM opportunity_documents WHERE id = $1`, [id]);
  });

  it("probes credentials through free endpoints and never returns key material", async () => {
    process.env.LLMWHISPERER_API_KEY = "whisper-key-one-0000";
    process.env.LLMWHISPERER_API_KEY_2 = "whisper-key-two-0000";
    process.env.NUTRIENT_API_KEY = "nutrient-key-0000000";
    process.env.LINKUP_API_KEY = "linkup-key-one-00000";
    process.env.LINKUP_API_KEY_2 = "linkup-key-two-00000";
    const calls: Array<{ url: string; method: string }> = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(base)) return realFetch(input, init);
      calls.push({ url, method: init?.method ?? "GET" });
      const auth = JSON.stringify(init?.headers ?? {});
      if (url.includes("get-usage-info")) {
        if (auth.includes("whisper-key-two")) return new Response("denied", { status: 401 });
        return Response.json({ daily_quota: 100, today_page_count: 12, subscription_plan: "free" });
      }
      if (url.includes("account/info")) {
        return Response.json({ subscriptionType: "free", apiKeys: { live: "nutrient-key-0000000" }, usage: { totalCredits: 5000, usedCredits: 15 } });
      }
      if (url.includes("credits/balance")) return Response.json({ balance: 4.5 });
      return new Response("unexpected", { status: 500 });
    });
    const response = await realFetch(`${base}/release-c/credentials?refresh=1`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /whisper-key|nutrient-key|linkup-key/);
    const body = JSON.parse(text);
    assert.equal(body.llmwhisperer[0].ok, true);
    assert.equal(body.llmwhisperer[0].remaining, 88);
    assert.equal(body.llmwhisperer[1].ok, false);
    assert.equal(body.nutrient[0].ok, true);
    assert.equal(body.nutrient[0].account.plan, "free");
    assert.equal(body.nutrient[0].account.credits["usage.usedCredits"], 15);
    assert.equal(body.linkup.length, 2);
    assert.ok(body.linkup.every((slot: { ok: boolean }) => slot.ok === true));
    assert.ok(calls.every((call) => call.method === "GET"), "probes must not submit work");

    // A forced refresh right after a probe, and concurrent refreshes, never start another probe round.
    const before = calls.length;
    const again = await Promise.all([1, 2, 3].map(() => realFetch(`${base}/release-c/credentials?refresh=1`).then((r) => r.json())));
    assert.ok(again.every((r: { cached: boolean }) => r.cached === true));
    assert.equal(calls.length, before);
  });
});
