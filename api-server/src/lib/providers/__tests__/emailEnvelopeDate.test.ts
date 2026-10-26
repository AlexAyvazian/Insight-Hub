import assert from "node:assert/strict";
import { test } from "node:test";
import { emailEnvelopeDate } from "../emailNotifications";

test("IMAP notification dates preserve the timestamp for Date and string envelopes", () => {
  const expected = new Date("2026-10-25T17:00:00.000Z");
  assert.equal(emailEnvelopeDate(expected), expected);
  assert.equal(emailEnvelopeDate("Sun, 25 Oct 2026 10:00:00 -0700").toISOString(), expected.toISOString());
});

test("missing and malformed IMAP dates use the received-time fallback", () => {
  const fallback = new Date("2026-10-25T18:00:00.000Z");
  for (const value of [undefined, "", "not a date", new Date(NaN)]) {
    assert.equal(emailEnvelopeDate(value, fallback), fallback);
  }
});
