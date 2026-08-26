import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { parseSyncedState, serializeSyncedState, type SyncedPruningState } from "./model";

export const settings = definePluginSettings({
    syncedState: {
        type: OptionType.STRING,
        description: "Synchronized Privacy Pruner policies and Keep markers",
        default: "",
        hidden: true,
    },
    scanOnStartup: {
        type: OptionType.BOOLEAN,
        description: "Run due channel scans after Discord starts",
        default: true,
    },
    defaultTemplate: {
        type: OptionType.STRING,
        description: "Default policy copied to newly auto-configured conversations",
        default: JSON.stringify({ retentionMs: 86_400_000, maximumLookbackMs: 31_536_000_000, scanIntervalMs: 7_200_000, includeThreads: true }),
        hidden: true,
    },
    autoApplyGuilds: {
        type: OptionType.BOOLEAN,
        description: "Apply defaults to guilds joined after this option is enabled",
        default: false,
        hidden: true,
    },
    autoApplyDms: {
        type: OptionType.BOOLEAN,
        description: "Apply defaults to newly created direct messages",
        default: false,
        hidden: true,
    },
    autoApplyGroupDms: {
        type: OptionType.BOOLEAN,
        description: "Apply defaults to newly created group direct messages",
        default: false,
        hidden: true,
    },
    autoManagedGuildIds: {
        type: OptionType.STRING,
        description: "Guilds that received the opt-in new-guild template",
        default: "[]",
        hidden: true,
    },
});

export function readSyncedState(): SyncedPruningState {
    return parseSyncedState(settings.store.syncedState);
}

export function writeSyncedState(state: SyncedPruningState): void {
    settings.store.syncedState = serializeSyncedState(state);
}
