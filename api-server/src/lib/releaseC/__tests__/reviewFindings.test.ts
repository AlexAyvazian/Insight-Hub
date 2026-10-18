/**
 * CodeRabbit review regressions: concurrent quota reservations, unknown page-count caps, account cooldown only on
 * account-level errors, SAM resource links with api_key=null, and DOCX pagination on explicit breaks only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { AccountLedger, MemoryLedgerStore, isAccountLevelError, type AccountPolicy } from "../../providers/accountLedger";
import { UNKNOWN_PAGE_COUNT_CAP, nutrientPlannedCredits, whisperPlannedPages } from "../../documents/remoteExtractors";
import { withSamKey } from "../../documents/worker";
import { parseDocx } from "../../documents/parsers";
import { FreeTierCredentialPool } from "../../providers/freeTierCredentialPool";
import { linkupBalance } from "../../providers/linkup";

const policy: AccountPolicy = {
  pool: "test-pool",
  slot: "primary",
  provider: "test",
  allowanceKind: "recurring_daily",
  unit: "pages",
  periodLimit: 10,
  safetyFraction: 1,
  overageBillable: true,
};

describe("quota reservations", () => {
  it("lets only as many concurrent callers through as the allowance covers", async () => {
    const ledger = new AccountLedger(new MemoryLedgerStore());
    const decisions = await Promise.all(Array.from({ length: 5 }, () => ledger.reserve(policy, 4, false)));
    assert.equal(decisions.filter((d) => d.ok).length, 2, "10 pages cover two 4-page reservations");
    for (const d of decisions) d.release();
    assert.equal((await ledger.reserve(policy, 4, false)).ok, true, "released reservations free capacity");
  });
});

describe("account cooldown", () => {
  it("cools an account down only for account-level errors", async () => {
    assert.equal(isAccountLevelError("HTTP 503 upstream"), true);
    assert.equal(isAccountLevelError("connect ECONNREFUSED"), true);
    assert.equal(isAccountLevelError("HTTP 400 bad request: unsupported file"), false);
    assert.equal(isAccountLevelError("The operation was aborted due to timeout"), false);
    const ledger = new AccountLedger(new MemoryLedgerStore());
    const state = await ledger.recordFailure(policy, new Error("HTTP 400 bad request"));
    assert.equal(state.cooldownUntil ?? null, null);
    assert.ok((await ledger.recordFailure(policy, new Error("HTTP 502 bad gateway"))).cooldownUntil);
  });
});

describe("unknown page counts", () => {
  it("caps LLMWhisperer and Nutrient plans when the page count is unknown", () => {
    assert.deepEqual(whisperPlannedPages({ pages: null, pageCount: null }), { pages: UNKNOWN_PAGE_COUNT_CAP, spec: "1-20" });
    assert.deepEqual(whisperPlannedPages({ pages: null, pageCount: 7 }), { pages: 7, spec: null });
    assert.equal(nutrientPlannedCredits({ pages: null, pageCount: null, scanned: false }) >= UNKNOWN_PAGE_COUNT_CAP, true);
  });
});

describe("SAM.gov resource links", () => {
  it("replaces a missing, empty or null api_key and keeps a real one", () => {
    const base = "https://sam.gov/api/prod/opps/v3/opportunities/resources/files/abc/download";
    for (const url of [base, `${base}?api_key=`, `${base}?api_key=null`]) {
      assert.equal(new URL(withSamKey(url, "KEY")).searchParams.get("api_key"), "KEY", url);
    }
    assert.equal(new URL(withSamKey(`${base}?api_key=existing`, "KEY")).searchParams.get("api_key"), "existing");
  });
});

describe("DOCX pagination", () => {
  it("splits pages on explicit breaks only and keeps text on both sides of a mid-paragraph break", () => {
    const xml =
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>Page one intro</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Before break</w:t><w:br w:type="page"/><w:t>After break</w:t></w:r></w:p>' +
      '<w:p><w:r><w:lastRenderedPageBreak/><w:t>Still page two</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const parsed = parseDocx(zipSync({ "word/document.xml": strToU8(xml) }));
    assert.equal(parsed.pages.length, 2);
    assert.match(parsed.pages[0]!.text, /Page one intro[\s\S]*Before break/);
    assert.doesNotMatch(parsed.pages[0]!.text, /After break/);
    assert.match(parsed.pages[1]!.text, /After break[\s\S]*Still page two/);
  });
});

describe("required capacity probes", () => {
  it("skips an account whose required probe fails instead of trusting stale capacity", async () => {
    process.env.RC_PROBE_KEY_1 = "probe-key-one-000000";
    const ledger = new AccountLedger(new MemoryLedgerStore());
    const accountPolicy = (slot: string): AccountPolicy => ({ ...policy, pool: "rc-probe", slot, periodLimit: 100 });
    // The account had room when last confirmed.
    await ledger.recordSnapshot(accountPolicy("RC_PROBE_KEY_1"), { remaining: 100, source: "probe" });
    const pool = new FreeTierCredentialPool("rc-probe", [{ envKey: "RC_PROBE_KEY_1" }], {
      accounts: {
        ledger,
        policyFor: accountPolicy,
        probe: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
        probeBeforeEachRun: true,
      },
    });
    let called = false;
    await assert.rejects(
      pool.run(async () => {
        called = true;
        return "billable";
      }),
    );
    assert.equal(called, false, "no billable call after a failed required probe");
    delete process.env.RC_PROBE_KEY_1;
  });
});

describe("Linkup balance probe", () => {
  it("fails the probe when the balance is missing or not a number", async () => {
    const realFetch = globalThis.fetch;
    try {
      for (const body of [{}, { balance: null }, { balance: "lots" }]) {
        globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
        await assert.rejects(linkupBalance("linkup-key-000000000"), /no numeric balance/, JSON.stringify(body));
      }
      globalThis.fetch = (async () => Response.json({ balance: 4.5 })) as typeof fetch;
      const snapshot = await linkupBalance("linkup-key-000000000");
      const remaining = snapshot.remaining ?? 0;
      assert.ok(remaining > 0 && remaining < 4.5, String(snapshot.remaining));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
