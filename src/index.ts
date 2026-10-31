export type Action = "continue" | "warn" | "stop";

/** Why a verdict was given. `ok` means nothing is wrong. */
export type Code = "ok" | "repeat" | "cycle" | "stale" | "steps" | "time" | "cost";

export interface Call {
  /** Tool name. */
  name: string;
  /** Tool arguments. Compared by value, so key order doesn't matter. */
  args?: unknown;
  /** Tool result, if you already have it. Otherwise report it later with `guard.result()`. */
  result?: unknown;
  /** Cost of this step in any unit, counted against `maxCost`. */
  cost?: number;
}

export interface Verdict {
  action: Action;
  code: Code;
  /** Empty on `continue`. Otherwise plain text you can feed back to the model. */
  reason: string;
  /** How many repeats, rounds or stale results triggered this verdict. */
  count?: number;
}

export interface LoopGuardOptions {
  /** Most steps allowed. The next `check()` stops. Default: no limit. */
  maxSteps?: number;
  /** Most milliseconds allowed since the guard was created. Default: no limit. */
  maxMs?: number;
  /** Most total cost allowed. Default: no limit. */
  maxCost?: number;
  /** Identical calls before a warning. Default 3. */
  maxRepeats?: number;
  /** Full rounds of a pattern like A, B, A, B before a warning. Default 3. */
  maxCycles?: number;
  /** Results in a row with nothing new before a warning. Default 5. */
  maxStale?: number;
  /** Longest pattern to look for, in calls. Default 4. */
  maxPeriod?: number;
  /** Warnings before a pattern becomes a stop. 0 stops straight away. Default 1. */
  warnings?: number;
  /** Warn once at this share of `maxSteps`, `maxMs` or `maxCost`. Default 0.8. Set 1 to turn off. */
  warnAt?: number;
  /** How many recent calls to remember. Default 50. */
  window?: number;
  /** Tools to leave out of pattern checks, such as `sleep`. They still count as steps. */
  ignore?: string[];
  /** Reduce a result to what matters, for example by dropping timestamps, before comparing. */
  normalize?: (result: unknown) => unknown;
  /** Clock in milliseconds, for tests. Default `Date.now`. */
  now?: () => number;
}

export interface LoopGuardStats {
  steps: number;
  cost: number;
  elapsedMs: number;
  stopped: boolean;
}

export interface LoopGuard {
  /** Call once per step, before running the tool. */
  check(call: Call): Verdict;
  /** Report what a call returned, so the guard can tell polling from looping. */
  result(call: Pick<Call, "name" | "args">, result: unknown, cost?: number): void;
  /** Add cost that isn't tied to a tool call, such as a model turn. */
  addCost(amount: number): void;
  stats(): LoopGuardStats;
  /** Forget everything and start a new run. */
  reset(): void;
}

interface Step {
  key: string;
  name: string;
  result: string | undefined;
}

const CONTINUE: Verdict = Object.freeze({ action: "continue", code: "ok", reason: "" });
const NEXT_MOVE = "Try a different approach, or finish with what you have.";

export function createLoopGuard(options: LoopGuardOptions = {}): LoopGuard {
  const {
    maxSteps = Infinity,
    maxMs = Infinity,
    maxCost = Infinity,
    maxRepeats = 3,
    maxCycles = 3,
    maxStale = 5,
    maxPeriod = 4,
    warnings = 1,
    warnAt = 0.8,
    window = 50,
    normalize = (result: unknown) => result,
    now = Date.now,
  } = options;
  const ignore = new Set(options.ignore);

  let started = now();
  let steps = 0;
  let cost = 0;
  let stale = 0;
  let history: Step[] = [];
  let stopped: Verdict | undefined;
  const softWarned = new Set<Code>();

  function settle(step: Step, result: unknown): void {
    const value = fingerprint(normalize(result));
    stale = history.some((other) => other !== step && other.result === value) ? stale + 1 : 0;
    step.result = value;
  }

  function repeats(step: Step): { count: number; same: boolean } {
    let count = 0;
    let last: string | undefined;
    let same = false;
    for (let i = history.length - 1; i >= 0; i--) {
      const other = history[i]!;
      if (other.key !== step.key) continue;
      // A different result means the call made progress, as polling does.
      if (last !== undefined && other.result !== undefined && other.result !== last) break;
      if (other.result !== undefined) {
        same ||= last !== undefined;
        last = other.result;
      }
      count++;
    }
    return { count, same };
  }

  function cycle(): { count: number; names: string[] } {
    let best = { count: 0, names: [] as string[] };
    for (let period = 2; period <= maxPeriod; period++) {
      const tail = history.slice(-period);
      if (tail.length < period || new Set(tail.map((step) => step.key)).size < 2) continue;
      let matched = 0;
      for (let i = history.length - 1; i >= period && alike(history[i]!, history[i - period]!); i--) matched++;
      const count = Math.floor(matched / period) + 1;
      if (count >= 2 && count > best.count) best = { count, names: [...new Set(tail.map((step) => step.name))] };
    }
    return best;
  }

  function grade(count: number, limit: number): Action {
    if (count >= limit + warnings) return "stop";
    return count >= limit ? "warn" : "continue";
  }

  function stop(code: Code, reason: string, count?: number): Verdict {
    stopped = verdict("stop", code, reason, count);
    return stopped;
  }

  function hardLimit(elapsed: number): Verdict | undefined {
    if (steps > maxSteps) return stop("steps", `Step limit reached (${maxSteps}). Stop and finish with what you have.`);
    if (elapsed >= maxMs) return stop("time", `Time limit reached (${seconds(maxMs)}). Stop and finish with what you have.`);
    if (cost >= maxCost) return stop("cost", `Cost limit reached (${cost} of ${maxCost}). Stop and finish with what you have.`);
    return undefined;
  }

  function softLimit(elapsed: number): Verdict | undefined {
    const near: [Code, number, number, string][] = [
      ["steps", steps, maxSteps, `You've used ${steps} of ${maxSteps} steps. Wrap up soon.`],
      ["time", elapsed, maxMs, `You've used ${seconds(elapsed)} of ${seconds(maxMs)}. Wrap up soon.`],
      ["cost", cost, maxCost, `You've spent ${cost} of ${maxCost}. Wrap up soon.`],
    ];
    for (const [code, used, limit, reason] of near) {
      if (softWarned.has(code) || !Number.isFinite(limit) || used < limit * warnAt || warnAt >= 1) continue;
      softWarned.add(code);
      return verdict("warn", code, reason);
    }
    return undefined;
  }

  function pattern(step: Step): Verdict | undefined {
    const found: Verdict[] = [];
    const repeated = repeats(step);
    const repeatAction = grade(repeated.count, maxRepeats);
    if (repeatAction !== "continue") {
      const result = repeated.same ? " and got the same result" : "";
      found.push(verdict(repeatAction, "repeat", `You've called ${step.name} ${repeated.count} times with the same arguments${result}. ${NEXT_MOVE}`, repeated.count));
    }
    const looped = cycle();
    const cycleAction = grade(looped.count, maxCycles);
    if (cycleAction !== "continue") {
      found.push(verdict(cycleAction, "cycle", `You've gone back and forth between ${looped.names.join(", ")} ${looped.count} times. ${NEXT_MOVE}`, looped.count));
    }
    const staleAction = grade(stale, maxStale);
    if (staleAction !== "continue") {
      found.push(verdict(staleAction, "stale", `Your last ${stale} tool results had nothing new in them. ${NEXT_MOVE}`, stale));
    }
    return found.find((item) => item.action === "stop") ?? found[0];
  }

  return {
    check(call) {
      if (stopped) return stopped;
      steps++;
      cost += call.cost ?? 0;
      const step: Step = { key: fingerprint([call.name, call.args]), name: call.name, result: undefined };
      const watched = !ignore.has(call.name);
      if (watched) {
        history.push(step);
        if (history.length > window) history.shift();
        if ("result" in call) settle(step, call.result);
      }
      const elapsed = now() - started;
      const limit = hardLimit(elapsed);
      if (limit) return limit;
      const found = watched ? pattern(step) : undefined;
      if (found?.action === "stop") return stop(found.code, found.reason, found.count);
      return found ?? softLimit(elapsed) ?? CONTINUE;
    },
    result(call, result, amount) {
      cost += amount ?? 0;
      const key = fingerprint([call.name, call.args]);
      for (let i = history.length - 1; i >= 0; i--) {
        const step = history[i]!;
        if (step.key === key && step.result === undefined) return settle(step, result);
      }
    },
    addCost(amount) {
      cost += amount;
    },
    stats() {
      return { steps, cost, elapsedMs: now() - started, stopped: stopped !== undefined };
    },
    reset() {
      started = now();
      steps = 0;
      cost = 0;
      stale = 0;
      history = [];
      stopped = undefined;
      softWarned.clear();
    },
  };
}

function verdict(action: Action, code: Code, reason: string, count?: number): Verdict {
  return count === undefined ? { action, code, reason } : { action, code, reason, count };
}

function alike(a: Step, b: Step): boolean {
  return a.key === b.key && (a.result === undefined || b.result === undefined || a.result === b.result);
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

function fingerprint(value: unknown): string {
  return hash(stable(value, new Set()));
}

/** JSON-like text with sorted keys, safe for cycles, bigints and errors. */
function stable(value: unknown, parents: Set<object>): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object" || value === null) return `${typeof value}:${String(value)}`;
  if (parents.has(value)) return "[circular]";
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (value instanceof Error) return `error:${value.name}:${value.message}`;
  parents.add(value);
  const text = Array.isArray(value)
    ? `[${value.map((item) => stable(item, parents)).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key], parents)}`).join(",")}}`;
  parents.delete(value);
  return text;
}

/** cyrb53: small and dependency free, so long results don't sit in memory. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
