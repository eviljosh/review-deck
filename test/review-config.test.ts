import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REVIEW_CONFIG, engineModelOptions, loadReviewConfig, saveReviewConfig, parseDimensions, parseRiskFlags } from "../src/server/review-config.ts";
import { openDb, setSetting } from "../src/server/db.ts";

test("default config enables both engines, all dimensions, claude finalizer", () => {
  assert.equal(DEFAULT_REVIEW_CONFIG.engines.claude, true);
  assert.equal(DEFAULT_REVIEW_CONFIG.engines.codex, true);
  assert.equal(DEFAULT_REVIEW_CONFIG.dimensions.length, 5);
  assert.ok(DEFAULT_REVIEW_CONFIG.dimensions.every((d) => d.key && d.guidance));
  assert.ok(!DEFAULT_REVIEW_CONFIG.dimensions.some((d) => d.key === "python")); // no repo-specific dims
  assert.ok(!DEFAULT_REVIEW_CONFIG.riskFlags.some((f) => f.key === "phi"));     // no company-specific flags
  assert.equal(DEFAULT_REVIEW_CONFIG.finalizerEngine, "claude");
  assert.equal(DEFAULT_REVIEW_CONFIG.maxConcurrentReviews, 4);
  assert.equal(DEFAULT_REVIEW_CONFIG.maxConcurrentPipelines, 4);
  assert.equal(DEFAULT_REVIEW_CONFIG.claudeModel, "opus");
  assert.equal(DEFAULT_REVIEW_CONFIG.engineTimeoutMs, 600_000);
});

test("loadReviewConfig returns defaults on an empty DB and merges saved patches", () => {
  const db = openDb(":memory:");
  assert.deepEqual(loadReviewConfig(db), DEFAULT_REVIEW_CONFIG);

  const saved = saveReviewConfig(db, { claudeModel: "sonnet", engines: { claude: true, codex: false } });
  assert.equal(saved.claudeModel, "sonnet");
  assert.equal(saved.engines.codex, false);
  assert.equal(saved.engineTimeoutMs, DEFAULT_REVIEW_CONFIG.engineTimeoutMs); // untouched fields stay default

  // A later patch merges over the earlier one without wiping it.
  const again = saveReviewConfig(db, { robotMarker: "🤖 custom marker" });
  assert.equal(again.claudeModel, "sonnet");
  assert.equal(again.robotMarker, "🤖 custom marker");
});

test("parseDimensions / parseRiskFlags accept valid JSON overrides and reject junk", () => {
  assert.deepEqual(parseDimensions(JSON.stringify([{ key: "style", guidance: "match the house style" }])), [
    { key: "style", guidance: "match the house style" },
  ]);
  assert.equal(parseDimensions(null), null);
  assert.equal(parseDimensions("not json"), null);
  assert.equal(parseDimensions("[]"), null);
  assert.deepEqual(parseRiskFlags(JSON.stringify([{ key: "phi", description: "PHI-handling code" }])), [
    { key: "phi", description: "PHI-handling code" },
  ]);
  assert.equal(parseRiskFlags('[{"nope": true}]'), null);
});

test("engineModelOptions: claude gets its model alias", () => {
  assert.deepEqual(engineModelOptions(DEFAULT_REVIEW_CONFIG, "claude"), { model: "opus" });
});

test("engineModelOptions: codex inherits model but pins reasoning effort to medium", () => {
  assert.deepEqual(engineModelOptions(DEFAULT_REVIEW_CONFIG, "codex"), { reasoningEffort: "medium" });
});

test("engineModelOptions: codex omits everything when both are unset", () => {
  const cfg = { ...DEFAULT_REVIEW_CONFIG, codexReasoningEffort: undefined };
  assert.deepEqual(engineModelOptions(cfg, "codex"), {});
});

test("engineModelOptions: codex forwards configured model + effort", () => {
  const cfg = { ...DEFAULT_REVIEW_CONFIG, codexModel: "gpt-5.6-sol", codexReasoningEffort: "high" as const };
  assert.deepEqual(engineModelOptions(cfg, "codex"), { model: "gpt-5.6-sol", reasoningEffort: "high" });
});

test("claude transport defaults to sdk/env and coerces invalid stored values", () => {
  const db = openDb(":memory:");
  assert.equal(loadReviewConfig(db).claudeTransport, "sdk");
  assert.equal(loadReviewConfig(db).claudeCliAuth, "env");
  saveReviewConfig(db, { claudeTransport: "cli", claudeCliAuth: "stored-login" });
  assert.equal(loadReviewConfig(db).claudeTransport, "cli");
  assert.equal(loadReviewConfig(db).claudeCliAuth, "stored-login");
  setSetting(db, "review_config", JSON.stringify({ claudeTransport: "carrier-pigeon", claudeCliAuth: 42 }));
  assert.equal(loadReviewConfig(db).claudeTransport, "sdk");
  assert.equal(loadReviewConfig(db).claudeCliAuth, "env");
});
