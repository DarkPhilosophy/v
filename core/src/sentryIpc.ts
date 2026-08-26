export const SENTRY_IPC_NAMESPACE = "sentry-ipc";

type SentryIpcChannel = Record<string, (...args: unknown[]) => void>;
type SentryIpcBridge = Record<string, unknown> & {
    [SENTRY_IPC_NAMESPACE]?: SentryIpcChannel;
};

const noopChannel: SentryIpcChannel = {
    sendRendererStart() { },
    sendScope() { },
    sendEnvelope() { },
    sendStatus() { },
    sendStructuredLog() { },
    sendMetric() { }
};

export function createNoopSentryIpcBridge(existing: unknown): SentryIpcBridge {
    const bridge = existing && typeof existing === "object"
        ? existing as SentryIpcBridge
        : {};

    if (bridge[SENTRY_IPC_NAMESPACE]) return bridge;

    return {
        ...bridge,
        [SENTRY_IPC_NAMESPACE]: noopChannel
    };
}

export function installNoopSentryIpc(target: Record<string, unknown>): void {
    const existing = target.__SENTRY_IPC__;
    if (existing && typeof existing === "object" && (existing as SentryIpcBridge)[SENTRY_IPC_NAMESPACE])
        return;

    Object.defineProperty(target, "__SENTRY_IPC__", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: createNoopSentryIpcBridge(existing)
    });
}
