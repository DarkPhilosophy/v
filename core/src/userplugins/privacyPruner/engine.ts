import { formatUnknownError, getHttpStatus, getRateLimitDelayMs } from "./guards";

export interface PrunableMessage {
    id: string;
    channelId: string;
    timestamp: number;
    content: string;
}

export interface MessagePage {
    messages: PrunableMessage[];
    inspectedCount?: number;
    oldestInspectedTimestamp?: number;
    reachedLookbackLimit?: boolean;
    nextBeforeId?: string;
}

export interface PruningApi {
    listOwnMessagesPage(input: {
        channelId: string;
        guildId: string | null;
        userId: string;
        beforeId?: string;
        oldestTimestamp: number;
        newestTimestamp: number;
        includeThreads?: boolean;
    }): Promise<MessagePage>;
    deleteOwnMessage(channelId: string, messageId: string): Promise<void>;
    finishDeletion?(channelId: string): Promise<void>;
}

export interface CollectInput {
    channelId: string;
    guildId: string | null;
    userId: string;
    oldestTimestamp: number;
    newestTimestamp: number;
    includeThreads?: boolean;
    keptMessageIds: ReadonlySet<string>;
}

export interface PreviewResult {
    messages: PrunableMessage[];
    keptCount: number;
    stopped?: boolean;
    completedBy?: "channel-start" | "lookback-limit";
}

export interface CollectionProgress {
    pagesScanned: number;
    messagesInspected: number;
    ownedMessagesFound: number;
    eligibleMessagesFound: number;
    oldestInspectedTimestamp?: number;
}

export interface CollectionOptions {
    signal?: AbortSignal;
    beforePage?(): Promise<void>;
    onProgress?(progress: CollectionProgress): void;
    onPartialResult?(result: PreviewResult): void;
    retainMessages?: boolean;
    onCandidates?(messages: readonly PrunableMessage[]): Promise<void>;
}

export async function collectEligibleMessages(
    api: PruningApi,
    input: CollectInput,
    options: CollectionOptions = {},
): Promise<PreviewResult> {
    const messages: PrunableMessage[] = [];
    const seenMessages = new Set<string>();
    const seenCursors = new Set<string>();
    let keptCount = 0;
    let beforeId: string | undefined;
    let pagesScanned = 0;
    let messagesInspected = 0;
    let ownedMessagesFound = 0;
    let eligibleMessagesFound = 0;
    let oldestInspectedTimestamp: number | undefined;
    for (;;) {
        if (options.signal?.aborted) return { messages, keptCount, stopped: true };
        await options.beforePage?.();
        if (options.signal?.aborted) return { messages, keptCount, stopped: true };
        const page = await api.listOwnMessagesPage({
            channelId: input.channelId,
            guildId: input.guildId,
            userId: input.userId,
            beforeId,
            oldestTimestamp: input.oldestTimestamp,
            newestTimestamp: input.newestTimestamp,
            includeThreads: input.includeThreads,
        });

        pagesScanned++;
        messagesInspected += page.inspectedCount ?? page.messages.length;
        ownedMessagesFound += page.messages.length;
        if (page.oldestInspectedTimestamp != null) {
            oldestInspectedTimestamp = Math.min(
                oldestInspectedTimestamp ?? page.oldestInspectedTimestamp,
                page.oldestInspectedTimestamp,
            );
        }
        const pageCandidates: PrunableMessage[] = [];
        for (const message of page.messages) {
            if (seenMessages.has(message.id)) continue;
            seenMessages.add(message.id);
            if (message.timestamp < input.oldestTimestamp || message.timestamp > input.newestTimestamp) continue;
            if (input.keptMessageIds.has(message.id)) keptCount++;
            else {
                pageCandidates.push(message);
                if (options.retainMessages !== false) messages.push(message);
            }
        }
        eligibleMessagesFound += pageCandidates.length;
        if (pageCandidates.length > 0) await options.onCandidates?.(pageCandidates);

        options.onProgress?.({
            pagesScanned,
            messagesInspected,
            ownedMessagesFound,
            eligibleMessagesFound,
            oldestInspectedTimestamp,
        });
        options.onPartialResult?.({ messages: [...messages], keptCount });
        if (options.signal?.aborted) return { messages, keptCount, stopped: true };

        if (!page.nextBeforeId || seenCursors.has(page.nextBeforeId)) {
            return {
                messages,
                keptCount,
                completedBy: page.reachedLookbackLimit ? "lookback-limit" : "channel-start",
            };
        }
        seenCursors.add(page.nextBeforeId);
        beforeId = page.nextBeforeId;
    }
}

export interface DeletionResult {
    deletedIds: string[];
    failures: Array<{ messageId: string; error: string; }>;
}

export interface DeletionOptions {
    signal?: AbortSignal;
    beforeMessage?(): Promise<void>;
    interMessageDelayMs?: number;
    onRateLimit?(messageId: string, retryDelayMs: number, willRetry: boolean): void;
    sleep?(milliseconds: number): Promise<void>;
}

const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

export async function deleteEligibleMessages(
    api: PruningApi,
    messages: readonly PrunableMessage[],
    options: DeletionOptions = {},
): Promise<DeletionResult> {
    const deletedIds: string[] = [];
    const failures: Array<{ messageId: string; error: string; }> = [];
    const oldestFirst = [...messages].sort((left, right) => left.timestamp - right.timestamp);
    const wait = options.sleep ?? sleep;
    const interMessageDelayMs = options.interMessageDelayMs ?? 2_500;

    const touchedChannels = new Set<string>();
    try {
        for (let index = 0; index < oldestFirst.length; index++) {
            const message = oldestFirst[index];
            touchedChannels.add(message.channelId);
            await options.beforeMessage?.();
            if (options.signal?.aborted) return { deletedIds, failures };
            let rateLimitRetries = 0;
            for (;;) {
                if (options.signal?.aborted) return { deletedIds, failures };

                try {
                    await api.deleteOwnMessage(message.channelId, message.id);
                    deletedIds.push(message.id);
                    break;
                } catch (error) {
                    if (getHttpStatus(error) === 404) {
                        deletedIds.push(message.id);
                        break;
                    }

                    const retryDelay = getRateLimitDelayMs(error);
                    if (retryDelay == null) {
                        failures.push({ messageId: message.id, error: formatUnknownError(error) });
                        break;
                    }
                    options.onRateLimit?.(message.id, retryDelay, rateLimitRetries < 1);
                    if (rateLimitRetries >= 1) throw error;

                    rateLimitRetries++;
                    await wait(retryDelay + 100);
                }
            }
            if (interMessageDelayMs > 0 && index < oldestFirst.length - 1)
                await wait(interMessageDelayMs);
        }
    } finally {
        for (const channelId of touchedChannels)
            await api.finishDeletion?.(channelId);
    }

    return { deletedIds, failures };
}
