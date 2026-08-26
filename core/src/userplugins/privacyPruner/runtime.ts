import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { UserStore } from "@webpack/common";

import { discordPruningApi } from "./api";
import { collectEligibleMessages, deleteEligibleMessages, type CollectionOptions, type PreviewResult } from "./engine";
import { getRetryDelayMs } from "./guards";
import { computeWindow, isPruningActive, setChannelPolicy, type ChannelPolicy, type SyncedPruningState } from "./model";
import { readSyncedState, writeSyncedState } from "./settings";
import { nextChannelDeadline, partitionDueMessages, type PendingOwnMessage } from "./scheduler";

const logger = new Logger("PrivacyPruner");
const PROGRESS_KEY = "PrivacyPruner_progress_v1";

export interface ChannelProgress {
    lastScanAt?: number;
    lastDeletedCount?: number;
    nextAttemptAt?: number;
    lastFailureCount?: number;
}

type ProgressState = Record<string, ChannelProgress>;

let schedulerStarted = false;
let progress: ProgressState = {};
const pausedChannels = new Set<string>();
const channelTimers = new Map<string, number>();
const activeChannels = new Map<string, AbortController>();
const interruptedChannels = new Set<string>();
const pendingMessages = new Map<string, PendingOwnMessage[]>();

function keptMessageIdsForChannel(state: SyncedPruningState, channelId: string): Set<string> {
    return new Set(
        Object.entries(state.kept)
            .filter(([, record]) => record.channelId === channelId)
            .map(([messageId]) => messageId)
    );
}
function clearChannelTimer(channelId: string): void {
    const timer = channelTimers.get(channelId);
    if (timer !== undefined) clearTimeout(timer);
    channelTimers.delete(channelId);
}

export function pauseChannelPruning(channelId: string): void {
    pausedChannels.add(channelId);
    clearChannelTimer(channelId);
    if (activeChannels.has(channelId)) interruptedChannels.add(channelId);
    activeChannels.get(channelId)?.abort();
    logger.info(`Channel ${channelId}: paused while settings are open.`);
}

export function resumeChannelPruning(channelId: string): void {
    pausedChannels.delete(channelId);
    const wasInterrupted = interruptedChannels.delete(channelId);
    logger.info(`Channel ${channelId}: resumed; ${wasInterrupted ? "continuing interrupted work now" : "restoring its timer"}.`);
    scheduleChannel(channelId, wasInterrupted);
}

export function isChannelPruningPaused(channelId: string): boolean {
    return pausedChannels.has(channelId);
}
export function queueOwnMessage(
    policyChannelId: string,
    messageId: string,
    timestamp: number,
    messageChannelId = policyChannelId,
): void {
    const state = readSyncedState();
    const record = state.channels[policyChannelId];
    if (!record?.confirmedAt || !record.policy.enabled) return;
    if (record.guildId && state.guilds[record.guildId]?.enabled !== true) return;

    const queued = pendingMessages.get(policyChannelId) ?? [];
    if (queued.some(message => message.id === messageId)) return;
    queued.push({
        id: messageId,
        channelId: messageChannelId,
        timestamp,
        dueAt: timestamp + record.policy.retentionMs,
    });
    pendingMessages.set(policyChannelId, queued);
    logger.info(`Channel ${policyChannelId}: queued new message ${messageId} from ${messageChannelId} for pruning at ${new Date(timestamp + record.policy.retentionMs).toISOString()}.`);
    scheduleChannel(policyChannelId);
}


export async function previewChannel(
    channelId: string,
    guildId: string | null,
    policy: ChannelPolicy,
    now = Date.now(),
    options: CollectionOptions = {},
): Promise<PreviewResult> {
    const currentUser = UserStore.getCurrentUser();
    if (!currentUser) throw new Error("Discord user is unavailable.");
    const window = computeWindow(policy, now);
    const state = readSyncedState();
    logger.info(`Preview started for channel ${channelId}.`);
    try {
        const result = await collectEligibleMessages(discordPruningApi, {
            channelId,
            guildId,
            userId: currentUser.id,
            ...window,
            includeThreads: policy.includeThreads,
            keptMessageIds: keptMessageIdsForChannel(state, channelId),
        }, {
            ...options,
            onProgress(scanProgress) {
                logger.info(
                    `Channel ${channelId}: pages=${scanProgress.pagesScanned}, inspected=${scanProgress.messagesInspected}, owned=${scanProgress.ownedMessagesFound}, eligible=${scanProgress.eligibleMessagesFound}, oldest=${scanProgress.oldestInspectedTimestamp ?? "unknown"}.`
                );
                options.onProgress?.(scanProgress);
            },
        });
        logger.info(`Preview ${result.stopped ? "stopped" : "completed"} for channel ${channelId} with ${result.messages.length} eligible messages.`);
        return result;
    } catch (error) {
        logger.error(`Preview failed for channel ${channelId}.`, error);
        throw error;
    }
}

export async function deleteMessageNow(channelId: string, messageId: string): Promise<void> {
    await discordPruningApi.deleteOwnMessage(channelId, messageId);
}

export function enableChannelPolicy(
    channelId: string,
    guildId: string | null,
    policy: ChannelPolicy,
): void {
    writeSyncedState(setChannelPolicy(
        readSyncedState(),
        channelId,
        guildId,
        { ...policy, enabled: true },
        Date.now(),
    ));
}

export async function confirmChannelPolicy(
    channelId: string,
    guildId: string | null,
    policy: ChannelPolicy,
    preview: PreviewResult,
): Promise<{ deletedCount: number; failureCount: number; }> {
    const enabledPolicy = { ...policy, enabled: true };
    writeSyncedState(setChannelPolicy(readSyncedState(), channelId, guildId, enabledPolicy, Date.now()));
    const result = await deleteEligibleMessages(discordPruningApi, preview.messages);
    progress[channelId] = {
        lastScanAt: Date.now(),
        lastDeletedCount: result.deletedIds.length,
        lastFailureCount: result.failures.length,
    };
    await DataStore.set(PROGRESS_KEY, progress);
    if (result.failures.length)
        logger.warn(`Channel ${channelId}: ${result.failures.length} message deletions failed and will be retried.`);
    return { deletedCount: result.deletedIds.length, failureCount: result.failures.length };
}

export async function runChannelPruning(channelId: string, now = Date.now()): Promise<void> {
    if (activeChannels.has(channelId)) return;
    const state = readSyncedState();
    const record = state.channels[channelId];
    if (pausedChannels.has(channelId) || !record?.confirmedAt) return;
    const guildEnabled = record.guildId ? state.guilds[record.guildId]?.enabled === true : false;
    if (!isPruningActive({
        guildEnabled,
        channelEnabled: record.policy.enabled,
        isDm: record.guildId == null,
    })) return;

    const previous = progress[channelId];
    if (previous?.nextAttemptAt && now < previous.nextAttemptAt) return;
    const initialPriority = partitionDueMessages(pendingMessages.get(channelId) ?? [], now).due;
    const historyDue = previous?.lastScanAt == null || now - previous.lastScanAt >= record.policy.scanIntervalMs;
    if (initialPriority.length === 0 && !historyDue) return;

    const controller = new AbortController();
    activeChannels.set(channelId, controller);
    logger.info(`Channel ${channelId}: worker started; priority=${initialPriority.length}, historical=${historyDue}.`);
    try {
        let deletedCount = 0;
        let failureCount = 0;

        function logRateLimit(messageId: string, retryDelayMs: number, willRetry: boolean): void {
            logger.warn(
                `Channel ${channelId}: DELETE ${messageId} rate-limited; ` +
                (willRetry
                    ? `waiting ${retryDelayMs + 100}ms before one retry.`
                    : `second 429 received; stopping worker and rescheduling channel.`),
            );
        }

        async function drainDuePriority(): Promise<void> {
            const queuedNow = pendingMessages.get(channelId) ?? [];
            const { due } = partitionDueMessages(queuedNow, Date.now());
            if (due.length === 0 || controller.signal.aborted) return;

            logger.info(`Channel ${channelId}: preempting historical work for ${due.length} due priority message(s).`);
            const result = await deleteEligibleMessages(discordPruningApi, due.map(message => ({
                id: message.id,
                channelId: message.channelId,
                timestamp: message.timestamp,
                content: "",
            })), { signal: controller.signal, onRateLimit: logRateLimit });
            deletedCount += result.deletedIds.length;
            failureCount += result.failures.length;
            const completed = new Set(result.deletedIds);
            pendingMessages.set(
                channelId,
                (pendingMessages.get(channelId) ?? []).filter(message => !completed.has(message.id)),
            );
            if (result.failures.length > 0) {
                const failure = result.failures[0];
                throw new Error(`Priority deletion stopped at message ${failure.messageId}: ${failure.error}`);
            }
            logger.info(`Channel ${channelId}: priority pass completed; deleted=${result.deletedIds.length}.`);
        }

        await drainDuePriority();
        if (controller.signal.aborted || !historyDue) return;

        const currentUser = UserStore.getCurrentUser();
        if (!currentUser) throw new Error("Discord user is unavailable.");
        const window = computeWindow(record.policy, now);
        const scan = await collectEligibleMessages(discordPruningApi, {
            channelId,
            guildId: record.guildId,
            userId: currentUser.id,
            ...window,
            includeThreads: record.policy.includeThreads,
            keptMessageIds: keptMessageIdsForChannel(state, channelId),
        }, {
            signal: controller.signal,
            beforePage: drainDuePriority,
            retainMessages: false,
            async onCandidates(candidates) {
                const batch = await deleteEligibleMessages(discordPruningApi, candidates, {
                    signal: controller.signal,
                    onRateLimit: logRateLimit,
                    beforeMessage: drainDuePriority,
                });
                deletedCount += batch.deletedIds.length;
                failureCount += batch.failures.length;
                if (batch.failures.length > 0) {
                    const failure = batch.failures[0];
                    throw new Error(`Historical deletion stopped at message ${failure.messageId}: ${failure.error}`);
                }
            },
        });
        if (scan.stopped) {
            logger.info(`Channel ${channelId}: historical pass interrupted.`);
            return;
        }
        progress[channelId] = {
            lastScanAt: now,
            lastDeletedCount: deletedCount,
            lastFailureCount: failureCount,
        };
        await DataStore.set(PROGRESS_KEY, progress);
        logger.info(`Channel ${channelId}: worker completed; deleted=${deletedCount}, failed=${failureCount}.`);
    } catch (error) {
        progress[channelId] = {
            ...previous,
            nextAttemptAt: now + getRetryDelayMs(error),
        };
        await DataStore.set(PROGRESS_KEY, progress);
        throw error;
    } finally {
        if (activeChannels.get(channelId) === controller) activeChannels.delete(channelId);
    }
}
function scheduleChannel(channelId: string, runImmediately = false): void {
    clearChannelTimer(channelId);
    if (!schedulerStarted || pausedChannels.has(channelId) || activeChannels.has(channelId)) return;

    const record = readSyncedState().channels[channelId];
    if (!record?.confirmedAt || !record.policy.enabled) return;
    const previous = progress[channelId];
    const historyDeadline = Math.max(
        previous?.nextAttemptAt ?? 0,
        (previous?.lastScanAt ?? Date.now()) + record.policy.scanIntervalMs,
    );
    const deadline = runImmediately
        ? Date.now()
        : nextChannelDeadline(historyDeadline, pendingMessages.get(channelId) ?? []);
    const delay = Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647);
    logger.info(`Channel ${channelId}: scheduled in ${Math.ceil(delay)}ms.`);
    channelTimers.set(channelId, setTimeout(async () => {
        channelTimers.delete(channelId);
        try {
            await runChannelPruning(channelId);
        } catch (error) {
            logger.error(`Scheduled pruning failed for channel ${channelId}.`, error);
        } finally {
            scheduleChannel(channelId);
        }
    }, delay));
}

export async function startScheduler(scanOnStartup: boolean): Promise<void> {
    if (schedulerStarted) return;
    schedulerStarted = true;
    progress = await DataStore.get<ProgressState>(PROGRESS_KEY) ?? {};
    for (const channelId of Object.keys(readSyncedState().channels))
        scheduleChannel(channelId, scanOnStartup);
}

export function stopScheduler(): void {
    schedulerStarted = false;
    for (const timer of channelTimers.values()) clearTimeout(timer);
    channelTimers.clear();
    for (const controller of activeChannels.values()) controller.abort();
    activeChannels.clear();
    pausedChannels.clear();
    interruptedChannels.clear();
    pendingMessages.clear();
}

export function getChannelProgress(channelId: string): ChannelProgress | undefined {
    return progress[channelId];
}
