import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLinearIssueIds, fetchLinearContext } from "../src/server/linear.ts";

test("extractLinearIssueIds finds URLs and bare ids, deduped, URLs first", () => {
  const text = [
    "Fixes https://linear.app/plenful/issue/ENG-1234/some-slug",
    "also relates to ABC-7 and ENG-1234 again",
  ].join("\n");
  assert.deepEqual(extractLinearIssueIds(text), ["ENG-1234", "ABC-7"]);
});

test("extractLinearIssueIds caps the number returned", () => {
  const text = "AA-1 BB-2 CC-3 DD-4 EE-5";
  assert.equal(extractLinearIssueIds(text, 3).length, 3);
});

test("extractLinearIssueIds returns nothing when there are no refs", () => {
  assert.deepEqual(extractLinearIssueIds("just some prose, no tickets"), []);
});

test("extractLinearIssueIds ignores technical tokens shaped like ids", () => {
  const text = "hash with SHA-256, encodes UTF-8, per RFC-7231 and CVE-2024; fixes ENG-42";
  assert.deepEqual(extractLinearIssueIds(text), ["ENG-42"]);
});

function fakeFetch(issue: unknown): typeof fetch {
  return (async () => ({ ok: true, json: async () => ({ data: { issue } }) })) as unknown as typeof fetch;
}

test("fetchLinearContext returns '' when no api key is set", async () => {
  assert.equal(await fetchLinearContext("ENG-1", undefined, fakeFetch(null)), "");
});

test("fetchLinearContext returns '' when nothing is referenced", async () => {
  assert.equal(await fetchLinearContext("no tickets here", "key", fakeFetch(null)), "");
});

test("fetchLinearContext renders a markdown block for a resolved issue", async () => {
  const issue = { identifier: "ENG-1234", title: "Speed up refresh", description: "Refresh is slow.", url: "https://linear.app/x/issue/ENG-1234", state: { name: "In Progress" } };
  const out = await fetchLinearContext("Fixes ENG-1234", "key", fakeFetch(issue));
  assert.match(out, /ENG-1234 — Speed up refresh \(In Progress\)/);
  assert.match(out, /Refresh is slow\./);
});

test("fetchLinearContext returns '' when the issue does not resolve", async () => {
  assert.equal(await fetchLinearContext("BOGUS-9", "key", fakeFetch(null)), "");
});
