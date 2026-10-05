export interface PendingOwnMessage {
    id: string;
    channelId: string;
    timestamp: number;
    dueAt: number;
}

/**
 * When the channel's worker should next wake up.
 *
 * `notBefore` is a hard floor (rate-limit or outage backoff). It must bound the
 * *final* deadline, priority messages included: runChannelPruning refuses to run
 * before it, so a due priority message would otherwise yield a 0 ms timer that
 * does nothing and immediately reschedules itself.
 */
export function nextChannelDeadline(
    historyDeadline: number,
    pendingMessages: readonly PendingOwnMessage[],
    notBefore = 0,
): number {
    let deadline = historyDeadline;
    for (const message of pendingMessages)
        deadline = Math.min(deadline, message.dueAt);
    return Math.max(deadline, notBefore);
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
