export interface DispatcherLike {
    subscribe(event: string, listener: (event: unknown) => void): void;
    unsubscribe(event: string, listener: (event: unknown) => void): void;
}

interface HeartbeatEvent {
    questId?: string;
    quest_id?: string;
    userStatus?: QuestUserStatusLike;
}

/** userStatus arrives from Discord in several shapes: progress may be a plain
 * object or a Map, keys may be camelCase or snake_case. */
interface QuestUserStatusLike {
    completedAt?: string | null;
    completed_at?: string | null;
    progress?: Record<string, { value?: number }> | Map<string, { value?: number }>;
    streamProgressSeconds?: number;
    stream_progress_seconds?: number;
}

export interface HeartbeatWait {
    promise: Promise<void>;
    cancel(error?: Error): void;
}

export interface HeartbeatWaitOptions {
    /** Silence window: any heartbeat event (success or failure) for this quest
     * re-arms it. Discord beats every ~60s and never retries a failed beat, so
     * 90s leaves one beat of slack. */
    idleMs?: number;
    /** Hard cap for the whole wait regardless of activity. */
    absoluteMs?: number;
    /** Consecutive QUESTS_SEND_HEARTBEAT_FAILURE events that end the wait. */
    maxConsecutiveFailures?: number;
    /** Extra completion signal: polled periodically (e.g. QuestsStore lookup)
     * so a completedAt/progress update we never saw as an event still settles. */
    isComplete?: () => boolean;
    pollMs?: number;
    onDebug?: (message: string) => void;
    /** Injectable timers so tests drive time deterministically. */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (id: unknown) => void;
    setPoll?: (fn: () => void, ms: number) => unknown;
    clearPoll?: (id: unknown) => void;
}

const HEARTBEAT_SUCCESS = "QUESTS_SEND_HEARTBEAT_SUCCESS";
const HEARTBEAT_FAILURE = "QUESTS_SEND_HEARTBEAT_FAILURE";
const USER_STATUS_UPDATE = "QUESTS_USER_STATUS_UPDATE";
const CONNECTION_CLOSED = "CONNECTION_CLOSED";
const AUTOMATION_BATCH_SIZE = 5;

function eventQuestId(event: unknown): string | undefined {
    const e = event as HeartbeatEvent | null | undefined;
    return e?.questId ?? e?.quest_id;
}

export function readTaskProgress(userStatus: QuestUserStatusLike | null | undefined, taskName: string): number {
    const progress = userStatus?.progress;
    const entry = progress instanceof Map ? progress.get(taskName) : progress?.[taskName];
    return Math.floor(entry?.value ?? userStatus?.streamProgressSeconds ?? userStatus?.stream_progress_seconds ?? 0);
}

/** A quest is done when Discord says so (completedAt) or when the credited
 * progress reached the target — the terminal heartbeat may carry either. */
export function isQuestStatusComplete(userStatus: QuestUserStatusLike | null | undefined, taskName: string, secondsNeeded: number): boolean {
    if (!userStatus) return false;
    if (userStatus.completedAt || userStatus.completed_at) return true;
    return readTaskProgress(userStatus, taskName) >= secondsNeeded;
}

function describeHeartbeatFailure(event: unknown): string {
    const e = (event as { error?: unknown })?.error ?? event;
    const parts: string[] = [];
    const status = (e as { status?: unknown; httpStatus?: unknown })?.status ?? (e as { httpStatus?: unknown })?.httpStatus;
    if (typeof status === "number") parts.push(`HTTP ${status}`);
    const code = (e as { body?: { code?: unknown }; code?: unknown })?.body?.code ?? (e as { code?: unknown })?.code;
    if ((typeof code === "string" || typeof code === "number") && code !== status) parts.push(`code ${code}`);
    const message = (e as { body?: { message?: unknown }; message?: unknown })?.body?.message ?? (e as { message?: unknown })?.message;
    if (message) parts.push(String(message));
    if (!parts.length) {
        try { parts.push(JSON.stringify(e).slice(0, 160)); } catch { parts.push(String(e)); }
    }
    return parts.join(", ") || "no detail";
}

export function createHeartbeatWait(
    dispatcher: DispatcherLike,
    questId: string,
    taskName: string,
    secondsNeeded: number,
    cleanup: () => void,
    options: HeartbeatWaitOptions = {}
): HeartbeatWait {
    const idleMs = options.idleMs ?? 90_000;
    const absoluteMs = options.absoluteMs ?? (secondsNeeded + 300) * 1000;
    const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    const pollMs = options.pollMs ?? 15_000;
    const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = options.clearTimer ?? ((id: unknown) => clearTimeout(id as Parameters<typeof clearTimeout>[0]));
    const setPoll = options.setPoll ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const clearPoll = options.clearPoll ?? ((id: unknown) => clearInterval(id as Parameters<typeof clearInterval>[0]));

    let settled = false;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    let idleTimer: unknown;
    let absoluteTimer: unknown;
    let pollTimer: unknown;
    let creditedBeats = 0;
    let failedBeats = 0;
    let consecutiveFailures = 0;
    let lastFailure: string | undefined;
    let debugged = false;

    const unsubscribe = () => {
        dispatcher.unsubscribe(HEARTBEAT_SUCCESS, onHeartbeat);
        dispatcher.unsubscribe(HEARTBEAT_FAILURE, onHeartbeatFailure);
        dispatcher.unsubscribe(USER_STATUS_UPDATE, onStatusUpdate);
        dispatcher.unsubscribe(CONNECTION_CLOSED, onConnectionClosed);
    };
    const stopTimers = () => {
        clearTimer(idleTimer);
        clearTimer(absoluteTimer);
        clearPoll(pollTimer);
    };
    const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        stopTimers();
        unsubscribe();
        cleanup();
        if (error) rejectPromise(error);
        else resolvePromise();
    };
    const armIdle = () => {
        clearTimer(idleTimer);
        idleTimer = setTimer(() => {
            const detail = failedBeats > 0
                ? ` (${creditedBeats} credited, ${failedBeats} failed, last: ${lastFailure})`
                : creditedBeats > 0 ? ` (${creditedBeats} credited)` : "";
            settle(new Error(`heartbeat timeout${detail}`));
        }, idleMs);
    };
    const debugOnce = (label: string, event: unknown) => {
        if (debugged) return;
        debugged = true;
        try { options.onDebug?.(`${label}: ${JSON.stringify(event)?.slice(0, 400)}`); } catch { /* debug only */ }
    };
    const onHeartbeat = (rawEvent: unknown) => {
        if (eventQuestId(rawEvent) !== questId) return;
        debugOnce("heartbeat", rawEvent);
        creditedBeats++;
        consecutiveFailures = 0;
        armIdle();
        const status = (rawEvent as HeartbeatEvent).userStatus;
        if (isQuestStatusComplete(status, taskName, secondsNeeded)) settle();
    };
    const onHeartbeatFailure = (rawEvent: unknown) => {
        if (eventQuestId(rawEvent) !== questId) return;
        debugOnce("heartbeat failure", rawEvent);
        failedBeats++;
        consecutiveFailures++;
        lastFailure = describeHeartbeatFailure(rawEvent);
        if (consecutiveFailures >= maxConsecutiveFailures) {
            settle(new Error(`heartbeat failed ${consecutiveFailures} times in a row: ${lastFailure}`));
            return;
        }
        options.onDebug?.(`heartbeat failed (${consecutiveFailures}/${maxConsecutiveFailures}): ${lastFailure}`);
        // Discord does not retry a failed beat; the next attempt is the tick
        // already scheduled ~60s out, so a failure is proof of life, not silence.
        // Before the first credited beat the original deadline stands: a spoof
        // Discord never accepted should fail fast instead of retrying forever.
        if (creditedBeats > 0) armIdle();
    };
    const onStatusUpdate = (rawEvent: unknown) => {
        const e = rawEvent as { questId?: string; quest_id?: string; userStatus?: QuestUserStatusLike } & QuestUserStatusLike;
        if (eventQuestId(rawEvent) !== questId) return;
        const status = e?.userStatus ?? e;
        // Passive updates only count when Discord finalized the quest: a full
        // progress bar without completedAt means the terminal beat never went
        // out, so the spoof must stay up until a real heartbeat lands.
        if (status?.completedAt || status?.completed_at) settle();
    };
    const onConnectionClosed = () => settle(new Error("Gateway connection closed"));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    resolvePromise = resolve;
    rejectPromise = reject;
    dispatcher.subscribe(HEARTBEAT_SUCCESS, onHeartbeat);
    dispatcher.subscribe(HEARTBEAT_FAILURE, onHeartbeatFailure);
    dispatcher.subscribe(USER_STATUS_UPDATE, onStatusUpdate);
    dispatcher.subscribe(CONNECTION_CLOSED, onConnectionClosed);
    armIdle();
    absoluteTimer = setTimer(() => settle(new Error(`heartbeat timeout (${Math.round(absoluteMs / 1000)}s cap)`)), absoluteMs);
    if (options.isComplete) {
        pollTimer = setPoll(() => {
            try {
                if (options.isComplete?.()) settle();
            } catch { /* store lookup is best-effort */ }
        }, pollMs);
    }

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

