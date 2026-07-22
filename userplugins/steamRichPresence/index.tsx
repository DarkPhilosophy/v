/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Alex } from "../_shared/author";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { Activity } from "@vencord/discord-types";
import { ActivityFlags, ActivityStatusDisplayType, ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";
import type * as NativeModule from "./native";

const Native = VencordNative.pluginHelpers.SteamRichPresence as PluginNative<typeof NativeModule>;
const APPLICATION_ID = "1372662863755218944";
const SOCKET_ID = "SteamRichPresence";

export interface SteamGame {
    appId: string;
    name: string;
    description?: string;
    headerImage?: string;
}

const settings = definePluginSettings({
    refreshInterval: {
        type: OptionType.SLIDER,
        description: "How often to check the host for a running Steam game (seconds)",
        markers: [5, 10, 15, 30, 60],
        default: 15,
        restartNeeded: true
    },
    showDescription: {
        type: OptionType.BOOLEAN,
        description: "Show the game's Steam description in your activity",
        default: true
    }
});

function publish(activity: Activity | null) {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: SOCKET_ID
    });
}

export default definePlugin({
    name: "SteamRichPresence",
    description: "Shows the Steam game running on your Linux host as Discord Rich Presence",
    authors: [Alex],
    settings,

    currentAppId: null as string | null,
    startedAt: 0,
    updateInterval: undefined as ReturnType<typeof setInterval> | undefined,
    updateInFlight: false,

    start() {
        void this.updatePresence();
        this.updateInterval = setInterval(
            () => void this.updatePresence(),
            settings.store.refreshInterval * 1000
        );
    },

    stop() {
        if (this.updateInterval) clearInterval(this.updateInterval);
        this.updateInterval = undefined;
        this.currentAppId = null;
        this.startedAt = 0;
        publish(null);
    },

    async updatePresence() {
        if (this.updateInFlight) return;
        this.updateInFlight = true;

        try {
            const game = await Native.getRunningSteamGame();
            if (!game) {
                if (this.currentAppId) publish(null);
                this.currentAppId = null;
                this.startedAt = 0;
                return;
            }

            if (game.appId !== this.currentAppId) {
                this.currentAppId = game.appId;
                this.startedAt = Date.now();
            }

            let largeImage: string | undefined;
            if (game.headerImage) {
                try {
                    [largeImage] = await ApplicationAssetUtils.fetchAssetIds(APPLICATION_ID, [game.headerImage]);
                } catch {
                    largeImage = undefined;
                }
            }

            const steamUrl = `https://store.steampowered.com/app/${game.appId}`;
            publish({
                application_id: APPLICATION_ID,
                name: game.name,
                details: game.name,
                state: settings.store.showDescription ? game.description : undefined,
                timestamps: { start: this.startedAt },
                assets: largeImage ? {
                    large_image: largeImage,
                    large_text: game.name
                } : undefined,
                buttons: ["View on Steam"],
                metadata: { button_urls: [steamUrl] },
                type: ActivityType.PLAYING,
                status_display_type: ActivityStatusDisplayType.DETAILS,
                flags: ActivityFlags.INSTANCE
            });
        } finally {
            this.updateInFlight = false;
        }
    }
});
