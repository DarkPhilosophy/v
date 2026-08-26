import { isUnknownRecord } from "./guards.ts";

export interface ChannelPolicy {
    enabled: boolean;
    retentionMs: number;
    maximumLookbackMs: number;
    scanIntervalMs: number;
    includeThreads?: boolean;
}

export interface GuildPolicy {
    enabled: boolean;
}

export interface ChannelPolicyRecord {
    guildId: string | null;
    policy: ChannelPolicy;
    confirmedAt?: number;
}

export interface KeptMessageRecord {
    channelId: string;
    guildId?: string;
}

export interface SyncedPruningState {
    version: 1;
    guilds: Record<string, GuildPolicy>;
    channels: Record<string, ChannelPolicyRecord>;
    kept: Record<string, KeptMessageRecord>;
}

export const EMPTY_SYNCED_STATE: SyncedPruningState = {
    version: 1,
    guilds: {},
    channels: {},
    kept: {},
};


function isPositiveFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseChannelPolicy(value: unknown): ChannelPolicyRecord | undefined {
    if (!isUnknownRecord(value) || !isUnknownRecord(value.policy)) return;
    const { enabled, retentionMs, maximumLookbackMs, scanIntervalMs, includeThreads } = value.policy;
    if (
        typeof enabled !== "boolean" ||
        !isPositiveFiniteNumber(retentionMs) ||
        !isPositiveFiniteNumber(maximumLookbackMs) ||
        !isPositiveFiniteNumber(scanIntervalMs)
    ) return;

    const guildId = value.guildId;
    if (guildId !== null && typeof guildId !== "string") return;

    return {
        guildId,
        policy: {
            enabled,
            retentionMs,
            maximumLookbackMs,
            scanIntervalMs,
            ...(typeof includeThreads === "boolean" ? { includeThreads } : {}),
        },
        confirmedAt: typeof value.confirmedAt === "number" ? value.confirmedAt : undefined,
    };
}

export function parseSyncedState(serialized: string): SyncedPruningState {
    if (!serialized) return structuredClone(EMPTY_SYNCED_STATE);

    try {
        const value: unknown = JSON.parse(serialized);
        if (!isUnknownRecord(value) || value.version !== 1) return structuredClone(EMPTY_SYNCED_STATE);

        const guilds: Record<string, GuildPolicy> = {};
        if (isUnknownRecord(value.guilds)) {
            for (const [id, policy] of Object.entries(value.guilds)) {
                if (isUnknownRecord(policy) && typeof policy.enabled === "boolean")
                    guilds[id] = { enabled: policy.enabled };
            }
        }

        const channels: Record<string, ChannelPolicyRecord> = {};
        if (isUnknownRecord(value.channels)) {
            for (const [id, policy] of Object.entries(value.channels)) {
                const parsed = parseChannelPolicy(policy);
                if (parsed) channels[id] = parsed;
            }
        }

        const kept: Record<string, KeptMessageRecord> = {};
        if (isUnknownRecord(value.kept)) {
            for (const [messageId, record] of Object.entries(value.kept)) {
                if (!isUnknownRecord(record) || typeof record.channelId !== "string") continue;
                kept[messageId] = {
                    channelId: record.channelId,
                    guildId: typeof record.guildId === "string" ? record.guildId : undefined,
                };
            }
        }

        return { version: 1, guilds, channels, kept };
    } catch {
        return structuredClone(EMPTY_SYNCED_STATE);
    }
}

export function serializeSyncedState(state: SyncedPruningState): string {
    return JSON.stringify(state);
}

export function validatePolicy(policy: ChannelPolicy): string[] {
    if (!isPositiveFiniteNumber(policy.retentionMs))
        return ["Retention must be greater than zero."];
    if (!isPositiveFiniteNumber(policy.maximumLookbackMs))
        return ["Search history must be greater than zero."];
    if (policy.maximumLookbackMs <= policy.retentionMs)
        return ["Search history must be longer than retention."];
    if (!isPositiveFiniteNumber(policy.scanIntervalMs))
        return ["Scan interval must be greater than zero."];
    return [];
}

export function isPruningActive(input: { guildEnabled: boolean; channelEnabled: boolean; isDm: boolean; }): boolean {
    return input.channelEnabled && (input.isDm || input.guildEnabled);
}

export function computeWindow(policy: ChannelPolicy, now = Date.now()) {
    return {
        oldestTimestamp: now - policy.maximumLookbackMs,
        newestTimestamp: now - policy.retentionMs,
    };
}

export function setGuildEnabled(state: SyncedPruningState, guildId: string, enabled: boolean): SyncedPruningState {
    return { ...state, guilds: { ...state.guilds, [guildId]: { enabled } } };
}

export function setChannelPolicy(
    state: SyncedPruningState,
    channelId: string,
    guildId: string | null,
    policy: ChannelPolicy,
    confirmedAt?: number,
): SyncedPruningState {
    return {
        ...state,
        channels: {
            ...state.channels,
            [channelId]: { guildId, policy: { ...policy }, confirmedAt },
        },
    };
}

export function saveChannelPolicySettings(
    state: SyncedPruningState,
    channelId: string,
    guildId: string | null,
    editedPolicy: ChannelPolicy,
): SyncedPruningState {
    const existing = state.channels[channelId];
    return setChannelPolicy(
        state,
        channelId,
        guildId,
        {
            ...editedPolicy,
            enabled: existing?.policy.enabled ?? false,
        },
        existing?.confirmedAt,
    );
}

export function setMessageKept(
    state: SyncedPruningState,
    message: { messageId: string; channelId: string; guildId?: string; },
    keep: boolean,
): SyncedPruningState {
    const kept = { ...state.kept };
    if (keep) kept[message.messageId] = { channelId: message.channelId, guildId: message.guildId };
    else delete kept[message.messageId];
    return { ...state, kept };
}
