// test/repos.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Exec } from "../src/server/exec.ts";
import { cachePath, worktreePath, tipWorktreePath, pickLineageTip, prepareWorktree } from "../src/server/repos.ts";

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

// ---------- lineage tip ----------
// Replays the shape of the real query on plenful#7455: two refs sitting on one
// commit (…-automation and …-automation-core), one older branch behind it, and
// one stale branch level with the head.
const HEAD = "dc15610ec6de113950d4d6ba0a8a0c4066c1a12b";
const TIP = "9f1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const MID = "1122334455667788990011223344556677889900";
const STALE = "aabbccddeeff00112233445566778899aabbccdd";
const TIP_REF = "origin/sawyer/340b-112-verity-automation";
const REF_LINES = [
  `${TIP} ${TIP_REF}-core`,
  `${TIP} ${TIP_REF}`,
  `${MID} origin/sawyer/340b-110-normalize`,
  `${STALE} origin/sawyer/340b-99-abandoned`,
  `${HEAD} origin/sawyer/340b-112-this-pr`,
].join("\n") + "\n";
const AHEAD: Record<string, string> = { [TIP]: "25", [MID]: "24", [STALE]: "0" };
const TIP_PATH = tipWorktreePath("/data", "o", "r", TIP);

function lineageExec(
  cmds: string[][],
  opts: { forEachRefThrows?: boolean; isAncestor?: boolean; addFails?: number } = {},
): Exec {
  let tipAdds = 0;
  return async (cmd, args) => {
    cmds.push([cmd, ...args]);
    if (args.includes("rev-parse") && args.includes("FETCH_HEAD")) return { stdout: `${HEAD}\n`, stderr: "" };
    if (args.includes("symbolic-ref")) return { stdout: "origin/main\n", stderr: "" };
    // git reports "not an ancestor" with a non-zero exit, i.e. a throwing exec.
    if (args.includes("--is-ancestor")) {
      if (opts.isAncestor) return { stdout: "", stderr: "" };
      throw new Error("exited with code 1");
    }
    if (args.includes("for-each-ref")) {
      if (opts.forEachRefThrows) throw new Error("fatal: bad object (shallow clone)");
      return { stdout: REF_LINES, stderr: "" };
    }
    if (args.includes("rev-list")) {
      const sha = args[args.length - 1].split("..")[1];
      return { stdout: `${AHEAD[sha] ?? "0"}\n`, stderr: "" };
    }
    if (args.includes("worktree") && args.includes("add") && args.includes(TIP_PATH)) {
      if (opts.addFails && ++tipAdds <= opts.addFails) throw new Error("fatal: already registered");
    }
    return { stdout: "", stderr: "" };
  };
}

// cache present, tip absent — the normal first-PR-of-a-stack state
const cacheOnly = (p: string) => !p.includes("/worktrees/tips/");

const prepOpts = { dataDir: "/data", owner: "o", repo: "r", number: 7455, prId: 7 };

test("tipWorktreePath keys the shared checkout by owner/repo/tip sha", () => {
  assert.equal(tipWorktreePath("/data", "o", "r", TIP), `/data/worktrees/tips/o/r/${TIP.slice(0, 12)}`);
});

test("pickLineageTip: max ahead, capped, deterministic on ties", () => {
  const c = (ref: string, ahead: number, sha = "s" + ahead) => ({ sha, ref, ahead });
  const cases: [string, ReturnType<typeof c>[], string | null][] = [
    ["no candidates", [], null],
    ["furthest ahead wins", [c("origin/a", 3), c("origin/b", 25), c("origin/c", 24)], "origin/b"],
    ["standalone PR (nothing ahead)", [c("origin/a", 0), c("origin/b", 0)], null],
    // The measured danger case: a head already on main puts origin/main 300 ahead.
    ["over the ahead cap", [c("origin/main", 300)], null],
    ["cap applies per candidate", [c("origin/main", 300), c("origin/stack", 12)], "origin/stack"],
    // Two refs on one commit: the answer must not depend on iteration order.
    ["tie breaks on the smaller ref", [c("origin/z", 25, "x"), c("origin/a", 25, "x")], "origin/a"],
    ["tie is order-independent", [c("origin/a", 25, "x"), c("origin/z", 25, "x")], "origin/a"],
  ];
  for (const [name, candidates, expected] of cases) {
    assert.equal(pickLineageTip(candidates)?.ref ?? null, expected, name);
  }
});

test("prepareWorktree resolves the lineage tip and checks it out once", async () => {
  const cmds: string[][] = [];
  const wt = await prepareWorktree(lineageExec(cmds), { ...prepOpts, fileExists: cacheOnly });
  assert.deepEqual(wt.lineageTip, { sha: TIP, ref: TIP_REF, ahead: 25, path: TIP_PATH });
  const joined = cmds.map((c) => c.join(" "));
  assert.ok(joined.some((c) => c.includes(`worktree add --detach ${TIP_PATH} ${TIP}`)));
  // One rev-list per DISTINCT commit: the duplicate ref and the head's own ref
  // never cost a measurement.
  const counted = cmds.filter((c) => c.includes("rev-list")).map((c) => c[c.length - 1]);
  assert.deepEqual(counted.sort(), [`${HEAD}..${MID}`, `${HEAD}..${TIP}`, `${HEAD}..${STALE}`].sort());
});

test("prepareWorktree is a clean no-op when the lineage query fails", async () => {
  const cmds: string[][] = [];
  const wt = await prepareWorktree(
    lineageExec(cmds, { forEachRefThrows: true }),
    { ...prepOpts, fileExists: cacheOnly },
  );
  assert.equal(wt.lineageTip, null);
  const joined = cmds.map((c) => c.join(" "));
  assert.ok(!joined.some((c) => c.includes("/worktrees/tips/")), "no tip worktree was added");
  // The PR's own checkout is untouched by the failure — this is the whole
  // point: the tip is additive and never a prerequisite.
  assert.equal(wt.path, "/data/worktrees/pr-7");
  assert.ok(joined.some((c) => c.includes("worktree add --detach /data/worktrees/pr-7 FETCH_HEAD")));
});

test("prepareWorktree skips the lineage query when the head is already on the default branch", async () => {
  const cmds: string[][] = [];
  const wt = await prepareWorktree(
    lineageExec(cmds, { isAncestor: true }),
    { ...prepOpts, fileExists: cacheOnly },
  );
  assert.equal(wt.lineageTip, null);
  // A merged head would match ~175 refs with origin/main the "furthest ahead" —
  // the guard has to fire before for-each-ref, not after.
  assert.ok(!cmds.some((c) => c.includes("for-each-ref")));
});

test("prepareWorktree reuses an existing tip checkout instead of re-adding it", async () => {
  const cmds: string[][] = [];
  const wt = await prepareWorktree(lineageExec(cmds), { ...prepOpts, fileExists: () => true });
  assert.deepEqual(wt.lineageTip?.path, TIP_PATH);
  // A sibling PR may be reading it right now; touching it is not allowed.
  const joined = cmds.map((c) => c.join(" "));
  assert.ok(!joined.some((c) => c.includes(`worktree add --detach ${TIP_PATH}`)));
  assert.ok(!joined.some((c) => c.includes(`worktree remove --force ${TIP_PATH}`)));
});

test("prepareWorktree prunes and retries a failed tip checkout, then gives up", async () => {
  const once: string[][] = [];
  const recovered = await prepareWorktree(lineageExec(once, { addFails: 1 }), { ...prepOpts, fileExists: cacheOnly });
  assert.equal(recovered.lineageTip?.sha, TIP);
  assert.ok(once.some((c) => c.join(" ").includes("worktree prune")));

  const twice: string[][] = [];
  const givenUp = await prepareWorktree(lineageExec(twice, { addFails: 2 }), { ...prepOpts, fileExists: cacheOnly });
  assert.equal(givenUp.lineageTip, null);
  assert.equal(givenUp.path, "/data/worktrees/pr-7"); // review proceeds regardless
});

test("prepareWorktree skips the lineage query entirely when lineageTip is off", async () => {
  const cmds: string[][] = [];
  const wt = await prepareWorktree(lineageExec(cmds), { ...prepOpts, lineageTip: false, fileExists: cacheOnly });
  assert.equal(wt.lineageTip, null);
  assert.ok(!cmds.some((c) => c.includes("for-each-ref") || c.includes("symbolic-ref")));
});
