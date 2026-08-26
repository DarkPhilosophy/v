export interface PendingOwnMessage {
    id: string;
    channelId: string;
    timestamp: number;
    dueAt: number;
}

export function nextChannelDeadline(
    historyDeadline: number,
    pendingMessages: readonly PendingOwnMessage[],
): number {
    let deadline = historyDeadline;
    for (const message of pendingMessages)
        deadline = Math.min(deadline, message.dueAt);
    return deadline;
}

export function partitionDueMessages(
    pendingMessages: readonly PendingOwnMessage[],
    now: number,
): { due: PendingOwnMessage[]; future: PendingOwnMessage[]; } {
    const due: PendingOwnMessage[] = [];
    const future: PendingOwnMessage[] = [];
    for (const message of pendingMessages)
        (message.dueAt <= now ? due : future).push(message);
    return { due, future };
}
