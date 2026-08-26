export interface DispatcherLike {
    subscribe(event: string, listener: (event: unknown) => void): void;
    unsubscribe(event: string, listener: (event: unknown) => void): void;
}

interface HeartbeatEvent {
    questId?: string;
    userStatus?: {
        progress?: Record<string, { value?: number }>;
        streamProgressSeconds?: number;
    };
}

export interface HeartbeatWait {
    promise: Promise<void>;
    cancel(error?: Error): void;
}

const HEARTBEAT_SUCCESS = "QUESTS_SEND_HEARTBEAT_SUCCESS";
const CONNECTION_CLOSED = "CONNECTION_CLOSED";
const AUTOMATION_BATCH_SIZE = 5;

export function createHeartbeatWait(
    dispatcher: DispatcherLike,
    questId: string,
    taskName: string,
    secondsNeeded: number,
    cleanup: () => void
): HeartbeatWait {
    let settled = false;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;

    const unsubscribe = () => {
        dispatcher.unsubscribe(HEARTBEAT_SUCCESS, onHeartbeat);
        dispatcher.unsubscribe(CONNECTION_CLOSED, onConnectionClosed);
    };
    const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        cleanup();
        if (error) rejectPromise(error);
        else resolvePromise();
    };
    const onHeartbeat = (rawEvent: unknown) => {
        const event = rawEvent as HeartbeatEvent;
        if (event.questId !== questId) return;
        const value = Math.floor(event.userStatus?.progress?.[taskName]?.value ?? event.userStatus?.streamProgressSeconds ?? 0);
        if (value >= secondsNeeded) settle();
    };
    const onConnectionClosed = () => settle(new Error("Gateway connection closed"));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    resolvePromise = resolve;
    rejectPromise = reject;
    dispatcher.subscribe(HEARTBEAT_SUCCESS, onHeartbeat);
    dispatcher.subscribe(CONNECTION_CLOSED, onConnectionClosed);

    return { promise, cancel: error => settle(error ?? new Error("Quest heartbeat cancelled")) };
}

export function getRateLimitDelayMs(error: unknown): number | undefined {
    if (!error || typeof error !== "object" || !("status" in error) || error.status !== 429) return;
    const body = "body" in error && error.body && typeof error.body === "object" ? error.body : undefined;
    const retryAfter = body && "retry_after" in body ? body.retry_after : undefined;
    return typeof retryAfter === "number" && Number.isFinite(retryAfter)
        ? Math.max(1_000, retryAfter * 1_000)
        : 1_000;
}

export function getEnrollmentBatch<T>(quests: readonly T[]): T[] {
    return quests.slice(0, AUTOMATION_BATCH_SIZE);
}

export function getCompletionBatch<T>(
    quests: readonly T[],
    canRunConcurrently: (quest: T) => boolean
): T[] {
    const concurrent = quests.filter(canRunConcurrently);
    const serial = quests.filter(quest => !canRunConcurrently(quest));
    const selectedConcurrent = concurrent.slice(0, Math.min(3, AUTOMATION_BATCH_SIZE));
    const selectedSerial = serial.slice(0, AUTOMATION_BATCH_SIZE - selectedConcurrent.length);
    const remainingSlots = AUTOMATION_BATCH_SIZE - selectedConcurrent.length - selectedSerial.length;
    return [
        ...selectedConcurrent,
        ...selectedSerial,
        ...concurrent.slice(selectedConcurrent.length, selectedConcurrent.length + remainingSlots)
    ];
}

export function getNextAutomationDelayMs(successfulQuests: number, currentDelayMs: number): number {
    return successfulQuests > 0 ? 5_000 : Math.min(currentDelayMs * 2, 60_000);
}

async function runWithConcurrency<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T) => Promise<void>
): Promise<void> {
    const limit = Math.max(1, Math.floor(concurrency));
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            await worker(items[index]);
        }
    });
    await Promise.all(workers);
}

export async function runConcurrentQuestBatch<T>(
    items: readonly T[],
    canRunConcurrently: (item: T) => boolean,
    worker: (item: T) => Promise<void>,
    concurrency: number
): Promise<void> {
    const concurrent = items.filter(canRunConcurrently);
    const serial = items.filter(item => !canRunConcurrently(item));
    await Promise.all([
        runWithConcurrency(concurrent, concurrency, worker),
        (async () => {
            for (const item of serial) await worker(item);
        })()
    ]);
}

