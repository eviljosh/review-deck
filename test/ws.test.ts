import { test } from "node:test";
import assert from "node:assert/strict";
import { WsHub } from "../src/server/ws.ts";

test("broadcast sends JSON to all sockets", () => {
  const hub = new WsHub();
  const a: string[] = [];
  const b: string[] = [];
  const sa = { send: (d: string) => a.push(d) };
  const sb = { send: (d: string) => b.push(d) };
  hub.add(sa);
  hub.add(sb);
  hub.broadcast({ type: "hello" });
  assert.deepEqual(JSON.parse(a[0]), { type: "hello" });
  assert.deepEqual(JSON.parse(b[0]), { type: "hello" });
});

test("a throwing socket is dropped after its first failure", () => {
  const hub = new WsHub();
  let badCalls = 0;
  const good: string[] = [];
  hub.add({ send: () => { badCalls++; throw new Error("closed"); } });
  hub.add({ send: (d) => good.push(d) });
  hub.broadcast({ type: "hello" });
  hub.broadcast({ type: "hello" });
  assert.equal(badCalls, 1);    // dropped after first throw, not retried on the 2nd broadcast
  assert.equal(good.length, 2); // survivor still receives both
});

test("remove stops a socket from receiving further broadcasts", () => {
  const hub = new WsHub();
  const got: string[] = [];
  const s = { send: (d: string) => got.push(d) };
  hub.add(s);
  hub.broadcast({ type: "hello" });
  hub.remove(s);
  hub.broadcast({ type: "hello" });
  assert.equal(got.length, 1);
});
