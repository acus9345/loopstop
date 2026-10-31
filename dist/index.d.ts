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
export declare function createLoopGuard(options?: LoopGuardOptions): LoopGuard;
