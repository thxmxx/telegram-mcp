import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampTimeout,
  timeoutMessage,
  splitMessage,
  truncate,
  encodeBatchCb,
  decodeBatchCb,
  encodeChooseCb,
  decodeChooseCb,
  BatchTracker,
  validateBatchItems,
  PollingController,
  PollingConflictError,
  describePollingError,
} from "../src/core.js";

// ── timeout ──
test("clampTimeout: default, bounds, junk", () => {
  assert.equal(clampTimeout(undefined), 300);
  assert.equal(clampTimeout(null), 300);
  assert.equal(clampTimeout("abc"), 300);
  assert.equal(clampTimeout(NaN), 300);
  assert.equal(clampTimeout(1), 10);
  assert.equal(clampTimeout(10), 10);
  assert.equal(clampTimeout(45), 45);
  assert.equal(clampTimeout(3600), 3600);
  assert.equal(clampTimeout(99999), 3600);
  assert.equal(clampTimeout(-5), 10);
  assert.equal(clampTimeout(12.6), 13);
});

test("timeoutMessage states the actual seconds", () => {
  assert.equal(timeoutMessage(45), "Timed out after 45s");
  assert.ok(!timeoutMessage(300).includes("5 min"));
});

// ── splitting ──
test("splitMessage: short text is one chunk", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
  assert.deepEqual(splitMessage(""), [""]);
  const exact = "a".repeat(4096);
  assert.deepEqual(splitMessage(exact), [exact]);
});

test("splitMessage: 5000 chars splits, every chunk <= 4096, nothing lost", () => {
  const text = "x".repeat(5000);
  const chunks = splitMessage(text);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.length <= 4096));
  assert.equal(chunks.join(""), text);
});

test("splitMessage: prefers paragraph, then line, then space", () => {
  const p1 = "a".repeat(3000);
  const p2 = "b".repeat(2000);
  assert.deepEqual(splitMessage(`${p1}\n\n${p2}`), [p1, p2]);
  assert.deepEqual(splitMessage(`${p1}\n${p2}`), [p1, p2]);
  assert.deepEqual(splitMessage(`${p1} ${p2}`), [p1, p2]);
});

test("splitMessage: never splits a surrogate pair", () => {
  const text = "a".repeat(4095) + "😀" + "b".repeat(10);
  const chunks = splitMessage(text);
  assert.ok(chunks.every((c) => c.length <= 4096));
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((c) => !/[\ud800-\udbff]$/.test(c)));
});

test("splitMessage: custom limit and huge input", () => {
  const text = "word ".repeat(5000);
  const chunks = splitMessage(text, 1000);
  assert.ok(chunks.every((c) => c.length <= 1000));
  assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), text.trim());
});

test("truncate", () => {
  assert.equal(truncate("abc", 10), "abc");
  const t = truncate("x".repeat(5000));
  assert.equal(t.length, 4096);
  assert.ok(t.endsWith("..."));
});

// ── callback data ──
test("batch callback data round trips and fits 64 bytes", () => {
  const data = encodeBatchCb("a1b2c3d4", 9, 9);
  assert.equal(data, "b:a1b2c3d4:9:9");
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.deepEqual(decodeBatchCb(data), { batchId: "a1b2c3d4", itemIdx: 9, optIdx: 9 });
});

test("decodeBatchCb rejects anything else", () => {
  for (const bad of ["PostgreSQL", "", "b:zz:1:1", "b:a1:1", "b:a1:x:1", "c:a1:1", "b:a1:1:1:1", undefined]) {
    assert.equal(decodeBatchCb(bad), null, String(bad));
  }
});

test("choose callback data round trips; batch and choose do not collide", () => {
  const c = encodeChooseCb("deadbeef", 3);
  assert.deepEqual(decodeChooseCb(c), { chooseId: "deadbeef", optIdx: 3 });
  assert.equal(decodeBatchCb(c), null);
  assert.equal(decodeChooseCb(encodeBatchCb("deadbeef", 1, 1)), null);
});

// ── batch aggregation ──
const items = () => [
  { id: "job1", text: "t1", options: ["Send", "Skip"] },
  { id: "job2", text: "t2", options: ["Send", "Skip", "Edit"] },
  { id: "job3", text: "t3", options: ["Yes", "No"] },
];

test("BatchTracker: answers, order, completion", () => {
  const b = new BatchTracker("aa11", items());
  assert.deepEqual(b.handle(encodeBatchCb("aa11", 1, 2)), { type: "answered", id: "job2", option: "Edit", itemIdx: 1 });
  assert.equal(b.complete, false);
  b.handle(encodeBatchCb("aa11", 0, 0));
  b.handle(encodeBatchCb("aa11", 2, 1));
  assert.equal(b.complete, true);
  assert.deepEqual(b.result(), {
    answers: { job1: "Send", job2: "Edit", job3: "No" },
    timed_out: [],
  });
});

test("BatchTracker: duplicate press on answered item is ignored, first answer wins", () => {
  const b = new BatchTracker("aa11", items());
  b.handle(encodeBatchCb("aa11", 0, 0));
  assert.deepEqual(b.handle(encodeBatchCb("aa11", 0, 1)), { type: "ignored", reason: "duplicate" });
  assert.equal(b.result().answers.job1, "Send");
});

test("BatchTracker: foreign batch, junk and out-of-range are ignored", () => {
  const b = new BatchTracker("aa11", items());
  assert.deepEqual(b.handle(encodeBatchCb("bb22", 0, 0)), { type: "ignored", reason: "foreign" });
  assert.deepEqual(b.handle("Send"), { type: "ignored", reason: "foreign" });
  assert.deepEqual(b.handle(encodeBatchCb("aa11", 7, 0)), { type: "ignored", reason: "unknown" });
  assert.deepEqual(b.handle(encodeBatchCb("aa11", 0, 5)), { type: "ignored", reason: "unknown" });
  assert.equal(b.answers.size, 0);
});

test("BatchTracker: timeout leaves null and lists timed_out ids", () => {
  const b = new BatchTracker("aa11", items());
  b.handle(encodeBatchCb("aa11", 1, 0));
  assert.deepEqual(b.result(), {
    answers: { job1: null, job2: "Send", job3: null },
    timed_out: ["job1", "job3"],
  });
});

test("validateBatchItems: duplicate ids rejected", () => {
  assert.equal(validateBatchItems(items()), null);
  assert.match(validateBatchItems([{ id: "a" }, { id: "a" }]), /duplicate item id: a/);
});

// ── lazy polling ──
function fakePoller() {
  const state = { starts: 0, stops: 0, rejects: [] };
  const startPolling = () => {
    state.starts++;
    let reject, resolve;
    const done = new Promise((res, rej) => ((resolve = res), (reject = rej)));
    state.rejects.push(reject);
    return {
      done,
      stop: () => {
        state.stops++;
        resolve();
      },
    };
  };
  return { state, startPolling };
}

test("PollingController: lazy start, shared by waiters, stop after last release", () => {
  const { state, startPolling } = fakePoller();
  const pc = new PollingController({ startPolling });
  assert.equal(state.starts, 0);
  assert.equal(pc.active, false);
  const a = pc.acquire();
  const b = pc.acquire();
  assert.equal(state.starts, 1);
  assert.equal(pc.waiters, 2);
  a.release();
  a.release(); // idempotent
  assert.equal(state.stops, 0);
  b.release();
  assert.equal(state.stops, 1);
  assert.equal(pc.active, false);
  pc.acquire(); // restarts on demand
  assert.equal(state.starts, 2);
});

test("PollingController: 409 rejects every waiter with a clear error and recovers", async () => {
  const { state, startPolling } = fakePoller();
  const pc = new PollingController({ startPolling });
  const a = pc.acquire();
  const b = pc.acquire();
  state.rejects[0](Object.assign(new Error("Conflict: terminated by other getUpdates request"), { error_code: 409 }));
  for (const h of [a, b]) {
    await assert.rejects(h.failed, (e) => {
      assert.ok(e instanceof PollingConflictError);
      assert.match(e.message, /another session is polling this bot/);
      return true;
    });
  }
  assert.equal(pc.active, false);
  assert.equal(pc.waiters, 0);
  pc.acquire();
  assert.equal(state.starts, 2);
});

test("PollingController: synchronous start failure is reported on the handle", async () => {
  const pc = new PollingController({
    startPolling: () => {
      throw new Error("boom");
    },
  });
  const h = pc.acquire();
  await assert.rejects(h.failed, /polling failed: boom/);
  assert.equal(pc.waiters, 0);
});

test("PollingController: rejection of a run that was stopped on purpose is ignored", async () => {
  const { state, startPolling } = fakePoller();
  const pc = new PollingController({ startPolling });
  const a = pc.acquire();
  a.release();
  state.rejects[0](new Error("late"));
  await new Promise((r) => setImmediate(r));
  const b = pc.acquire();
  assert.equal(state.starts, 2);
  assert.equal(pc.waiters, 1);
  b.release();
});

test("describePollingError", () => {
  assert.match(describePollingError({ error_code: 409 }), /another session is polling this bot/);
  assert.match(describePollingError(new Error("Conflict: x")), /another session is polling this bot/);
  assert.match(describePollingError(new Error("ENOTFOUND")), /^polling failed: ENOTFOUND/);
});
