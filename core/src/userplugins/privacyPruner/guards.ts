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
