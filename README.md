# loopstop

A small guard you call once per agent step. It tells you to continue, warn or stop.

[![npm](https://img.shields.io/npm/v/loopstop)](https://www.npmjs.com/package/loopstop)
[![CI](https://github.com/acus9345/loopstop/actions/workflows/ci.yml/badge.svg)](https://github.com/acus9345/loopstop/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/loopstop)](LICENSE)

Agents get stuck. They run the same search again, bounce between two tools, or keep reading pages that say nothing new, and the bill keeps growing. `loopstop` watches the calls and tells your loop when to step in.

- **Works with any agent loop.** No SDK, no framework, no dependencies. Your loop passes in a tool name and arguments.
- **Catches the real patterns:** the same call repeated, ping-pong like A, B, A, B, results with nothing new, and hard limits on steps, time and cost.
- **Warnings the model can read.** A `warn` verdict carries text you can feed straight back: "You've called search 3 times with the same arguments and got the same result."
- **Knows polling from looping.** Repeating a call is fine while its result keeps changing.

## Install

```bash
npm install loopstop
```

## Quick start

```ts
import { createLoopGuard } from "loopstop";

const guard = createLoopGuard({ maxSteps: 40, maxMs: 120_000, maxRepeats: 3 });

for (const call of toolCalls) {
  const verdict = guard.check(call); // { action: "continue" | "warn" | "stop", code, reason }
  if (verdict.action === "stop") break;

  const result = await runTool(call);
  guard.result(call, result); // optional, but it unlocks result-aware checks

  // verdict.reason is written for the model
  if (verdict.action === "warn") messages.push({ role: "user", content: verdict.reason });
}
```

`call` is `{ name, args }`. Extra fields are ignored, so you can usually pass your tool call straight in once `name` and `args` are set.

## What it checks

| Code | Triggers on | Default |
| --- | --- | --- |
| `repeat` | The same tool with the same arguments. Arguments are compared by value, so key order doesn't matter. | Warn at 3 calls |
| `cycle` | A pattern of 2 to 4 calls repeating, such as A, B, A, B. | Warn at 3 rounds |
| `stale` | Results in a row that match an earlier result. Needs `guard.result()`. | Warn at 5 results |
| `steps` | More than `maxSteps` calls. | Off |
| `time` | `maxMs` milliseconds since the guard was created. | Off |
| `cost` | `maxCost` reached. | Off |

Patterns warn first. If the model keeps going, the next trigger stops the run. Set `warnings: 0` to stop straight away. Limits warn once at 80% of the way there and stop when they're reached.

A stop is final: every later `check()` returns the same verdict until you call `guard.reset()`.

## Tracking cost

Use any unit you like. `maxCost` is just a number.

```ts
const guard = createLoopGuard({ maxCost: 2 });

guard.check({ name: "search", args, cost: 0.01 }); // with the call
guard.result(call, output, 0.01); // with the result
guard.addCost(response.costUsd); // for anything else, such as a model turn
```

For a limit that is enforced on the LLM client itself, see [spendcap](https://www.npmjs.com/package/spendcap).

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `maxSteps` | none | Most steps allowed. |
| `maxMs` | none | Most milliseconds allowed. |
| `maxCost` | none | Most total cost allowed. |
| `maxRepeats` | `3` | Identical calls before a warning. |
| `maxCycles` | `3` | Rounds of a pattern before a warning. |
| `maxStale` | `5` | Results with nothing new before a warning. |
| `maxPeriod` | `4` | Longest pattern to look for, in calls. |
| `warnings` | `1` | Warnings before a pattern becomes a stop. |
| `warnAt` | `0.8` | Share of a limit that triggers its one warning. `1` turns it off. |
| `window` | `50` | Recent calls to remember. |
| `ignore` | `[]` | Tool names to leave out of pattern checks, such as `sleep`. They still count as steps. |
| `normalize(result)` | identity | Reduce a result before comparing it, for example to drop timestamps. |
| `now()` | `Date.now` | Clock, for tests. |

`guard.stats()` returns `{ steps, cost, elapsedMs, stopped }`.

## Limits

- Create one guard per run. Time counts from when the guard was created.
- It compares exact values. A result that changes only in a timestamp counts as new unless `normalize` removes it, and two searches that differ by one word count as different calls.
- It can't see meaning. An agent that does something useless in a new way each time gets through until a limit stops it, so set `maxSteps` as well as the pattern checks.

## License

MIT
