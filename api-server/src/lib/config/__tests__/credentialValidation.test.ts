import assert from "node:assert/strict";
import test from "node:test";

process.env.RFP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.INTEL_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.AUTH_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.APP_DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const { findInvalidCredentialCharacter } = await import("../providerConfig");

test("a clean API key has no invalid character", () => {
  assert.equal(findInvalidCredentialCharacter("AIzaSyBJ85ZN6tlDwVTQmrYENj6FOH7U4Chu0o8"), null);
  assert.equal(findInvalidCredentialCharacter("cfut_AbC-123_xyz"), null);
});

test("a Cyrillic look-alike letter is reported with its position and code point", () => {
  // First letter is U+0410 CYRILLIC CAPITAL LETTER A, not the Latin "A".
  const found = findInvalidCredentialCharacter("АIzaSyD");
  assert.deepEqual(found, { index: 0, codePoint: "U+0410" });
});

test("a stray character later in the key and control characters are caught", () => {
  assert.deepEqual(findInvalidCredentialCharacter("AIzaSyD×_x"), { index: 7, codePoint: "U+00D7" });
  assert.deepEqual(findInvalidCredentialCharacter("abc\ndef"), { index: 3, codePoint: "U+000A" });
});
