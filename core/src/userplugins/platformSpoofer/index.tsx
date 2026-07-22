/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { addGlobalContextMenuPatch, findGroupChildrenByChildId, GlobalContextMenuPatchCallback, removeGlobalContextMenuPatch } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { Menu } from "@webpack/common";
import { waitForStore } from "@webpack/common/internal";


const logger = new Logger("PlatformSpoofer");

// ── Types ──

/** Discord's GatewaySocket. Current clients can send IDENTIFY through either
 * handleIdentify()/webSocket.send() or socket.send(), so both paths are patched. */
interface GatewaySocket {
    send(...args: unknown[]): void;
    handleIdentify?: (...args: unknown[]) => void;
    webSocket?: { send(data: unknown): void; } | null;
    compressionHandler?: Record<string, unknown> | null;
    close(...args: unknown[]): void;
    connect?(): void;
    seq?: number | null;
    sessionId?: string | null;
}
type WebSocketLike = NonNullable<GatewaySocket["webSocket"]>;

interface GatewayConnectionStoreType {
    getSocket(): GatewaySocket | null;
}

// ── Platform data ──
// Values verified from PlatformSimulator (YofukashiNo) — the reference implementation.

const PLATFORMS = {
    windows: { label: "Windows", os: "Windows", browser: "Discord Client" },
    macos: { label: "macOS", os: "Mac OS X", browser: "Discord Client" },
    linux: { label: "Linux", os: "Linux", browser: "Discord Client" },
    web: { label: "Web", os: "Other", browser: "Discord Web" },
    android: { label: "Android", os: "Android", browser: "Discord Android" },
    ios: { label: "iOS", os: "iOS", browser: "Discord iOS" },
    embedded: { label: "Embedded", os: "Other", browser: "Discord Embedded" },
    playstation: { label: "PlayStation", os: "Playstation", browser: "Discord Embedded" },
    xbox: { label: "Xbox", os: "Xbox", browser: "Discord Embedded" },
} as const;

type PlatformKey = keyof typeof PLATFORMS;


// ── Patch state ──
interface SocketPatch {
    originalHandleIdentify: ((...args: unknown[]) => void) | undefined;
    originalSend: (...args: unknown[]) => void;
    wrappedWebSocket?: WebSocketLike;
    originalWsSend?: (data: unknown) => void;
    compressionHandler?: Record<string, unknown>;
    compressionMethod?: string;
    originalCompressionMethod?: (...args: unknown[]) => unknown;
}
const patchedSockets = new Map<GatewaySocket, SocketPatch>();
let realStore: GatewayConnectionStoreType | null = null;
let originalGetSocket: (() => GatewaySocket | null) | null = null;
let identifyLogged = false;
let wsCallLogged = false;
let wsParseFailureLogged = false;
let compressionDiagnosticLogged = false;
let pluginGeneration = 0;
let initialReconnectTimer: NodeJS.Timeout | null = null;
let initialReconnectAttempted = false;
let pendingPlatformReconnect = false;
let erlpackModule: Record<string, unknown> | null = null;
let originalErlpackPack: ((...args: unknown[]) => unknown) | null = null;
let earlyFastConnectTimer: NodeJS.Timeout | null = null;
let earlyFastConnectSocket: WebSocketLike | null = null;
let originalEarlyFastConnectSend: ((data: unknown) => void) | null = null;

function scheduleInitialPlatformReconnect(): void {
    if (initialReconnectTimer || initialReconnectAttempted) return;
    initialReconnectTimer = setTimeout(() => {
        initialReconnectTimer = null;
        if (identifyLogged || initialReconnectAttempted) return;
        initialReconnectAttempted = true;
        logger.info("Initial IDENTIFY was not intercepted; reconnecting gateway once");
        reconnectGateway();
    }, 1500);
}


interface DecodedPayload {
    text: string;
    encode(text: string): unknown;
}

function decodeGatewayPayload(data: unknown): DecodedPayload | null {
    if (typeof data === "string") {
        return { text: data, encode: text => text };
    }

    if (data instanceof ArrayBuffer) {
        return {
            text: new TextDecoder().decode(data),
            encode: text => new TextEncoder().encode(text).buffer
        };
    }

    if (ArrayBuffer.isView(data)) {
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        return {
            text: new TextDecoder().decode(bytes),
            encode: text => new TextEncoder().encode(text)
        };
    }

    return null;
}

function patchIdentifyObject(value: unknown): boolean {
    if (value == null || typeof value !== "object") return false;
    const payload = value as Record<string, unknown>;
    if (payload.op !== 2 || payload.d == null || typeof payload.d !== "object") return false;
    const data = payload.d as Record<string, unknown>;
    if (data.properties == null || typeof data.properties !== "object") return false;

    const properties = data.properties as Record<string, unknown>;
    const platform = PLATFORMS[settings.store.platform as PlatformKey];
    if (!platform) return false;
    if (platform.os) properties.os = platform.os;
    if (platform.browser) properties.browser = platform.browser;
    return true;
}

function patchIdentifyData(value: unknown): boolean {
    if (value == null || typeof value !== "object") return false;
    const data = value as Record<string, unknown>;
    if (data.properties == null || typeof data.properties !== "object") return false;

    const properties = data.properties as Record<string, unknown>;
    const platform = PLATFORMS[settings.store.platform as PlatformKey];
    if (!platform) return false;
    properties.os = platform.os;
    properties.browser = platform.browser;
    return true;
}

function patchEncodedIdentify(data: unknown): { data: unknown; patched: boolean; } {
    if (patchIdentifyObject(data)) return { data, patched: true };
    const decoded = decodeGatewayPayload(data);
    if (!decoded) return { data, patched: false };

    try {
        const parsed = JSON.parse(decoded.text);
        if (!patchIdentifyObject(parsed)) return { data, patched: false };
        return { data: decoded.encode(JSON.stringify(parsed)), patched: true };
    } catch {
        return { data, patched: false };
    }
}

function patchNativeErlpackIdentify(data: unknown): { data: unknown; patched: boolean; } {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
        return { data, patched: false };
    }

    try {
        const candidate = DiscordNative.nativeModules.requireModule("discord_erlpack") as unknown;
        if (candidate == null || typeof candidate !== "object") {
            return { data, patched: false };
        }

        const module = candidate as Record<string, unknown>;
        const { pack } = module;
        const { unpack } = module;
        if (typeof pack !== "function" || typeof unpack !== "function") {
            return { data, patched: false };
        }

        const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const decoded = unpack.call(module, bytes);
        if (!patchIdentifyObject(decoded)) {
            return { data, patched: false };
        }

        const packed = pack.call(module, decoded);
        return { data: packed instanceof Uint8Array ? packed.buffer : packed, patched: true };
    } catch {
        return { data, patched: false };
    }
}

function wrapCompressionHandler(socket: GatewaySocket, patch: SocketPatch): void {
    const handler = socket.compressionHandler;
    if (!handler || patch.compressionHandler === handler) return;

    const prototype = Object.getPrototypeOf(handler) as Record<string, unknown> | null;
    const method = ["compress", "encode"].find(name =>
        typeof handler[name] === "function" || typeof prototype?.[name] === "function"
    );
    if (!method) {
        if (!compressionDiagnosticLogged) {
            compressionDiagnosticLogged = true;
            const methods = [...new Set([
                ...Object.keys(handler),
                ...Object.getOwnPropertyNames(prototype ?? {})
            ])].filter(name => typeof handler[name] === "function" || typeof prototype?.[name] === "function");
            logger.info("Compression handler methods:", methods.join(",") || "none");
        }
        return;
    }

    const original = (handler[method] ?? prototype?.[method]) as (...args: unknown[]) => unknown;
    patch.compressionHandler = handler;
    patch.compressionMethod = method;
    patch.originalCompressionMethod = original;
    handler[method] = function interceptedCompression(...args: unknown[]): unknown {
        const result = patchEncodedIdentify(args[0]);
        if (result.patched) {
            args[0] = result.data;
            if (!identifyLogged) {
                identifyLogged = true;
                logger.info("IDENTIFY patched before compression:", settings.store.platform);
            }
        }
        return original.apply(this, args);
    };
    logger.info("Compression handler wrapped:", method);
}

function wrapErlpack(): void {
    if (!IS_DISCORD_DESKTOP || originalErlpackPack) return;

    try {
        const candidate = DiscordNative.nativeModules.requireModule("discord_erlpack") as unknown;
        if (candidate == null || typeof candidate !== "object") {
            logger.info("discord_erlpack module unavailable");
            return;
        }

        const module = candidate as Record<string, unknown>;
        if (typeof module.pack !== "function") {
            logger.info("discord_erlpack methods:", Object.keys(module).filter(key => typeof module[key] === "function").join(",") || "none");
            return;
        }

        const original = module.pack.bind(module) as (...args: unknown[]) => unknown;
        erlpackModule = module;
        originalErlpackPack = original;
        module.pack = (...args: unknown[]): unknown => {
            if (patchIdentifyObject(args[0]) && !identifyLogged) {
                identifyLogged = true;
                logger.info("IDENTIFY patched before ETF encoding:", settings.store.platform);
            }
            return original(...args);
        };
        logger.info("discord_erlpack.pack wrapped");
    } catch {
        logger.info("discord_erlpack module unavailable");
    }
}
function patchEarlyFastConnectSocket(): boolean {
    const windowWithFastConnect = window as Window & { _ws?: { ws?: WebSocketLike | null; }; };
    const socket = windowWithFastConnect._ws?.ws;
    if (!socket || typeof socket.send !== "function") return false;
    if (socket === earlyFastConnectSocket) return true;

    if (earlyFastConnectSocket && originalEarlyFastConnectSend) {
        earlyFastConnectSocket.send = originalEarlyFastConnectSend;
        earlyFastConnectSocket = null;
        originalEarlyFastConnectSend = null;
    }

    const originalSend = socket.send.bind(socket) as (data: unknown) => void;
    earlyFastConnectSocket = socket;
    originalEarlyFastConnectSend = originalSend;
    socket.send = function interceptedInitialGatewaySend(data: unknown): void {
        const nativePatched = patchNativeErlpackIdentify(data);
        const patched = nativePatched.patched ? nativePatched : patchEncodedIdentify(data);
        if (patched.patched) {
            identifyLogged = true;
            logger.info("Initial IDENTIFY patched before fast-connect send:", settings.store.platform);
            socket.send = originalSend;
            earlyFastConnectSocket = null;
            originalEarlyFastConnectSend = null;
            if (earlyFastConnectTimer !== null) {
                clearInterval(earlyFastConnectTimer);
                earlyFastConnectTimer = null;
            }
            originalSend(patched.data);
            return;
        }
        originalSend(data);
    };
    logger.info("FAST CONNECT send wrapper installed");
    return true;
}

function scheduleEarlyFastConnectPatch(generation: number): void {
    if (earlyFastConnectTimer || identifyLogged) return;
    let attempts = 0;
    earlyFastConnectTimer = setInterval(() => {
        if (pluginGeneration !== generation || identifyLogged || ++attempts >= 100) {
            clearInterval(earlyFastConnectTimer!);
            earlyFastConnectTimer = null;
            return;
        }
        patchEarlyFastConnectSocket();
    }, 10);
    patchEarlyFastConnectSocket();
}

// ── Gateway interception ──


/** Wrap the current webSocket.send, re-wrapping when Discord swaps the WebSocket. */
function wrapWsSend(socket: GatewaySocket, patch: SocketPatch): void {
    const ws = socket.webSocket;
    if (!ws || typeof ws.send !== "function") return;
    if (patch.wrappedWebSocket === ws) return;

    if (patch.wrappedWebSocket && patch.originalWsSend) {
        patch.wrappedWebSocket.send = patch.originalWsSend;
    }

    const originalWsSend = ws.send.bind(ws) as (data: unknown) => void;
    patch.wrappedWebSocket = ws;
    patch.originalWsSend = originalWsSend;
    ws.send = function interceptedWsSend(data: unknown): void {
        const decoded = decodeGatewayPayload(data);
        if (!wsCallLogged) {
            wsCallLogged = true;
            const byteLength = typeof data === "string"
                ? data.length
                : ArrayBuffer.isView(data)
                    ? data.byteLength
                    : data instanceof ArrayBuffer
                        ? data.byteLength
                        : -1;
            logger.info("ws.send FIRST call — type:", Object.prototype.toString.call(data), "byteLength:", byteLength, "decodable:", decoded != null);
        }

        if (decoded) {
            try {
                const parsed = JSON.parse(decoded.text);
                if (parsed?.op === 2 && parsed?.d?.properties) {
                    const plat = PLATFORMS[settings.store.platform as PlatformKey];
                    if (plat) {
                        if (plat.os) parsed.d.properties.os = plat.os;
                        if (plat.browser) parsed.d.properties.browser = plat.browser;
                        data = decoded.encode(JSON.stringify(parsed));
                        if (!identifyLogged) {
                            identifyLogged = true;
                            logger.info("IDENTIFY patched:", settings.store.platform);
                        }
                    }
                }
            } catch {
                if (!wsParseFailureLogged) {
                    wsParseFailureLogged = true;
                    logger.info("ws.send payload is not plain JSON");
                }
            }
        }

        return originalWsSend(data);
    };
    logger.info("webSocket.send wrapped");
}
function patchGatewayStore(store: GatewayConnectionStoreType): void {
    if (realStore) return;
    realStore = store;
    logger.info("GatewayConnectionStore resolved");

    originalGetSocket = store.getSocket.bind(store);

    store.getSocket = function getSocketPatched(): GatewaySocket | null {
        const socket = originalGetSocket!();
        if (!socket) return null;
        if (pendingPlatformReconnect) {
            pendingPlatformReconnect = false;
            queueMicrotask(reconnectGateway);
        }
        const existingPatch = patchedSockets.get(socket);
        if (existingPatch) {
            wrapCompressionHandler(socket, existingPatch);
            wrapWsSend(socket, existingPatch);
            return socket;
        }
        const originalSend = socket.send.bind(socket) as (...args: unknown[]) => void;
        const originalHandleIdentify = socket.handleIdentify?.bind(socket);

        const patch: SocketPatch = { originalHandleIdentify, originalSend };
        patchedSockets.set(socket, patch);

        // Fallback for GatewaySocket.send signatures used by older/newer clients.
        socket.send = function patchedSend(...args: unknown[]): void {
            const patched = patchIdentifyObject(args[0])
                || (args[0] === 2 && patchIdentifyObject({ op: 2, d: args[1] }));
            if (patched && !identifyLogged) {
                identifyLogged = true;
                logger.info("IDENTIFY patched via socket.send:", settings.store.platform);
            }
            return originalSend(...args);
        };

        // Catch IDENTIFY before Discord compresses it into the binary WebSocket frame.
        wrapCompressionHandler(socket, patch);
        // Try wrapping ws.send now (may fail if webSocket doesn't exist yet).
        wrapWsSend(socket, patch);

        // Wrap handleIdentify: when Discord calls it, socket.webSocket is guaranteed
        // to exist (confirmed via runtime diagnostic). This is where we permanently
        // install the ws.send interceptor — right before IDENTIFY is sent.
        if (originalHandleIdentify) {
            socket.handleIdentify = function patchedHandleIdentify(...args: unknown[]): unknown {
                wrapCompressionHandler(socket, patch);
                const patchedArgs = args.some(arg => patchIdentifyObject(arg) || patchIdentifyData(arg));
                const result = originalHandleIdentify(...args);
                const patchedResult = patchIdentifyData(result);
                if ((patchedArgs || patchedResult) && !identifyLogged) {
                    identifyLogged = true;
                    logger.info("IDENTIFY patched via handleIdentify:", settings.store.platform);
                }
                wrapWsSend(socket, patch);
                return result;
            };
        }

        logger.info("Socket wrapped");
        return socket;
    };
}

function reconnectGateway(): void {
    const socket = realStore?.getSocket?.();
    if (!socket) {
        pendingPlatformReconnect = true;
        return;
    }
    pendingPlatformReconnect = false;
    socket.sessionId = null;
    socket.seq = null;
    const generation = pluginGeneration;
    socket.close(1000, "Platform changed");
    queueMicrotask(() => {
        if (pluginGeneration === generation) socket.connect?.();
    });
}

let submenuObserver: MutationObserver | null = null;
let submenuAlignmentFrame = 0;

function alignPlatformSubmenu(): void {
    const trigger = document.querySelector<HTMLElement>('#vc-platform-spoofer, [id$="-vc-platform-spoofer"]');
    const option = document.querySelector<HTMLElement>('#vc-platform-spoofer-windows, [id$="-vc-platform-spoofer-windows"]');
    const submenu = option?.closest<HTMLElement>("[role=menu]");
    if (!trigger || !submenu) return;

    submenu.style.translate = "";
    const offset = Math.round(trigger.getBoundingClientRect().bottom - submenu.getBoundingClientRect().bottom);
    submenu.style.translate = `0 ${offset}px`;
}

function watchPlatformSubmenu(): void {
    submenuObserver = new MutationObserver(() => {
        if (submenuAlignmentFrame) return;
        submenuAlignmentFrame = requestAnimationFrame(() => {
            submenuAlignmentFrame = 0;
            alignPlatformSubmenu();
        });
    });

    const observe = () => {
        if (submenuObserver && document.body) {
            submenuObserver.observe(document.body, { childList: true, subtree: true });
        }
    };
    if (document.body) observe();
    else window.addEventListener("DOMContentLoaded", observe, { once: true });
}


// ── Settings ──

const settings = definePluginSettings({
    platform: {
        type: OptionType.SELECT,
        description: "The platform to appear as on Discord. Changing it briefly reconnects the gateway.",
        options: Object.entries(PLATFORMS).map(([value, { label }]) => ({
            value,
            label,
            default: value === "windows",
        })),
        onChange() {
            identifyLogged = false;
            wsCallLogged = false;
            wsParseFailureLogged = false;
            reconnectGateway();
        },
    },
});
// ── Status picker integration ──

const statusMenuPatch: GlobalContextMenuPatchCallback = (navId, children) => {
    if (navId !== "set-status-submenu") return;
    const onlineGroup = findGroupChildrenByChildId("online", children);
    if (!onlineGroup) return;
    if (findGroupChildrenByChildId("idle", children) !== onlineGroup
        || findGroupChildrenByChildId("dnd", children) !== onlineGroup
        || findGroupChildrenByChildId("invisible", children) !== onlineGroup
        || onlineGroup.some(item => item?.props?.id === "vc-platform-spoofer")) {
        return;
    }

    const current = settings.store.platform as PlatformKey;
    onlineGroup.push(
        <Menu.MenuItem
            id="vc-platform-spoofer"
            key="vc-platform-spoofer"
            label={`Platform: ${PLATFORMS[current]?.label ?? current}`}
        >
            {(Object.entries(PLATFORMS) as Array<[PlatformKey, { label: string; }]>).map(([key, { label }]) => (
                <Menu.MenuRadioItem
                    checked={key === current}
                    group="vc-platform-spoofer"
                    id={`vc-platform-spoofer-${key}`}
                    key={key}
                    label={label}
                    action={() => {
                        settings.store.platform = key;
                    }}
                />
            ))}
        </Menu.MenuItem>
    );
};
// ── Plugin ──

export default definePlugin({
    name: "PlatformSpoofer",
    description: "Spoof your Discord client platform (Desktop, Mobile, Web, Console). Requires Discord restart for guaranteed effect.",
    authors: [{ name: "Alex", id: 0n }],
    settings,

    // Run at Init — waitForStore callback fires when webpack loads the store module.
    startAt: StartAt.Init,

    start() {
        if ((settings.store.platform as string) === "horizon") {
            settings.store.platform = "android";
        }
        pluginGeneration++;
        const generation = pluginGeneration;
        initialReconnectAttempted = false;
        addGlobalContextMenuPatch(statusMenuPatch);
        watchPlatformSubmenu();
        scheduleEarlyFastConnectPatch(generation);
        wrapErlpack();
        waitForStore("GatewayConnectionStore", (store: GatewayConnectionStoreType) => {
            if (pluginGeneration !== generation) return;
            patchGatewayStore(store);
            store.getSocket();
            scheduleInitialPlatformReconnect();
        });
    },

    stop() {
        pluginGeneration++;
        removeGlobalContextMenuPatch(statusMenuPatch);
        submenuObserver?.disconnect();
        submenuObserver = null;
        if (submenuAlignmentFrame) {
            cancelAnimationFrame(submenuAlignmentFrame);
            submenuAlignmentFrame = 0;
        }
        if (initialReconnectTimer !== null) {
            clearTimeout(initialReconnectTimer);
            initialReconnectTimer = null;
        }
        if (erlpackModule && originalErlpackPack) {
            erlpackModule.pack = originalErlpackPack;
        }
        erlpackModule = null;
        if (earlyFastConnectSocket && originalEarlyFastConnectSend) {
            earlyFastConnectSocket.send = originalEarlyFastConnectSend;
        }
        earlyFastConnectSocket = null;
        originalEarlyFastConnectSend = null;
        if (earlyFastConnectTimer !== null) {
            clearInterval(earlyFastConnectTimer);
            earlyFastConnectTimer = null;
        }
        originalErlpackPack = null;
        if (realStore && originalGetSocket) {
            realStore.getSocket = originalGetSocket;
        }
        realStore = null;
        originalGetSocket = null;

        for (const [socket, patch] of patchedSockets) {
            if (patch.compressionHandler && patch.compressionMethod && patch.originalCompressionMethod) {
                patch.compressionHandler[patch.compressionMethod] = patch.originalCompressionMethod;
            }
            if (patch.wrappedWebSocket && patch.originalWsSend) {
                patch.wrappedWebSocket.send = patch.originalWsSend;
            }
            if (patch.originalHandleIdentify) {
                socket.handleIdentify = patch.originalHandleIdentify;
            }
            socket.send = patch.originalSend;
        }
        patchedSockets.clear();
        pendingPlatformReconnect = false;
        initialReconnectAttempted = false;
        identifyLogged = false;
        wsCallLogged = false;
        wsParseFailureLogged = false;
        compressionDiagnosticLogged = false;
    },
});
