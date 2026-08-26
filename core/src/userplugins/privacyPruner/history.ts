import type { MessagePage, PrunableMessage } from "./engine";
import { isUnknownRecord } from "./guards";

interface DiscordAuthor {
    id: string;
}

interface DiscordMessage {
    id: string;
    channel_id: string;
    author: DiscordAuthor;
    timestamp: string;
    content?: string;
    hit?: boolean;
}

function parseDiscordMessage(value: unknown): DiscordMessage | undefined {
    if (value == null || typeof value !== "object") return;
    const candidate = value as Partial<DiscordMessage>;
    if (
        typeof candidate.id !== "string" ||
        typeof candidate.channel_id !== "string" ||
        typeof candidate.timestamp !== "string" ||
        candidate.author == null ||
        typeof candidate.author.id !== "string"
    ) return;
    return candidate as DiscordMessage;
}

function toPrunableMessage(message: DiscordMessage): PrunableMessage {
    return {
        id: message.id,
        channelId: message.channel_id,
        timestamp: Date.parse(message.timestamp),
        content: message.content ?? "",
    };
}

export function parseMessageDetail(body: unknown): PrunableMessage | undefined {
    const message = parseDiscordMessage(body);
    return message == null ? undefined : toPrunableMessage(message);
}

export function parseMessageAroundPage(body: unknown, messageId: string): PrunableMessage | undefined {
    if (!Array.isArray(body)) return;
    const message = body
        .map(parseDiscordMessage)
        .find((candidate): candidate is DiscordMessage => candidate?.id === messageId);
    return message == null ? undefined : toPrunableMessage(message);
}

export function parseChannelHistoryPage(
    body: unknown,
    userId: string,
    oldestTimestamp: number,
): MessagePage {
    const messages = (Array.isArray(body) ? body : [])
        .map(parseDiscordMessage)
        .filter((message): message is DiscordMessage => message != null);
    const timestamps = messages.map(message => Date.parse(message.timestamp));
    const reachedLookbackLimit = timestamps.some(timestamp => timestamp < oldestTimestamp);
    const oldestInspectedTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : undefined;

    return {
        inspectedCount: messages.length,
        oldestInspectedTimestamp,
        reachedLookbackLimit,
        messages: messages
            .filter(message =>
                message.author.id === userId &&
                Date.parse(message.timestamp) >= oldestTimestamp)
            .map(toPrunableMessage),
        nextBeforeId: !reachedLookbackLimit && messages.length > 0
            ? messages[messages.length - 1].id
            : undefined,
    };
}

export function parseSearchPage(
    body: unknown,
    userId: string,
    channelId: string,
    includeThreads = false,
): MessagePage {
    if (body == null || typeof body !== "object" || !("messages" in body)) {
        return { messages: [], inspectedCount: 0 };
    }
    const groups = body.messages;
    const threads = "threads" in body && Array.isArray(body.threads) ? body.threads : [];
    const includedThreadIds = new Set<string>();
    for (const thread of threads) {
        if (
            isUnknownRecord(thread) &&
            typeof thread.id === "string" &&
            thread.parent_id === channelId
        ) {
            includedThreadIds.add(thread.id);
        }
    }

    const messages = (Array.isArray(groups) ? groups : [])
        .flatMap(group => Array.isArray(group) ? group : [])
        .map(parseDiscordMessage)
        .filter((message): message is DiscordMessage =>
            message != null &&
            message.hit === true &&
            message.author.id === userId &&
            (message.channel_id === channelId || includeThreads && includedThreadIds.has(message.channel_id)));
    const oldest = messages.length > 0
        ? messages.reduce((left, right) =>
            Date.parse(left.timestamp) <= Date.parse(right.timestamp) ? left : right)
        : undefined;

    return {
        inspectedCount: messages.length,
        oldestInspectedTimestamp: oldest == null ? undefined : Date.parse(oldest.timestamp),
        reachedLookbackLimit: messages.length === 0,
        messages: messages.map(toPrunableMessage),
        nextBeforeId: oldest?.id,
    };
}
