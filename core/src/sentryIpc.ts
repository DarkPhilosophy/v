/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

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
