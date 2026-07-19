// test/repos.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Exec } from "../src/server/exec.ts";
import { cachePath, worktreePath, prepareWorktree } from "../src/server/repos.ts";

test("cachePath and worktreePath build expected paths", () => {
  assert.equal(cachePath("/data", "o", "r"), "/data/cache/o/r");
  assert.equal(worktreePath("/data", 7), "/data/worktrees/pr-7");
});

test("prepareWorktree clones when cache is absent, then fetches + adds worktree", async () => {
  const cmds: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    cmds.push([cmd, ...args]);
    return { stdout: "", stderr: "" };
  };
  const wt = await prepareWorktree(exec, {
    dataDir: "/data", owner: "o", repo: "r", number: 5, prId: 7,
    fileExists: () => false, // cache absent
  });
  assert.equal(wt.path, "/data/worktrees/pr-7");
  // first command must be the clone — over SSH so it never prompts for creds
  assert.deepEqual(cmds[0], [
    "git", "clone", "--filter=blob:none", "--progress", "git@github.com:o/r.git", "/data/cache/o/r",
  ]);
  const joined = cmds.map((c) => c.join(" "));
  assert.ok(joined.some((c) => c.includes("fetch --prune --progress origin")));
  assert.ok(joined.some((c) => c.includes("fetch --progress origin pull/5/head")));
  assert.ok(joined.some((c) => c.includes("worktree add --detach /data/worktrees/pr-7 FETCH_HEAD")));
});

test("prepareWorktree skips clone when cache exists", async () => {
  const cmds: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    cmds.push([cmd, ...args]);
    return { stdout: "", stderr: "" };
  };
  await prepareWorktree(exec, {
    dataDir: "/data", owner: "o", repo: "r", number: 5, prId: 7,
    fileExists: () => true, // cache present
  });
  assert.ok(!cmds.some((c) => c[1] === "clone"));
});

test("concurrent prepareWorktree for the same repo serializes and clones once", async () => {
  const order: string[] = [];
  let cloned = false;
  const exec: Exec = async (cmd, args) => {
    if (args[0] === "clone") { cloned = true; }
    order.push(`${cmd} ${args.join(" ")}`);
    // yield so both promises are in flight; serialization must still hold
    await new Promise((r) => setTimeout(r, 5));
    return { stdout: "", stderr: "" };
  };
  const fileExists = () => cloned; // false until the first clone runs
  const opts = { dataDir: "/data", owner: "o", repo: "r", fileExists };
  const [wt7, wt8] = await Promise.all([
    prepareWorktree(exec, { ...opts, number: 5, prId: 7 }),
    prepareWorktree(exec, { ...opts, number: 6, prId: 8 }),
  ]);
  assert.equal(wt7.path, "/data/worktrees/pr-7");
  assert.equal(wt8.path, "/data/worktrees/pr-8");
  // exactly one clone across both concurrent calls
  assert.equal(order.filter((c) => c.includes(" clone ")).length, 1);
});

test("prepareWorktree ignores a failing stale-worktree removal", async () => {
  const cmds: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    cmds.push([cmd, ...args]);
    if (args[1] === "worktree" && args[2] === "remove") {
      throw new Error("no such worktree"); // simulate remove failing
    }
    return { stdout: "", stderr: "" };
  };
  const wt = await prepareWorktree(exec, {
    dataDir: "/data", owner: "o", repo: "r", number: 5, prId: 7,
    fileExists: () => true, // cache exists
  });
  // Removal threw, but prepareWorktree still completed and added the worktree.
  assert.equal(wt.path, "/data/worktrees/pr-7");
  assert.ok(
    cmds.some((c) => c.join(" ").includes("worktree add --detach /data/worktrees/pr-7 FETCH_HEAD")),
  );
});
