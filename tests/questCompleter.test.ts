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

function makeDispatcher() {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    return {
        listeners,
        dispatcher: {
            subscribe(event: string, listener: (event: unknown) => void) {
                const eventListeners = listeners.get(event) ?? new Set();
                eventListeners.add(listener);
                listeners.set(event, eventListeners);
            },
            unsubscribe(event: string, listener: (event: unknown) => void) {
                listeners.get(event)?.delete(listener);
            }
        },
        emit(event: string, payload: unknown) {
            listeners.get(event)?.forEach(listener => listener(payload));
        }
    };
}

/** Manual clock: timers and polls are recorded, `advance` fires what is due. */
function makeTimers() {
    let nextId = 1;
    let now = 0;
    const timers = new Map<number, { at: number; fn: () => void; }>();
    const polls = new Map<number, { every: number; next: number; fn: () => void; }>();
    return {
        setTimer: (fn: () => void, ms: number) => {
            const id = nextId++;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimer: (id: unknown) => { timers.delete(id as number); },
        setPoll: (fn: () => void, ms: number) => {
            const id = nextId++;
            polls.set(id, { every: ms, next: now + ms, fn });
            return id;
        },
        clearPoll: (id: unknown) => { polls.delete(id as number); },
        advance(ms: number) {
            const target = now + ms;
            while (true) {
                let soonest = Infinity;
                let fire: (() => void) | undefined;
                for (const [id, t] of timers) {
                    if (t.at <= target && t.at < soonest) {
                        soonest = t.at;
                        fire = () => { timers.delete(id); t.fn(); };
                    }
                }
                for (const p of polls.values()) {
                    if (p.next <= target && p.next < soonest) {
                        soonest = p.next;
                        const poll = p;
                        fire = () => { poll.next += poll.every; poll.fn(); };
                    }
                }
                if (!fire) break;
                now = soonest;
                fire();
            }
            now = target;
        }
    };
}

test("failed Quest heartbeats re-arm the idle watchdog instead of ending the wait", async () => {
    const { dispatcher, emit } = makeDispatcher();
    const timers = makeTimers();
    let cleaned = 0;
    const wait = createHeartbeatWait(dispatcher, "quest-1", "PLAY_ON_DESKTOP", 60, () => { cleaned++; }, {
        idleMs: 50,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        setPoll: timers.setPoll,
        clearPoll: timers.clearPoll,
    });
    emit("QUESTS_SEND_HEARTBEAT_SUCCESS", { questId: "quest-1", userStatus: { progress: { PLAY_ON_DESKTOP: { value: 10 } } } });
    timers.advance(40);
    // Discord does not retry a failed beat; the next attempt is the tick ~60s
    // out, so a failure must re-arm the deadline rather than count as silence.
    emit("QUESTS_SEND_HEARTBEAT_FAILURE", { questId: "quest-1", status: 500 });
    timers.advance(40); // past the original 50ms deadline, inside the re-armed one
    assert.equal(cleaned, 0);
    emit("QUESTS_SEND_HEARTBEAT_SUCCESS", { questId: "quest-1", userStatus: { progress: { PLAY_ON_DESKTOP: { value: 60 } } } });
    await wait.promise;
    assert.equal(cleaned, 1);
});

test("consecutive Quest heartbeat failures give up with the real error", async () => {
    const { dispatcher, emit } = makeDispatcher();
    const timers = makeTimers();
    const wait = createHeartbeatWait(dispatcher, "quest-1", "PLAY_ON_DESKTOP", 60, () => { }, {
        idleMs: 10_000,
        maxConsecutiveFailures: 3,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        setPoll: timers.setPoll,
        clearPoll: timers.clearPoll,
    });
    for (let i = 0; i < 3; i++) {
        emit("QUESTS_SEND_HEARTBEAT_FAILURE", { questId: "quest-1", status: 500, body: { message: "upstream exploded" } });
    }
    await assert.rejects(wait.promise, /heartbeat failed 3 times in a row.*upstream exploded/);
});

test("Quest heartbeat wait resolves on Map-shaped progress and completedAt", async () => {
    const { dispatcher, emit } = makeDispatcher();
    const timers = makeTimers();
    const options = {
        idleMs: 10_000,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        setPoll: timers.setPoll,
        clearPoll: timers.clearPoll,
    };
    const wait = createHeartbeatWait(dispatcher, "quest-1", "PLAY_ON_DESKTOP", 60, () => { }, options);
    emit("QUESTS_SEND_HEARTBEAT_SUCCESS", { questId: "quest-1", userStatus: { progress: new Map([["PLAY_ON_DESKTOP", { value: 60 }]]) } });
    await wait.promise;

    const wait2 = createHeartbeatWait(dispatcher, "quest-2", "PLAY_ON_DESKTOP", 60, () => { }, options);
    emit("QUESTS_SEND_HEARTBEAT_SUCCESS", { questId: "quest-2", userStatus: { completedAt: "2026-09-24T10:00:00.000Z" } });
    await wait2.promise;
});

test("full progress without completedAt does not settle passive update or poll", async () => {
    const { dispatcher, emit } = makeDispatcher();
    const timers = makeTimers();
    // Post-restart state: server credited 60/60 but never finalized completedAt.
    // The wait must stay alive so the spoof keeps Discord heartbeating.
    let completedAt: string | undefined;
    let settled = false;
    const wait = createHeartbeatWait(dispatcher, "quest-1", "PLAY_ON_DESKTOP", 60, () => { }, {
        idleMs: 10_000,
        pollMs: 10,
        isComplete: () => completedAt != null,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        setPoll: timers.setPoll,
        clearPoll: timers.clearPoll,
    });
    wait.promise.then(() => { settled = true; }, () => { settled = true; });
    emit("QUESTS_USER_STATUS_UPDATE", { questId: "quest-1", userStatus: { progress: { PLAY_ON_DESKTOP: { value: 60 } } } });
    timers.advance(50); // several polls ran, none may settle
    await flush();
    assert.equal(settled, false);
    completedAt = "2026-09-24T10:00:00.000Z";
    timers.advance(10); // next poll sees completedAt
    await wait.promise;
    assert.equal(settled, true);
});

test("Quest heartbeat wait rejects after the idle window with failure detail", async () => {
    const { dispatcher, emit } = makeDispatcher();
    const timers = makeTimers();
    const wait = createHeartbeatWait(dispatcher, "quest-1", "PLAY_ON_DESKTOP", 60, () => { }, {
        idleMs: 30,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        setPoll: timers.setPoll,
        clearPoll: timers.clearPoll,
    });
    emit("QUESTS_SEND_HEARTBEAT_SUCCESS", { questId: "quest-1", userStatus: { progress: { PLAY_ON_DESKTOP: { value: 10 } } } });
    emit("QUESTS_SEND_HEARTBEAT_FAILURE", { questId: "quest-1", status: 500, body: { message: "upstream exploded" } });
    timers.advance(31);
    await assert.rejects(wait.promise, /heartbeat timeout \(1 credited, 1 failed, last: HTTP 500, upstream exploded\)/);
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

test("enrollment maps Discord's current raw user-status response", () => {
    const status = resolveEnrolledStatus({
        user_id: "user-1",
        quest_id: "quest-1",
        enrolled_at: "2026-08-27T09:00:00.000Z",
        completed_at: null,
        progress: {
            WATCH_VIDEO: { value: 7, event_name: "WATCH_VIDEO", updated_at: "2026-08-27T09:00:07.000Z" }
        }
    }, undefined);

    assert.deepEqual(status, {
        userId: "user-1",
        questId: "quest-1",
        enrolledAt: "2026-08-27T09:00:00.000Z",
        progress: { WATCH_VIDEO: { value: 7 } }
    });
});

test("enrollment accepts legacy wrapped status and falls back to the Quest store", () => {
    const wrapped = resolveEnrolledStatus({ userStatus: { enrolledAt: "2026-08-27T09:00:00.000Z" } }, undefined);
    assert.equal(wrapped?.enrolledAt, "2026-08-27T09:00:00.000Z");

    const fromStore = resolveEnrolledStatus(undefined, { enrolledAt: "2026-08-27T09:30:00.000Z" });
    assert.equal(fromStore?.enrolledAt, "2026-08-27T09:30:00.000Z");

    assert.equal(resolveEnrolledStatus({}, undefined), undefined);
    assert.equal(resolveEnrolledStatus({ completed_at: "2026-08-27T10:00:00.000Z" }, undefined), undefined);
});
