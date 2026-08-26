import { setChannelPolicy, setGuildEnabled, type ChannelPolicy, type SyncedPruningState } from "./model";

const DAY = 86_400_000;

export type AutoApplyTarget = "guild" | "dm" | "groupDm";

export interface PruningTemplate {
    retentionMs: number;
    maximumLookbackMs: number;
    scanIntervalMs: number;
    includeThreads: boolean;
}

export interface AutoApplySettings {
    template: PruningTemplate;
    autoApply: Record<AutoApplyTarget, boolean>;
}

export const DEFAULT_PRUNING_TEMPLATE: PruningTemplate = {
    retentionMs: DAY,
    maximumLookbackMs: 365 * DAY,
    scanIntervalMs: 2 * 60 * 60 * 1000,
    includeThreads: true,
};

export const DEFAULT_AUTO_APPLY: AutoApplySettings["autoApply"] = {
    guild: false,
    dm: false,
    groupDm: false,
};

export function classifyAutoApplyTarget(channel: { type: number; }): AutoApplyTarget | undefined {
    if (channel.type === 1) return "dm";
    if (channel.type === 3) return "groupDm";
    return;
}

export function registerNewId(knownIds: Set<string>, id: string): boolean {
    if (knownIds.has(id)) return false;
    knownIds.add(id);
    return true;
}

export function templateToPolicy(template: PruningTemplate): ChannelPolicy {
    return { ...template, enabled: true };
}

export function applyDefaultPolicy(
    state: SyncedPruningState,
    input: { id: string; guildId: string | null; target: AutoApplyTarget; },
    defaults: AutoApplySettings,
): SyncedPruningState {
    if (!defaults.autoApply[input.target] || state.channels[input.id]) return state;
    const withGuild = input.guildId && input.target === "guild"
        ? setGuildEnabled(state, input.guildId, true)
        : state;
    return setChannelPolicy(withGuild, input.id, input.guildId, templateToPolicy(defaults.template), Date.now());
}
