import assert from "node:assert/strict";
import test from "node:test";

import { createDeferredHandler } from "../core/src/userplugins/questCompleter/deferredHandler.ts";
import { isAutomatableQuest } from "../core/src/userplugins/questCompleter/taskSupport.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("Quest Store event handler defers completion until after dispatch", async () => {
    const calls: string[] = [];
    const handler = createDeferredHandler(() => calls.push("completion"));
    calls.push("dispatch:start");
    handler();
    calls.push("dispatch:end");
    assert.deepEqual(calls, ["dispatch:start", "dispatch:end"]);
    await flush();
    assert.deepEqual(calls, ["dispatch:start", "dispatch:end", "completion"]);
});

test("Quest Store event storms coalesce and never overlap completion", async () => {
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const handler = createDeferredHandler(async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>(resolve => resolvers.push(resolve));
        active--;
    });
    handler(); handler(); handler();
    await flush();
    assert.equal(runs, 1);
    handler(); handler();
    resolvers.shift()!();
    await flush();
    assert.equal(runs, 2);
    assert.equal(maxActive, 1);
    resolvers.shift()!();
    await flush();
});

test("Quest Store event handler catches rejections and remains usable", async () => {
    const errors: unknown[] = [];
    let runs = 0;
    const handler = createDeferredHandler(async () => {
        runs++;
        if (runs === 1) throw new Error("REST unavailable");
    }, error => errors.push(error));
    handler();
    await flush();
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /REST unavailable/);
    handler();
    await flush();
    assert.equal(runs, 2);
});

test("cancelling a Quest Store event handler drops queued and follow-up work", async () => {
    let runs = 0;
    const queued = createDeferredHandler(() => { runs++; });
    queued();
    queued.cancel();
    await flush();
    assert.equal(runs, 0);
    let release!: () => void;
    const running = createDeferredHandler(async () => {
        runs++;
        await new Promise<void>(resolve => { release = resolve; });
    });
    running();
    await flush();
    running();
    running.cancel();
    release();
    await flush();
    assert.equal(runs, 1);
});

test("restarting Quest Store handling cannot revive stale scheduled work", async () => {
    const calls: string[] = [];
    const stale = createDeferredHandler(() => { calls.push("stale"); });
    stale();
    stale.cancel();
    const current = createDeferredHandler(() => { calls.push("current"); });
    current();
    await flush();
    assert.deepEqual(calls, ["current"]);
});

test("activity achievement quests are excluded from automatic completion", () => {
    assert.equal(isAutomatableQuest({ ACHIEVEMENT_IN_ACTIVITY: { target: 1 } }), false);
    assert.equal(isAutomatableQuest({ WATCH_VIDEO: { target: 60 } }), true);
});
