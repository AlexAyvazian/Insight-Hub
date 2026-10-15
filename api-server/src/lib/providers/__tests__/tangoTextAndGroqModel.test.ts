import assert from "node:assert/strict";
import test from "node:test";

process.env.RFP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.INTEL_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.AUTH_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.APP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const [{ tangoText }, { groqRequestBody }] = await Promise.all([import("../tango"), import("../groq")]);

test("Tango text fields accept strings, numbers and {code, description} objects", () => {
  assert.equal(tangoText("  15B41427Q00000002 "), "15B41427Q00000002");
  assert.equal(tangoText(541611), "541611");
  assert.equal(tangoText({ code: "SBA", description: "Small Business Set-Aside" }), "Small Business Set-Aside");
  assert.equal(tangoText({ code: "8A" }), "8A");
});

test("Tango text fields that carry nothing usable become undefined, never a non-string", () => {
  assert.equal(tangoText(""), undefined);
  assert.equal(tangoText("   "), undefined);
  assert.equal(tangoText(null), undefined);
  assert.equal(tangoText({}), undefined);
  assert.equal(tangoText(["a"]), undefined);
});

test("Groq gpt-oss requests get low reasoning effort and token headroom so short answers are not empty", () => {
  const body = groqRequestBody("openai/gpt-oss-20b", "hi", 200);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.max_tokens, 600);
  assert.equal(body.model, "openai/gpt-oss-20b");
});

test("Groq non-reasoning models are sent unchanged", () => {
  const body = groqRequestBody("some-other-model", "hi", 200);
  assert.equal("reasoning_effort" in body, false);
  assert.equal(body.max_tokens, 200);
});
