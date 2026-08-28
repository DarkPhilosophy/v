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

export interface EnrollmentStatus {
    userId?: string;
    questId?: string;
    enrolledAt?: string;
    completedAt?: string;
    claimedAt?: string;
    claimedTier?: number;
    orbQuantityClaimed?: number;
    lastStreamHeartbeatAt?: string;
    streamProgressSeconds?: number;
    progress?: Record<string, { value: number; }>;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
    return value != null && typeof value === "object" && !Array.isArray(value)
        ? value as UnknownRecord
        : undefined;
}

function readString(record: UnknownRecord, camelCase: string, snakeCase: string): string | undefined {
    const value = record[camelCase] ?? record[snakeCase];
    return typeof value === "string" ? value : undefined;
}

function readNumber(record: UnknownRecord, camelCase: string, snakeCase: string): number | undefined {
    const value = record[camelCase] ?? record[snakeCase];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapEnrollmentStatus(value: unknown): EnrollmentStatus | undefined {
    const response = asRecord(value);
    if (!response) return;
    const record = asRecord(
        response.userStatus
        ?? response.enrolledQuestUserStatus
        ?? response.user_status
        ?? response.enrolled_quest_user_status
    ) ?? response;

    const enrolledAt = readString(record, "enrolledAt", "enrolled_at");
    const completedAt = readString(record, "completedAt", "completed_at");
    if (completedAt || !enrolledAt) return;

    const status: EnrollmentStatus = { enrolledAt };
    const stringFields = [
        ["userId", "user_id"],
        ["questId", "quest_id"],
        ["claimedAt", "claimed_at"],
        ["lastStreamHeartbeatAt", "last_stream_heartbeat_at"]
    ] as const;
    for (const [camelCase, snakeCase] of stringFields) {
        const field = readString(record, camelCase, snakeCase);
        if (field !== undefined) status[camelCase] = field;
    }
    const numberFields = [
        ["claimedTier", "claimed_tier"],
        ["orbQuantityClaimed", "orb_quantity_claimed"],
        ["streamProgressSeconds", "stream_progress_seconds"]
    ] as const;
    for (const [camelCase, snakeCase] of numberFields) {
        const field = readNumber(record, camelCase, snakeCase);
        if (field !== undefined) status[camelCase] = field;
    }

    const rawProgress = asRecord(record.progress);
    if (rawProgress) {
        const progress: Record<string, { value: number; }> = {};
        for (const [taskName, rawTask] of Object.entries(rawProgress)) {
            const task = asRecord(rawTask);
            if (task && typeof task.value === "number" && Number.isFinite(task.value))
                progress[taskName] = { value: task.value };
        }
        status.progress = progress;
    }
    return status;
}

/** Discord currently returns a raw snake_case QuestUserStatus from /enroll;
 * older builds wrapped the status. Fall back to the already-updated store. */
export function resolveEnrolledStatus(
    responseBody: unknown,
    fromStore: EnrollmentStatus | null | undefined
): EnrollmentStatus | undefined {
    return mapEnrollmentStatus(responseBody) ?? mapEnrollmentStatus(fromStore);
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

