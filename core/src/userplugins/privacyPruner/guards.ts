export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

export function formatUnknownError(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string") return error;
    if (!isUnknownRecord(error)) return String(error);

    const body = isUnknownRecord(error.body) ? error.body : undefined;
    const message = typeof body?.message === "string"
        ? body.message
        : typeof error.message === "string"
            ? error.message
            : undefined;
    const status = typeof error.status === "number" ? `HTTP ${error.status}` : undefined;
    const retryAfter = typeof body?.retry_after === "number" ? `retry in ${body.retry_after}s` : undefined;
    const details = [status, retryAfter].filter(Boolean).join("; ");
    if (message) return details ? `${message} (${details})` : message;

    try {
        return JSON.stringify(error);
    } catch {
        return "Unknown error.";
    }
}
export function getHttpStatus(error: unknown): number | undefined {
    if (!isUnknownRecord(error)) return;
    return typeof error.status === "number" ? error.status : undefined;
}

export function isArchivedThreadError(error: unknown): boolean {
    if (!isUnknownRecord(error) || error.status !== 400 || !isUnknownRecord(error.body)) return false;
    return error.body.code === 50083;
}


export function getRateLimitDelayMs(error: unknown): number | undefined {
    if (!isUnknownRecord(error) || error.status !== 429 || !isUnknownRecord(error.body)) return;
    const retryAfter = error.body.retry_after;
    if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter <= 0) return;
    return Math.max(1_000, retryAfter * 1_000);
}

export function getRetryDelayMs(error: unknown): number {
    return getRateLimitDelayMs(error) ?? 60_000;
}

/**
 * Discord says the channel does not exist (10003 Unknown Channel). Unlike an access
 * error this is definitive: there is nothing left to prune and its stored policy can
 * be dropped.
 */
export function isChannelGoneError(error: unknown): boolean {
    return isUnknownRecord(error) && error.status === 404
        && isUnknownRecord(error.body) && error.body.code === 10003;
}

/**
 * The channel exists but we may not touch it (50001 Missing Access, 50013 Missing
 * Permissions). That can be temporary (lost role, rejoined server later), so it only
 * earns a long backoff, never a deletion: the policy syncs across devices.
 */
export function isChannelUnavailableError(error: unknown): boolean {
    if (!isUnknownRecord(error) || !isUnknownRecord(error.body)) return false;
    const code = error.body.code;
    return error.status === 403 && (code === 50001 || code === 50013);
}

/** Access can come back (rejoined server, role restored), so check again occasionally instead of giving up for good. */
export const UNAVAILABLE_CHANNEL_RETRY_MS = 6 * 60 * 60 * 1000;
