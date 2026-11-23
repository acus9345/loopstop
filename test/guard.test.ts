import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLoopGuard, type Call, type LoopGuard, type Verdict } from "../dist/index.js";

const search = (q: string): Call => ({ name: "search", args: { q } });
const run = (guard: LoopGuard, calls: Call[]): Verdict[] => calls.map((call) => guard.check(call));
const actions = (verdicts: Verdict[]) => verdicts.map((verdict) => verdict.action);

describe("repeats", () => {
  it("warns at maxRepeats, then stops", () => {
    const guard = createLoopGuard({ maxRepeats: 3 });
    const verdicts = run(guard, [search("a"), search("a"), search("a"), search("a")]);
    assert.deepEqual(actions(verdicts), ["continue", "continue", "warn", "stop"]);
    assert.equal(verdicts[2]!.code, "repeat");
    assert.equal(verdicts[2]!.count, 3);
    assert.match(verdicts[2]!.reason, /called search 3 times with the same arguments/);
  });

  it("compares arguments by value, whatever the key order", () => {
    const guard = createLoopGuard({ maxRepeats: 2, warnings: 0 });
    guard.check({ name: "t", args: { a: 1, b: [1, { c: 2 }] } });
    const verdict = guard.check({ name: "t", args: { b: [1, { c: 2 }], a: 1 } });
    assert.equal(verdict.action, "stop");
  });

  it("treats different arguments as different calls", () => {
    const guard = createLoopGuard({ maxRepeats: 2 });
    assert.deepEqual(actions(run(guard, [search("a"), search("b"), search("c")])), ["continue", "continue", "continue"]);
  });

  it("says so when the results were the same too", () => {
    const guard = createLoopGuard({ maxRepeats: 3 });
    guard.check(search("a"));
    guard.result(search("a"), "nothing");
    guard.check(search("a"));
    guard.result(search("a"), "nothing");
    assert.match(guard.check(search("a")).reason, /and got the same result/);
  });

  it("lets polling through while the result keeps changing", () => {
    const guard = createLoopGuard({ maxRepeats: 3 });
    for (const status of ["queued", "running", "almost", "done", "really done"]) {
      assert.equal(guard.check({ name: "status" }).action, "continue");
      guard.result({ name: "status" }, status);
    }
  });

  it("flags polling once the result stops changing", () => {
    const guard = createLoopGuard({ maxRepeats: 3 });
    const statuses = ["queued", "running", "running", "running"];
    const verdicts = statuses.map((status) => {
      const verdict = guard.check({ name: "status" });
      guard.result({ name: "status" }, status);
      return verdict;
    });
    assert.equal(verdicts[3]!.action, "warn");
    assert.equal(guard.check({ name: "status" }).action, "stop");
  });

  it("skips ignored tools but still counts their steps", () => {
    const guard = createLoopGuard({ maxRepeats: 2, ignore: ["sleep"], maxSteps: 3 });
    const sleep = { name: "sleep" };
    assert.deepEqual(actions(run(guard, [sleep, sleep, sleep, sleep])), ["continue", "continue", "warn", "stop"]);
    assert.equal(guard.stats().steps, 4);
  });
});

describe("cycles", () => {
  it("catches A, B, A, B", () => {
    const guard = createLoopGuard({ maxCycles: 3, maxRepeats: 99 });
    const verdicts = run(guard, [search("a"), search("b"), search("a"), search("b"), search("a"), search("b"), search("a"), search("b")]);
    assert.equal(verdicts[4]!.action, "continue");
    assert.equal(verdicts[5]!.action, "warn");
    assert.equal(verdicts[5]!.code, "cycle");
    assert.match(verdicts[5]!.reason, /back and forth between search 3 times/);
    assert.equal(verdicts[7]!.action, "stop");
  });

  it("catches longer patterns", () => {
    const guard = createLoopGuard({ maxCycles: 2, maxRepeats: 99, warnings: 0 });
    const round = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const verdicts = run(guard, [...round, ...round]);
    assert.equal(verdicts[5]!.action, "stop");
    assert.equal(verdicts[5]!.code, "cycle");
  });

  it("does not call a changing back-and-forth a loop", () => {
    const guard = createLoopGuard({ maxCycles: 2, maxRepeats: 99, warnings: 0 });
    for (let i = 0; i < 8; i++) {
      const call = i % 2 ? { name: "read" } : { name: "write" };
      assert.equal(guard.check(call).action, "continue");
      guard.result(call, i);
    }
  });
});

describe("stale results", () => {
  it("warns and stops when results bring nothing new", () => {
    const guard = createLoopGuard({ maxStale: 2 });
    const seen: Verdict[] = [];
    for (const q of ["a", "b", "c", "d", "e"]) {
      seen.push(guard.check(search(q)));
      guard.result(search(q), "same page");
    }
    assert.deepEqual(actions(seen), ["continue", "continue", "continue", "warn", "stop"]);
    assert.equal(seen[3]!.code, "stale");
    assert.match(seen[3]!.reason, /nothing new/);
  });

  it("resets when something new arrives", () => {
    const guard = createLoopGuard({ maxStale: 2 });
    const results = ["x", "x", "y", "x", "z", "y"];
    results.forEach((result, i) => {
      assert.equal(guard.check(search(String(i))).action, "continue");
      guard.result(search(String(i)), result);
    });
  });

  it("uses normalize to ignore noise in results", () => {
    const guard = createLoopGuard({ maxStale: 1, warnings: 0, normalize: (result) => (result as { body: string }).body });
    guard.check(search("a"));
    guard.result(search("a"), { body: "same", at: 1 });
    guard.check(search("b"));
    guard.result(search("b"), { body: "same", at: 2 });
    assert.equal(guard.check(search("c")).code, "stale");
  });

  it("accepts results passed to check", () => {
    const guard = createLoopGuard({ maxStale: 1, warnings: 0 });
    guard.check({ ...search("a"), result: 1 });
    assert.equal(guard.check({ ...search("b"), result: 1 }).code, "stale");
  });

  it("matches results to parallel calls", () => {
    const guard = createLoopGuard({ maxRepeats: 99 });
    guard.check(search("a"));
    guard.check(search("b"));
    guard.result(search("a"), 1);
    guard.result(search("b"), 2);
    assert.equal(guard.check(search("c")).action, "continue");
  });
});

describe("hard limits", () => {
  it("stops after maxSteps and warns near it", () => {
    const guard = createLoopGuard({ maxSteps: 5 });
    const verdicts = run(guard, ["a", "b", "c", "d", "e", "f"].map(search));
    assert.deepEqual(actions(verdicts), ["continue", "continue", "continue", "warn", "continue", "stop"]);
    assert.equal(verdicts[3]!.code, "steps");
    assert.equal(verdicts[5]!.code, "steps");
  });

  it("stops at maxMs", () => {
    let clock = 0;
    const guard = createLoopGuard({ maxMs: 10_000, now: () => clock });
    clock = 8_000;
    const warned = guard.check(search("a"));
    assert.equal(warned.action, "warn");
    assert.match(warned.reason, /8s of 10s/);
    clock = 10_000;
    assert.equal(guard.check(search("b")).code, "time");
  });

  it("formats sub-second time limits in milliseconds", () => {
    let clock = 0;
    const guard = createLoopGuard({ maxMs: 500, now: () => clock });
    clock = 400;
    const warned = guard.check(search("a"));
    assert.equal(warned.action, "warn");
    assert.match(warned.reason, /400ms of 500ms/);
    clock = 500;
    const stopped = guard.check(search("b"));
    assert.equal(stopped.action, "stop");
    assert.match(stopped.reason, /500ms/);
  });

  it("stops at maxCost across every way of adding cost", () => {
    const guard = createLoopGuard({ maxCost: 1, warnAt: 1 });
    assert.equal(guard.check({ ...search("a"), cost: 0.25 }).action, "continue");
    guard.result(search("a"), "x", 0.25);
    guard.addCost(0.25);
    assert.equal(guard.check({ ...search("b"), cost: 0.25 }).code, "cost");
  });

  it("handles floating-point cost accumulation cleanly", () => {
    const guard = createLoopGuard({ maxCost: 1, warnAt: 0.8 });
    const verdicts = Array.from({ length: 10 }, (_, i) => guard.check({ name: `t${i}`, cost: 0.1 }));
    assert.equal(verdicts[7]!.action, "warn");
    assert.equal(verdicts[7]!.code, "cost");
    assert.match(verdicts[7]!.reason, /0\.8 of 1/);
    assert.equal(verdicts[9]!.action, "stop");
    assert.equal(verdicts[9]!.code, "cost");
    assert.match(verdicts[9]!.reason, /1 of 1/);
  });

  it("ignores NaN costs instead of disabling maxCost", () => {
    const guard = createLoopGuard({ maxCost: 1, warnAt: 1 });
    guard.addCost(Number.NaN);
    assert.equal(guard.check({ ...search("a"), cost: Number.NaN }).action, "continue");
    guard.result(search("a"), "x", Number.NaN);
    assert.equal(guard.check({ ...search("b"), cost: 1 }).code, "cost");
  });

  it("warns about each limit only once", () => {
    const guard = createLoopGuard({ maxSteps: 100, warnAt: 0.02 });
    assert.equal(guard.check(search("a")).action, "continue");
    assert.equal(guard.check(search("b")).action, "warn");
    assert.equal(guard.check(search("c")).action, "continue");
  });
});

describe("guard", () => {
  it("stays stopped", () => {
    const guard = createLoopGuard({ maxSteps: 1, warnAt: 1 });
    guard.check(search("a"));
    const first = guard.check(search("b"));
    assert.equal(first.action, "stop");
    assert.equal(Object.isFrozen(first), true);
    assert.equal(guard.check(search("c")), first);
    assert.equal(guard.stats().steps, 2);
    assert.equal(guard.stats().stopped, true);
  });

  it("starts over after reset", () => {
    const guard = createLoopGuard({ maxSteps: 1, warnAt: 1 });
    guard.check(search("a"));
    guard.check(search("b"));
    guard.reset();
    assert.equal(guard.check(search("a")).action, "continue");
    assert.deepEqual(guard.stats().steps, 1);
  });

  it("forgets calls outside the window", () => {
    const guard = createLoopGuard({ maxRepeats: 2, window: 2 });
    run(guard, [search("a"), search("b"), search("c")]);
    assert.equal(guard.check(search("a")).action, "continue");
  });

  it("handles arguments JSON can't", () => {
    const guard = createLoopGuard({ maxRepeats: 2, warnings: 0 });
    const circular: Record<string, unknown> = { big: 1n, at: new Date(0), error: new Error("x") };
    circular.self = circular;
    guard.check({ name: "t", args: circular });
    assert.equal(guard.check({ name: "t", args: circular }).action, "stop");
  });

  it("distinguishes Map, Set, RegExp, URL and binary arguments", () => {
    const guard = createLoopGuard({ maxRepeats: 2, warnings: 0 });
    assert.equal(guard.check({ name: "t", args: new Map([["a", 1]]) }).action, "continue");
    assert.equal(guard.check({ name: "t", args: new Map([["b", 2]]) }).action, "continue");
    assert.equal(guard.check({ name: "t", args: new Set([1, 2]) }).action, "continue");
    assert.equal(guard.check({ name: "t", args: new Set([3, 4]) }).action, "continue");
    assert.equal(guard.check({ name: "t", args: /foo/g }).action, "continue");
    assert.equal(guard.check({ name: "t", args: /bar/i }).action, "continue");
    assert.equal(guard.check({ name: "t", args: new URL("https://example.com/a") }).action, "continue");
    assert.equal(guard.check({ name: "t", args: new URL("https://example.com/b") }).action, "continue");
    assert.equal(guard.check({ name: "t", args: new Uint8Array([1, 2]) }).action, "continue");
    assert.equal(guard.check({ name: "t", args: new Uint8Array([1, 3]) }).action, "continue");
    assert.equal(guard.check({ name: "t", args: {} }).action, "continue");
  });

  it("matches equal Map and Set values regardless of insertion order", () => {
    const guard = createLoopGuard({ maxRepeats: 2, warnings: 0 });
    guard.check({ name: "m", args: new Map([["a", 1], ["b", 2]]) });
    assert.equal(guard.check({ name: "m", args: new Map([["b", 2], ["a", 1]]) }).action, "stop");

    guard.reset();
    guard.check({ name: "s", args: new Set([1, 2]) });
    assert.equal(guard.check({ name: "s", args: new Set([2, 1]) }).action, "stop");
  });

  it("tells 1 from '1'", () => {
    const guard = createLoopGuard({ maxRepeats: 2, warnings: 0 });
    guard.check({ name: "t", args: 1 });
    assert.equal(guard.check({ name: "t", args: "1" }).action, "continue");
  });

  it("works with no options", () => {
    assert.equal(createLoopGuard().check(search("a")).action, "continue");
  });
});
