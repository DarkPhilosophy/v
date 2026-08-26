import assert from "node:assert/strict";
import test from "node:test";

import {
    computeWindow,
    isPruningActive,
    parseSyncedState,
    saveChannelPolicySettings,
    setChannelPolicy,
    setGuildEnabled,
    setMessageKept,
    validatePolicy,
    type ChannelPolicy,
} from "../core/src/userplugins/privacyPruner/model.ts";
import { applyDefaultPolicy, classifyAutoApplyTarget, DEFAULT_PRUNING_TEMPLATE, registerNewId } from "../core/src/userplugins/privacyPruner/defaults.ts";
import { collectEligibleMessages, deleteEligibleMessages, type PrunableMessage, type PruningApi } from "../core/src/userplugins/privacyPruner/engine.ts";
import { durationFromParts, durationToParts, formatDuration, formatElapsedDuration, parseDuration } from "../core/src/userplugins/privacyPruner/duration.ts";
import * as guards from "../core/src/userplugins/privacyPruner/guards.ts";
import { parseChannelHistoryPage, parseMessageAroundPage, parseMessageDetail, parseSearchPage } from "../core/src/userplugins/privacyPruner/history.ts";
import { nextChannelDeadline, partitionDueMessages } from "../core/src/userplugins/privacyPruner/scheduler.ts";

const DAY = 24 * 60 * 60 * 1000;
const policy: ChannelPolicy = {
    enabled: true,
    retentionMs: 7 * DAY,
    maximumLookbackMs: 30 * DAY,
    scanIntervalMs: DAY,
};

test("new messages preempt historical work at their retention deadline", () => {
    const pending = [
        { id: "later", channelId: "channel", timestamp: 1_000, dueAt: 61_000 },
        { id: "first", channelId: "channel", timestamp: 500, dueAt: 60_500 },
    ];
    assert.equal(nextChannelDeadline(120_000, pending), 60_500);
    assert.deepEqual(partitionDueMessages(pending, 60_500), {
        due: [pending[1]],
        future: [pending[0]],
    });
});

test("guild and channel switches must both be enabled", () => {
    assert.equal(isPruningActive({ guildEnabled: true, channelEnabled: true, isDm: false }), true);
    assert.equal(isPruningActive({ guildEnabled: true, channelEnabled: false, isDm: false }), false);
    assert.equal(isPruningActive({ guildEnabled: false, channelEnabled: true, isDm: false }), false);
    assert.equal(isPruningActive({ guildEnabled: false, channelEnabled: true, isDm: true }), true);
});

test("search history must be strictly longer than retention", () => {
    assert.deepEqual(validatePolicy(policy), []);
    assert.deepEqual(validatePolicy({ ...policy, maximumLookbackMs: policy.retentionMs }), [
        "Search history must be longer than retention."
    ]);
    assert.deepEqual(validatePolicy({ ...policy, retentionMs: 0 }), [
        "Retention must be greater than zero."
    ]);
});

test("custom durations accept seconds through years", () => {
    assert.equal(parseDuration("30s"), 30_000);
    assert.equal(parseDuration("7d"), 7 * DAY);
    assert.equal(parseDuration("5y"), 5 * 365 * DAY);
    assert.equal(parseDuration("7"), undefined);
    assert.equal(formatDuration(30 * DAY), "30d");
});

test("structured duration controls convert numbers and units without duration strings", () => {
    assert.equal(durationFromParts("24", "hours"), DAY);
    assert.equal(durationFromParts("1", "years"), 365 * DAY);
    assert.equal(durationFromParts("0", "days"), undefined);
    assert.deepEqual(durationToParts(365 * DAY), { value: "1", unit: "years" });
    assert.deepEqual(durationToParts(90 * 60_000), { value: "90", unit: "minutes" });
});

test("default template applies once to selected new conversation types", () => {
    const state = parseSyncedState("");
    const guildState = applyDefaultPolicy(state, {
        id: "channel",
        guildId: "guild",
        target: "guild",
    }, {
        template: DEFAULT_PRUNING_TEMPLATE,
        autoApply: { guild: true, dm: false, groupDm: false },
    });
    assert.equal(guildState.guilds.guild.enabled, true);
    assert.deepEqual(guildState.channels.channel.policy, {
        enabled: true,
        retentionMs: DAY,
        maximumLookbackMs: 365 * DAY,
        scanIntervalMs: 2 * 60 * 60 * 1000,
        includeThreads: true,
    });
    assert.equal(applyDefaultPolicy(guildState, {
        id: "dm",
        guildId: null,
        target: "dm",
    }, {
        template: DEFAULT_PRUNING_TEMPLATE,
        autoApply: { guild: true, dm: false, groupDm: false },
    }), guildState);
    assert.equal(classifyAutoApplyTarget({ type: 1 }), "dm");
    assert.equal(classifyAutoApplyTarget({ type: 3 }), "groupDm");
});

test("baseline ids are ignored and genuinely new ids register once", () => {
    const known = new Set(["existing"]);
    assert.equal(registerNewId(known, "existing"), false);
    assert.equal(registerNewId(known, "new"), true);
    assert.equal(registerNewId(known, "new"), false);
});

test("elapsed scan progress uses contextual compound durations", () => {
    assert.equal(formatElapsedDuration(3_600_000), "1h");
    assert.equal(formatElapsedDuration(9 * DAY + 6 * 3_600_000), "1w 2d 6h");
    assert.equal(formatElapsedDuration(365 * DAY + 2 * DAY), "1y 2d");
});
test("structured Discord failures render a useful message", () => {
    assert.equal(typeof guards.formatUnknownError, "function");
    assert.equal(
        guards.formatUnknownError?.({
            status: 202,
            body: {
                message: "Index not yet available. Try again later",
                retry_after: 2,
            },
        }),
        "Index not yet available. Try again later (HTTP 202; retry in 2s)"
    );
    assert.equal(guards.formatUnknownError?.({ code: 50035 }), "{\"code\":50035}");
    assert.equal(typeof guards.getRetryDelayMs, "function");
    assert.equal(guards.getRetryDelayMs?.({ status: 429, body: { retry_after: 12.5 } }), 12_500);
    assert.equal(guards.getRetryDelayMs?.({ status: 500 }), 60_000);
});

test("Discord archived-thread failures are recognized by their API code", () => {
    assert.equal(guards.isArchivedThreadError?.({
        status: 400,
        body: { code: 50083, message: "Thread is archived" },
    }), true);
    assert.equal(guards.isArchivedThreadError?.({
        status: 400,
        body: { code: 50035, message: "Invalid Form Body" },
    }), false);
});
test("filtered search keeps only matching hits and paginates by the oldest accepted hit", () => {
    const page = parseSearchPage({
        total_results: 3,
        messages: [
            [
                {
                    id: "context",
                    channel_id: "channel",
                    author: { id: "someone-else" },
                    timestamp: "2026-01-01T00:00:00.000Z",
                    content: "context, not a hit",
                },
                {
                    id: "newest",
                    channel_id: "channel",
                    author: { id: "me" },
                    timestamp: "2026-02-01T00:00:00.000Z",
                    content: "newest hit",
                    hit: true,
                },
            ],
            [{
                id: "oldest",
                channel_id: "channel",
                author: { id: "me" },
                timestamp: "2026-01-15T00:00:00.000Z",
                content: "oldest hit",
                hit: true,
            }],
            [{
                id: "wrong-channel",
                channel_id: "other-channel",
                author: { id: "me" },
                timestamp: "2025-12-01T00:00:00.000Z",
                content: "mismatched hit",
                hit: true,
            }],
        ],
    }, "me", "channel");

    assert.deepEqual(page.messages.map(message => message.id), ["newest", "oldest"]);
    assert.equal(page.inspectedCount, 2);
    assert.equal(page.nextBeforeId, "oldest");
});

test("parent search includes matching hits from its threads when enabled", () => {
    const page = parseSearchPage({
        total_results: 2,
        threads: [
            {
                id: "thread",
                parent_id: "channel",
                thread_metadata: { archived: true },
            },
        ],
        messages: [
            [{
                id: "parent-message",
                channel_id: "channel",
                author: { id: "me" },
                timestamp: "2026-02-01T00:00:00.000Z",
                hit: true,
            }],
            [{
                id: "thread-message",
                channel_id: "thread",
                author: { id: "me" },
                timestamp: "2026-01-15T00:00:00.000Z",
                hit: true,
            }],
        ],
    }, "me", "channel", true);

    assert.deepEqual(page.messages.map(message => message.id), ["parent-message", "thread-message"]);
    assert.equal(page.nextBeforeId, "thread-message");
});

test("filtered search stops when Discord returns no further hits", () => {
    const page = parseSearchPage({ total_results: 0, messages: [] }, "me", "channel");
    assert.deepEqual(page.messages, []);
    assert.equal(page.nextBeforeId, undefined);
});

test("private-channel history filters locally and stops at the lookback boundary", () => {
    const oldestTimestamp = Date.parse("2026-01-01T00:00:00.000Z");
    const page = parseChannelHistoryPage([
        {
            id: "mine",
            channel_id: "dm",
            author: { id: "me" },
            timestamp: "2026-02-01T00:00:00.000Z",
            content: "owned private message",
        },
        {
            id: "theirs",
            channel_id: "dm",
            author: { id: "other" },
            timestamp: "2026-01-15T00:00:00.000Z",
        },
        {
            id: "boundary",
            channel_id: "dm",
            author: { id: "me" },
            timestamp: "2025-12-31T23:59:59.000Z",
        },
    ], "me", oldestTimestamp);

    assert.deepEqual(page.messages.map(message => message.id), ["mine"]);
    assert.equal(page.inspectedCount, 3);
    assert.equal(page.nextBeforeId, undefined);
    assert.equal(page.reachedLookbackLimit, true);
});

test("kept message detail exposes the content needed for a deletion decision", () => {
    assert.deepEqual(parseMessageDetail({
        id: "message",
        channel_id: "channel",
        author: { id: "me" },
        timestamp: "2026-08-22T12:34:56.000Z",
        content: "the actual message text",
    }), {
        id: "message",
        channelId: "channel",
        timestamp: Date.parse("2026-08-22T12:34:56.000Z"),
        content: "the actual message text",
    });
    assert.equal(parseMessageDetail({ id: "broken" }), undefined);
});

test("kept message lookup selects the exact message from a normal around response", () => {
    assert.deepEqual(parseMessageAroundPage([
        {
            id: "before",
            channel_id: "channel",
            author: { id: "me" },
            timestamp: "2026-08-22T12:33:00.000Z",
            content: "nearby",
        },
        {
            id: "target",
            channel_id: "channel",
            author: { id: "me" },
            timestamp: "2026-08-22T12:34:56.000Z",
            content: "the kept message",
        },
    ], "target"), {
        id: "target",
        channelId: "channel",
        timestamp: Date.parse("2026-08-22T12:34:56.000Z"),
        content: "the kept message",
    });
    assert.equal(parseMessageAroundPage([], "target"), undefined);
});



test("retention window includes expired messages without exceeding lookback", () => {
    const now = Date.UTC(2026, 7, 22);
    assert.deepEqual(computeWindow(policy, now), {
        oldestTimestamp: now - 30 * DAY,
        newestTimestamp: now - 7 * DAY,
    });
});

test("synced state stores only explicit guilds, channels, and kept message ids", () => {
    let state = parseSyncedState("");
    state = setGuildEnabled(state, "guild", true);
    state = setChannelPolicy(state, "channel", "guild", { ...policy, includeThreads: true });
    state = setMessageKept(state, { messageId: "message", channelId: "channel", guildId: "guild" }, true);

    assert.equal(state.guilds.guild.enabled, true);
    assert.deepEqual(state.channels.channel.policy, { ...policy, includeThreads: true });
    assert.deepEqual(state.kept.message, { channelId: "channel", guildId: "guild" });
    assert.equal("content" in state.kept.message, false);
    assert.equal(
        parseSyncedState(JSON.stringify(state)).channels.channel.policy.includeThreads,
        true,
    );

    state = setMessageKept(state, { messageId: "message", channelId: "channel", guildId: "guild" }, false);
    assert.equal(state.kept.message, undefined);
});

test("closing settings saves edited values without toggling the active policy", () => {
    const confirmedAt = 123_456;
    const activeState = setChannelPolicy(
        parseSyncedState(""),
        "channel",
        "guild",
        policy,
        confirmedAt,
    );
    const edited = {
        ...policy,
        enabled: false,
        retentionMs: DAY,
        includeThreads: true,
    };
    const saved = saveChannelPolicySettings(activeState, "channel", "guild", edited);

    assert.deepEqual(saved.channels.channel, {
        guildId: "guild",
        policy: {
            ...edited,
            enabled: true,
        },
        confirmedAt,
    });
});

test("preview paginates old history and excludes kept messages", async () => {
    const calls: Array<string | undefined> = [];
    const pages = new Map<string | undefined, { messages: PrunableMessage[]; nextBeforeId?: string; }>([
        [undefined, {
            messages: [
                { id: "30", channelId: "channel", timestamp: 30, content: "new expired" },
                { id: "20", channelId: "channel", timestamp: 20, content: "kept" },
            ],
            nextBeforeId: "20",
        }],
        ["20", {
            messages: [{ id: "10", channelId: "channel", timestamp: 10, content: "old expired" }],
        }],
    ]);
    const api: PruningApi = {
        async listOwnMessagesPage(input) {
            calls.push(input.beforeId);
            return pages.get(input.beforeId)!;
        },
        async deleteOwnMessage() {
            throw new Error("preview must not delete");
        },
    };

    const result = await collectEligibleMessages(api, {
        channelId: "channel",
        guildId: "guild",
        userId: "me",
        oldestTimestamp: 1,
        newestTimestamp: 40,
        keptMessageIds: new Set(["20"]),
    });

    assert.deepEqual(calls, [undefined, "20"]);
    assert.deepEqual(result.messages.map(message => message.id), ["30", "10"]);
    assert.equal(result.keptCount, 1);
});

test("preview reports page progress and preserves partial results when stopped", async () => {
    const controller = new AbortController();
    const snapshots: Array<{
        pagesScanned: number;
        messagesInspected: number;
        ownedMessagesFound: number;
        eligibleMessagesFound: number;
        oldestInspectedTimestamp?: number;
    }> = [];
    let requestCount = 0;
    const api: PruningApi = {
        async listOwnMessagesPage() {
            requestCount++;
            return {
                inspectedCount: 100,
                oldestInspectedTimestamp: 10,
                messages: [{ id: String(requestCount), channelId: "channel", timestamp: 10, content: "expired" }],
                nextBeforeId: String(requestCount),
            };
        },
        async deleteOwnMessage() {
            throw new Error("preview must not delete");
        },
    };

    const result = await collectEligibleMessages(api, {
        channelId: "channel",
        guildId: "guild",
        userId: "me",
        oldestTimestamp: 1,
        newestTimestamp: 40,
        keptMessageIds: new Set(),
    }, {
        signal: controller.signal,
        onProgress(progress) {
            snapshots.push(progress);
            controller.abort();
        },
    });

    assert.equal(requestCount, 1);
    assert.deepEqual(snapshots, [{
        pagesScanned: 1,
        messagesInspected: 100,
        ownedMessagesFound: 1,
        eligibleMessagesFound: 1,
        oldestInspectedTimestamp: 10,
    }]);
    assert.deepEqual(result.messages.map(message => message.id), ["1"]);
    assert.equal(result.stopped, true);
});

test("active pruning consumes candidates page by page without retaining a preview list", async () => {
    const consumed: string[][] = [];
    let page = 0;
    const api: PruningApi = {
        async listOwnMessagesPage() {
            page++;
            return {
                messages: [{ id: String(page), channelId: "channel", timestamp: page, content: "candidate" }],
                nextBeforeId: page === 1 ? "next" : undefined,
            };
        },
        async deleteOwnMessage() {
            throw new Error("collection delegates deletion through onCandidates");
        },
    };

    const result = await collectEligibleMessages(api, {
        channelId: "channel",
        guildId: "guild",
        userId: "me",
        oldestTimestamp: 0,
        newestTimestamp: 10,
        keptMessageIds: new Set(),
    }, {
        retainMessages: false,
        async onCandidates(candidates) {
            consumed.push(candidates.map(message => message.id));
        },
    });

    assert.deepEqual(consumed, [["1"], ["2"]]);
    assert.deepEqual(result.messages, []);
});

test("active pruning checks priority work before every history page", async () => {
    const events: string[] = [];
    let page = 0;
    const api: PruningApi = {
        async listOwnMessagesPage() {
            page++;
            events.push(`history:${page}`);
            return {
                messages: [],
                nextBeforeId: page === 1 ? "next" : undefined,
            };
        },
        async deleteOwnMessage() {
            throw new Error("unused");
        },
    };

    await collectEligibleMessages(api, {
        channelId: "channel",
        guildId: "guild",
        userId: "me",
        oldestTimestamp: 0,
        newestTimestamp: 10,
        keptMessageIds: new Set(),
    }, {
        async beforePage() {
            events.push("priority");
        },
    });

    assert.deepEqual(events, [
        "priority",
        "history:1",
        "priority",
        "history:2",
    ]);
});

test("deletion paces completed messages before advancing to the next one", async () => {
    const events: string[] = [];
    const api: PruningApi = {
        async listOwnMessagesPage() {
            throw new Error("unused");
        },
        async deleteOwnMessage(_channelId, messageId) {
            events.push(`delete:${messageId}`);
        },

    };

    const result = await deleteEligibleMessages(api, [
        { id: "20", channelId: "channel", timestamp: 20, content: "second" },
        { id: "10", channelId: "channel", timestamp: 10, content: "first" },
    ], {
        sleep: async milliseconds => {
            events.push(`wait:${milliseconds}`);
        },
    });

    assert.deepEqual(events, ["delete:10", "wait:2500", "delete:20"]);
    assert.deepEqual(result, { deletedIds: ["10", "20"], failures: [] });
});
test("deletion finalizes every touched channel after processing", async () => {
    const events: string[] = [];
    const api = {
        async listOwnMessagesPage() {
            throw new Error("unused");
        },
        async deleteOwnMessage(channelId: string, messageId: string) {
            events.push(`delete:${channelId}:${messageId}`);
        },
        async finishDeletion(channelId: string) {
            events.push(`finish:${channelId}`);
        },
    };

    await deleteEligibleMessages(api, [
        { id: "10", channelId: "thread", timestamp: 10, content: "first" },
        { id: "20", channelId: "thread", timestamp: 20, content: "second" },
    ], {
        interMessageDelayMs: 0,
    });

    assert.deepEqual(events, [
        "delete:thread:10",
        "delete:thread:20",
        "finish:thread",
    ]);
});

test("deletion blocks on a rate-limited message before advancing to the next one", async () => {
    const events: string[] = [];
    let limitedAttempts = 0;
    const api: PruningApi = {
        async listOwnMessagesPage() {
            throw new Error("unused");
        },
        async deleteOwnMessage(_channelId, messageId) {
            events.push(`delete:${messageId}`);
            if (messageId === "20" && limitedAttempts++ === 0)
                throw { status: 429, body: { retry_after: 0.438 } };
            if (messageId === "30") throw new Error("forbidden");
        },
    };

    const result = await deleteEligibleMessages(api, [
        { id: "30", channelId: "channel", timestamp: 30, content: "a" },
        { id: "20", channelId: "channel", timestamp: 20, content: "b" },
        { id: "10", channelId: "channel", timestamp: 10, content: "c" },
    ], {
        sleep: async milliseconds => {
            events.push(`wait:${milliseconds}`);
        },
    });

    assert.deepEqual(events, [
        "delete:10",
        "wait:2500",
        "delete:20",
        "wait:1100",
        "delete:20",
        "wait:2500",
        "delete:30",
    ]);
    assert.deepEqual(result, {
        deletedIds: ["10", "20"],
        failures: [{ messageId: "30", error: "forbidden" }],
    });
});

test("repeated rate limits stop the worker instead of retrying forever or advancing", async () => {
    const events: string[] = [];
    const repeatedRateLimit = { status: 429, body: { retry_after: 0.25 } };
    const api: PruningApi = {
        async listOwnMessagesPage() {
            throw new Error("unused");
        },
        async deleteOwnMessage(_channelId, messageId) {
            events.push(`delete:${messageId}`);
            throw repeatedRateLimit;
        },
    };

    await assert.rejects(
        deleteEligibleMessages(api, [
            { id: "10", channelId: "channel", timestamp: 10, content: "first" },
            { id: "20", channelId: "channel", timestamp: 20, content: "must not be reached" },
        ], {
            sleep: async milliseconds => {
                events.push(`wait:${milliseconds}`);
            },
        }),
        error => error === repeatedRateLimit,
    );
    assert.deepEqual(events, ["delete:10", "wait:1100", "delete:10"]);
});

test("queued Discord deletion counts as success when retry reports not found", async () => {
    const events: string[] = [];
    let attempts = 0;
    const api: PruningApi = {
        async listOwnMessagesPage() {
            throw new Error("unused");
        },
        async deleteOwnMessage(_channelId, messageId) {
            events.push(`delete:${messageId}`);
            if (messageId === "10" && attempts++ === 0)
                throw { status: 429, body: { retry_after: 2 } };
            if (messageId === "10")
                throw { status: 404, body: { message: "Unknown Message" } };
        },
    };

    const result = await deleteEligibleMessages(api, [
        { id: "10", channelId: "channel", timestamp: 10, content: "a" },
        { id: "20", channelId: "channel", timestamp: 20, content: "b" },
    ], {
        sleep: async milliseconds => {
            events.push(`wait:${milliseconds}`);
        },
    });

    assert.deepEqual(events, ["delete:10", "wait:2100", "delete:10", "wait:2500", "delete:20"]);
    assert.deepEqual(result, { deletedIds: ["10", "20"], failures: [] });
});
