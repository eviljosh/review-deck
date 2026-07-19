import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stageArtifactDir, writeArtifacts } from "../src/server/artifacts.ts";

test("stageArtifactDir builds the expected path", () => {
  assert.equal(stageArtifactDir("/data", 7, "triage"), "/data/artifacts/7/triage");
});

test("writeArtifacts creates the dir and writes files", () => {
  const dir = join(process.env.SCRATCH ?? "/tmp", `rd-artifacts-${Date.now()}`);
  writeArtifacts(dir, { "prompt.md": "hello", "result.json": "{}" });
  assert.equal(readFileSync(join(dir, "prompt.md"), "utf8"), "hello");
  assert.equal(readFileSync(join(dir, "result.json"), "utf8"), "{}");
  rmSync(dir, { recursive: true, force: true });
});
