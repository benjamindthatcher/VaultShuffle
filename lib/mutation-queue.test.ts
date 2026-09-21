import assert from "node:assert/strict";
import test from "node:test";
import { MutationQueue } from "./mutation-queue.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("an immediate undo persists after the original write; only the latest response applies", async () => {
  const blocked = gate();
  const calls: string[] = [];
  const queue = new MutationQueue(async () => {});
  const save = queue.enqueue(async (revision) => {
    calls.push("save");
    await blocked.promise;
    assert.equal(queue.isLatest(revision), false);
  });
  const undo = queue.enqueue(async (revision) => {
    calls.push("undo");
    assert.equal(queue.isLatest(revision), true);
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["save"]);
  blocked.resolve();
  await Promise.all([save, undo]);
  assert.deepEqual(calls, ["save", "undo"]);
});

test("a failed save rejects to its caller, allows undo, and reconciles after the queue drains", async () => {
  const calls: string[] = [];
  const reconciled = gate();
  const queue = new MutationQueue(async () => { calls.push("refresh"); reconciled.resolve(); });
  const fail = queue.enqueue(async () => { calls.push("fail"); throw new Error("offline"); });
  const undo = queue.enqueue(async () => { calls.push("undo"); });
  await assert.rejects(fail, /offline/);
  await undo;
  await reconciled.promise;
  assert.deepEqual(calls, ["fail", "undo", "refresh"]);
});

test("a later write waits for failure reconciliation, including when refresh fails", async () => {
  const blocked = gate();
  const calls: string[] = [];
  const queue = new MutationQueue(async () => { calls.push("refresh"); await blocked.promise; throw new Error("offline"); });
  await assert.rejects(queue.enqueue(async () => { throw new Error("save failed"); }));
  // Let the queue start reconciliation before adding the next action.
  await Promise.resolve(); await Promise.resolve();
  const next = queue.enqueue(async () => { calls.push("next"); });
  blocked.resolve();
  await next;
  assert.deepEqual(calls, ["refresh", "next"]);
});
