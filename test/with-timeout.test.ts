import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../src/server/engines/with-timeout.ts";

test("resolves the work when it finishes before the timeout", async () => {
  assert.equal(await withTimeout(async () => 42, 1000, () => new Error("t")), 42);
});
test("rejects with onTimeout error when work hangs", async () => {
  await assert.rejects(
    withTimeout(() => new Promise((r) => setTimeout(() => r(1), 1000)), 20, () => new Error("timed out")),
    /timed out/,
  );
});
test("does not leave a dangling timer (resolves promptly)", async () => {
  const start = Date.now();
  await withTimeout(async () => "ok", 5000, () => new Error("t"));
  assert.ok(Date.now() - start < 500); // returned immediately, timer cleared
});
