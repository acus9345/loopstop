const CONTINUE = Object.freeze({ action: "continue", code: "ok", reason: "" });
const NEXT_MOVE = "Try a different approach, or finish with what you have.";
export function createLoopGuard(options = {}) {
    const { maxSteps = Infinity, maxMs = Infinity, maxCost = Infinity, maxRepeats = 3, maxCycles = 3, maxStale = 5, maxPeriod = 4, warnings = 1, warnAt = 0.8, window = 50, normalize = (result) => result, now = Date.now, } = options;
    const ignore = new Set(options.ignore);
    let started = now();
    let steps = 0;
    let cost = 0;
    let stale = 0;
    let history = [];
    let stopped;
    const softWarned = new Set();
    function settle(step, result) {
        const value = fingerprint(normalize(result));
        stale = history.some((other) => other !== step && other.result === value) ? stale + 1 : 0;
        step.result = value;
    }
    function repeats(step) {
        let count = 0;
        let last;
        let same = false;
        for (let i = history.length - 1; i >= 0; i--) {
            const other = history[i];
            if (other.key !== step.key)
                continue;
            // A different result means the call made progress, as polling does.
            if (last !== undefined && other.result !== undefined && other.result !== last)
                break;
            if (other.result !== undefined) {
                same ||= last !== undefined;
                last = other.result;
            }
            count++;
        }
        return { count, same };
    }
    function cycle() {
        let best = { count: 0, names: [] };
        for (let period = 2; period <= maxPeriod; period++) {
            const tail = history.slice(-period);
            if (tail.length < period || new Set(tail.map((step) => step.key)).size < 2)
                continue;
            let matched = 0;
            for (let i = history.length - 1; i >= period && alike(history[i], history[i - period]); i--)
                matched++;
            const count = Math.floor(matched / period) + 1;
            if (count >= 2 && count > best.count)
                best = { count, names: [...new Set(tail.map((step) => step.name))] };
        }
        return best;
    }
    function grade(count, limit) {
        if (count >= limit + warnings)
            return "stop";
        return count >= limit ? "warn" : "continue";
    }
    function stop(code, reason, count) {
        stopped = verdict("stop", code, reason, count);
        return stopped;
    }
    function hardLimit(elapsed) {
        if (steps > maxSteps)
            return stop("steps", `Step limit reached (${maxSteps}). Stop and finish with what you have.`);
        if (elapsed >= maxMs)
            return stop("time", `Time limit reached (${seconds(maxMs)}). Stop and finish with what you have.`);
        if (cost >= maxCost)
            return stop("cost", `Cost limit reached (${cost} of ${maxCost}). Stop and finish with what you have.`);
        return undefined;
    }
    function softLimit(elapsed) {
        const near = [
            ["steps", steps, maxSteps, `You've used ${steps} of ${maxSteps} steps. Wrap up soon.`],
            ["time", elapsed, maxMs, `You've used ${seconds(elapsed)} of ${seconds(maxMs)}. Wrap up soon.`],
            ["cost", cost, maxCost, `You've spent ${cost} of ${maxCost}. Wrap up soon.`],
        ];
        for (const [code, used, limit, reason] of near) {
            if (softWarned.has(code) || !Number.isFinite(limit) || used < limit * warnAt || warnAt >= 1)
                continue;
            softWarned.add(code);
            return verdict("warn", code, reason);
        }
        return undefined;
    }
    function pattern(step) {
        const found = [];
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
            if (stopped)
                return stopped;
            steps++;
            cost += call.cost ?? 0;
            const step = { key: fingerprint([call.name, call.args]), name: call.name, result: undefined };
            const watched = !ignore.has(call.name);
            if (watched) {
                history.push(step);
                if (history.length > window)
                    history.shift();
                if ("result" in call)
                    settle(step, call.result);
            }
            const elapsed = now() - started;
            const limit = hardLimit(elapsed);
            if (limit)
                return limit;
            const found = watched ? pattern(step) : undefined;
            if (found?.action === "stop")
                return stop(found.code, found.reason, found.count);
            return found ?? softLimit(elapsed) ?? CONTINUE;
        },
        result(call, result, amount) {
            cost += amount ?? 0;
            const key = fingerprint([call.name, call.args]);
            for (let i = history.length - 1; i >= 0; i--) {
                const step = history[i];
                if (step.key === key && step.result === undefined)
                    return settle(step, result);
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
function verdict(action, code, reason, count) {
    return count === undefined ? { action, code, reason } : { action, code, reason, count };
}
function alike(a, b) {
    return a.key === b.key && (a.result === undefined || b.result === undefined || a.result === b.result);
}
function seconds(ms) {
    return `${Math.round(ms / 1000)}s`;
}
function fingerprint(value) {
    return hash(stable(value, new Set()));
}
/** JSON-like text with sorted keys, safe for cycles, bigints and errors. */
function stable(value, parents) {
    if (typeof value === "string")
        return JSON.stringify(value);
    if (typeof value !== "object" || value === null)
        return `${typeof value}:${String(value)}`;
    if (parents.has(value))
        return "[circular]";
    if (value instanceof Date)
        return `date:${value.getTime()}`;
    if (value instanceof Error)
        return `error:${value.name}:${value.message}`;
    parents.add(value);
    const text = Array.isArray(value)
        ? `[${value.map((item) => stable(item, parents)).join(",")}]`
        : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key], parents)}`).join(",")}}`;
    parents.delete(value);
    return text;
}
/** cyrb53: small and dependency free, so long results don't sit in memory. */
function hash(text) {
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
