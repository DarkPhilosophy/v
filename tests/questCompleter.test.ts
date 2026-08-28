import assert from "node:assert/strict";
import test from "node:test";

import { createDeferredHandler } from "../core/src/userplugins/questCompleter/deferredHandler.ts";
import { isAutomatableQuest } from "../core/src/userplugins/questCompleter/taskSupport.ts";
import { createHeartbeatWait, getCompletionBatch, getEnrollmentBatch, getNextAutomationDelayMs, getRateLimitDelayMs, resolveEnrolledStatus, runConcurrentQuestBatch } from "../core/src/userplugins/questCompleter/resilience.ts";

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

test("Quest heartbeat wait rejects and cleans up when the gateway closes", async () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const dispatcher = {
        subscribe(event: string, listener: (event: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(listener);
            listeners.set(event, eventListeners);
        },
        unsubscribe(event: string, listener: (event: unknown) => void) {
            listeners.get(event)?.delete(listener);
        }
    };
    let cleaned = 0;
    const wait = createHeartbeatWait(dispatcher, "quest-1", "PLAY_ON_DESKTOP", 60, () => { cleaned++; });
    listeners.get("CONNECTION_CLOSED")?.forEach(listener => listener({}));
    await assert.rejects(wait.promise, /Gateway connection closed/);
    assert.equal(cleaned, 1);
    assert.equal([...listeners.values()].reduce((sum, entries) => sum + entries.size, 0), 0);
});

test("Quest heartbeat wait ignores other quests and resolves on target completion", async () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const dispatcher = {
        subscribe(event: string, listener: (event: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(listener);
            listeners.set(event, eventListeners);
        },
        unsubscribe(event: string, listener: (event: unknown) => void) {
            listeners.get(event)?.delete(listener);
        }
    };
    let cleaned = 0;
    const wait = createHeartbeatWait(dispatcher, "quest-1", "PLAY_ON_DESKTOP", 60, () => { cleaned++; });
    listeners.get("QUESTS_SEND_HEARTBEAT_SUCCESS")?.forEach(listener =>
        listener({ questId: "quest-2", userStatus: { progress: { PLAY_ON_DESKTOP: { value: 60 } } } })
    );
    listeners.get("QUESTS_SEND_HEARTBEAT_SUCCESS")?.forEach(listener =>
        listener({ questId: "quest-1", userStatus: { progress: { WATCH_VIDEO: { value: 60 }, PLAY_ON_DESKTOP: { value: 10 } } } })
    );
    assert.equal(cleaned, 0);
    listeners.get("QUESTS_SEND_HEARTBEAT_SUCCESS")?.forEach(listener =>
        listener({ questId: "quest-1", userStatus: { progress: { PLAY_ON_DESKTOP: { value: 60 } } } })
    );
    await wait.promise;
    assert.equal(cleaned, 1);
});

test("transient Quest heartbeat failures keep waiting for later progress", async () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const dispatcher = {
        subscribe(event: string, listener: (event: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(listener);
            listeners.set(event, eventListeners);
        },
        unsubscribe(event: string, listener: (event: unknown) => void) {
            listeners.get(event)?.delete(listener);
        }
    };
    let cleaned = 0;
    const wait = createHeartbeatWait(dispatcher, "quest-1", "PLAY_ON_DESKTOP", 60, () => { cleaned++; });
    listeners.get("QUESTS_SEND_HEARTBEAT_FAILURE")?.forEach(listener =>
        listener({ questId: "quest-1", status: 500 })
    );
    assert.equal(cleaned, 0);
    listeners.get("QUESTS_SEND_HEARTBEAT_SUCCESS")?.forEach(listener =>
        listener({ questId: "quest-1", userStatus: { progress: { PLAY_ON_DESKTOP: { value: 60 } } } })
    );
    await wait.promise;
    assert.equal(cleaned, 1);
});

test("Quest auto-enroll honors Discord retry_after and ignores non-rate-limit errors", () => {
    assert.equal(getRateLimitDelayMs({ status: 429, body: { retry_after: 2.5 } }), 2_500);
    assert.equal(getRateLimitDelayMs({ status: 429, body: { retry_after: 0 } }), 1_000);
    assert.equal(getRateLimitDelayMs({ status: 500, body: { retry_after: 2 } }), undefined);
});

test("Quest auto-enroll limits each scan to a bounded batch", () => {
    assert.deepEqual(getEnrollmentBatch([1, 2, 3, 4, 5, 6, 7]), [1, 2, 3, 4, 5]);
});

test("automatic Quest completion includes video and play work in mixed batches", () => {
    const quests = ["play-1", "play-2", "play-3", "play-4", "play-5", "video-1", "video-2"];
    assert.deepEqual(
        getCompletionBatch(quests, quest => quest.startsWith("video")),
        ["video-1", "video-2", "play-1", "play-2", "play-3"]
    );
});

test("automatic Quest completion backs off failed batches and resets after progress", () => {
    assert.equal(getNextAutomationDelayMs(0, 5_000), 10_000);
    assert.equal(getNextAutomationDelayMs(0, 60_000), 60_000);
    assert.equal(getNextAutomationDelayMs(1, 40_000), 5_000);
});

test("video quests run concurrently while play quests stay serial", async () => {
    const active: string[] = [];
    const peak: string[][] = [];
    const { promise: releaseVideos, resolve } = Promise.withResolvers<void>();
    const worker = async (quest: string) => {
        active.push(quest);
        peak.push([...active]);
        if (quest.startsWith("video")) await releaseVideos;
        active.splice(active.indexOf(quest), 1);
    };
    const run = runConcurrentQuestBatch(
        ["video-1", "play-1", "video-2", "play-2", "video-3", "video-4"],
        quest => quest.startsWith("video"),
        worker,
        3
    );
    await flush();
    assert.equal(peak.some(snapshot => snapshot.filter(quest => quest.startsWith("video")).length === 3), true);
    assert.equal(peak.some(snapshot => snapshot.includes("play-1") && snapshot.includes("play-2")), false);
    resolve();
    await run;
});

test("enrollment falls back to store status, then to a synthetic enrolledAt", () => {
    const now = new Date("2026-08-27T10:00:00.000Z");
    const fromResponse = resolveEnrolledStatus({ enrolledAt: "2026-08-27T09:00:00.000Z" }, undefined, now);
    assert.equal(fromResponse?.enrolledAt, "2026-08-27T09:00:00.000Z");

    const fromStore = resolveEnrolledStatus(undefined, { enrolledAt: "2026-08-27T09:30:00.000Z" }, now);
    assert.equal(fromStore?.enrolledAt, "2026-08-27T09:30:00.000Z");

    const synthetic = resolveEnrolledStatus(undefined, undefined, now);
    assert.equal(synthetic?.enrolledAt, now.toISOString());

    assert.equal(resolveEnrolledStatus({ completedAt: now.toISOString() }, undefined, now), undefined);
});
