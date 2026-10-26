import assert from "node:assert/strict";
import { test } from "node:test";
import { zodResolver } from "@hookform/resolvers/zod";
import { settingsFormSchema } from "../settings-form";

const resolve = zodResolver(settingsFormSchema);
const options = { fields: {}, shouldUseNativeValidation: false };

test("settings validation returns field errors instead of rejecting on Zod 4", async () => {
  const result = await resolve({ organizationName: "A", defaultDateRange: "0" }, undefined, options);
  assert.equal(result.errors.organizationName?.message, "Organization name is required");
  assert.ok(result.errors.defaultDateRange?.message);
  assert.deepEqual(result.values, {});
});

test("settings validation converts the number input and preserves optional defaults", async () => {
  const result = await resolve({ organizationName: "Alex", defaultDateRange: "30" }, undefined, options);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.values, { organizationName: "Alex", defaultDateRange: 30 });
  assert.deepEqual((await resolve({ organizationName: "" }, undefined, options)).errors, {});
  assert.ok((await resolve({ defaultDateRange: "366" }, undefined, options)).errors.defaultDateRange);
});
