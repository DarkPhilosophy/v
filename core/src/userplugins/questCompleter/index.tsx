/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByProps } from "@webpack";
import { Button, FluxDispatcher, Forms, RestAPI, showToast, Toasts } from "@webpack/common";


const logger = new Logger("QuestCompleter");

// ── Store / API shapes (minified at runtime, typed here for our access) ──

interface QuestTask { target: number; }

interface Quest {
    id: string;
    preview: boolean;
    config: {
        id: string;
        configVersion: number;
        startsAt: string;
        expiresAt: string;
        features: number[];
        assets: Record<string, string>;
        colors?: Record<string, string>;
        messages: {
            questName: string;
            gameTitle?: string;
            gamePublisher?: string;
        };
        taskConfig?: { tasks: Record<string, QuestTask>; };
        taskConfigV2?: { tasks: Record<string, QuestTask>; joinOperator?: string; };
        rewardsConfig?: {
            assignmentMethod: number;
            rewards: Array<{ type: number; skuId: string; orbQuantity?: number; premiumOrbQuantity?: number; }>;
            rewardsExpireAt: string;
            platforms: number[];
        };
        cosponsorMetadata?: unknown;
        sharePolicy?: string;
        ctaConfig?: { link?: string; buttonLabel?: string; subtitle?: string; };
    };
    userStatus?: {
        userId?: string;
        questId?: string;
        enrolledAt?: string;
        completedAt?: string;
        claimedAt?: string;
        claimedTier?: number;
        orbQuantityClaimed?: number;
        lastStreamHeartbeatAt?: string;
        streamProgressSeconds?: number;
        dismissedQuestContent?: unknown;
        progress?: Record<string, { value: number; }>;
    } | null;
    targetedContent?: unknown[];
    trafficMetadataSealed?: string;
}

interface QuestsStore { quests: Map<string, Quest>; }

interface RunningGame {
    cmdLine: string;
    exeName: string;
    exePath: string;
    hidden: boolean;
    isLauncher: boolean;
    id: string;
    name: string;
    pid: number;
    pidPath: number[];
    processName: string;
    start: number;
}

interface RunningGameStore {
    getRunningGames(): RunningGame[];
    getGameForPID(pid: number): RunningGame | undefined;
}

interface PublicApplication {
    name: string;
    executables?: { os: string; name: string; }[];
}

interface HeartbeatEvent {
    questId: string;
    userStatus?: {
        progress?: Record<string, { value: number; }>;
        streamProgressSeconds?: number;
    };
}

const TASK_ORDER = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY"] as const;

const settings = definePluginSettings({
    autoComplete: {
        type: OptionType.BOOLEAN,
        description: "Automatically complete enrolled quests when they load or when you enroll",
        default: false,
    },
    autoEnroll: {
        type: OptionType.BOOLEAN,
        description: "Also accept (enroll) quests that aren't accepted yet, then complete them",
        default: false,
    },
    doVideoQuests: {
        type: OptionType.BOOLEAN,
        description: "Complete WATCH_VIDEO quests (instant)",
        default: true,
    },
    doPlayQuests: {
        type: OptionType.BOOLEAN,
        description: "Complete PLAY_ON_DESKTOP / STREAM_ON_DESKTOP quests (runs in real time via heartbeat)",
        default: true,
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show toast notifications for progress",
        default: true,
    },
    run: {
        type: OptionType.COMPONENT,
        description: "Complete enrolled quests now",
        component: () => (
            <>
                <Forms.FormText style={{ marginBottom: 8 }}>
                    Completes every quest you are enrolled in, honoring the toggles above. Video quests
                    finish instantly; play/stream quests run in real time — no game install required.
                </Forms.FormText>
                <Button color={Button.Colors.BRAND} onClick={() => completeAll()}>
                    Complete quests now
                </Button>
            </>
        ),
    },
});

type ToastKind = typeof Toasts.Type[keyof typeof Toasts.Type];
function toast(message: string, type: ToastKind = Toasts.Type.MESSAGE) {
    if (!settings.store.notify && type !== Toasts.Type.FAILURE) return;
    showToast(message, type);
}

// Names the setTimeout delay idiom so callers read as linear code.
function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

// findByProps throws in dev builds when the target module's lazy chunk isn't
// loaded yet (e.g. before the Quests tab is opened); wrap it so a missing store
// degrades to null instead of an uncaught webpack-error notification.
function getStore<T>(...props: string[]): T | null {
    try {
        return (findByProps(...props) as unknown as T | undefined) ?? null;
    } catch {
        return null;
    }
}

// New Discord API: application.name is gone from QuestStore. Game names now live in messages.
function getAppName(quest: Quest): string {
    return quest.config.messages.gameTitle ?? quest.config.messages.questName;
}

async function completeQuest(quest: Quest): Promise<void> {
    const tasks = quest.config.taskConfigV2?.tasks ?? quest.config.taskConfig?.tasks ?? {};
    const taskName = TASK_ORDER.find(t => tasks[t] != null);
    const appName = getAppName(quest);

    if (!taskName) {
        logger.warn("Unknown task type for quest", appName, Object.keys(tasks));
        return;
    }

    const task = tasks[taskName];
    if (!task || typeof task.target !== "number") {
        logger.warn(`${appName}: malformed task ${taskName} (no target); skipping; task=${JSON.stringify(task)}`);
        toast(`${appName}: could not read task target. Skipping.`, Toasts.Type.FAILURE);
        return;
    }
    const secondsNeeded = task.target;
    logger.info(`Quest "${quest.config.messages.questName}" (${appName}): ${taskName}, target ${secondsNeeded}s`);

    if (taskName.startsWith("WATCH_VIDEO")) {
        if (!settings.store.doVideoQuests) {
            logger.info(`Skipping video quest ${appName} (doVideoQuests off)`);
            return;
        }
        const enrolledAt = new Date(quest.userStatus!.enrolledAt!).getTime() / 1000;
        let done = Math.floor(quest.userStatus?.progress?.[taskName]?.value ?? 0);
        toast(`${appName}: watching video ${done}/${secondsNeeded}s`);
        while (done < secondsNeeded) {
            const maxByElapsed = Math.floor(Date.now() / 1000) - enrolledAt;
            const jump = Math.floor(Math.random() * 12) + 1;
            const next = Math.min(secondsNeeded, done + jump, maxByElapsed);
            if (next <= done) {
                await sleep(Math.floor(Math.random() * 3000) + 2000);
                continue;
            }
            await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: next } });
            done = next;
            logger.info(`${appName} video ${done}/${secondsNeeded}s`);
            await sleep(Math.floor(Math.random() * 4000) + 3000);
        }
        await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
        logger.info(`${appName}: video complete (${secondsNeeded}s)`);
        toast(`${appName}: video quest complete`, Toasts.Type.SUCCESS);
        return;
    }

    if (taskName === "PLAY_ON_DESKTOP" || taskName === "STREAM_ON_DESKTOP") {
        if (!settings.store.doPlayQuests) {
            logger.info(`Skipping play quest ${appName} (doPlayQuests off)`);
            return;
        }
        const store = getStore<RunningGameStore>("getRunningGames", "getGameForPID");
        if (!store) {
            logger.warn(`${appName}: game store not found (open Quests tab first)`);
            toast(`${appName}: game store unavailable. Open Discord's Quests tab first, then retry.`, Toasts.Type.FAILURE);
            return;
        }
        // Discord v2 API: application no longer lives in QuestStore.quests[id].config.
        // Fetch it from the per-quest REST endpoint, which still exposes application.id.
        const appMeta = await RestAPI.get({ url: `/quests/${quest.id}` }).then(r => r.body as { application?: { id: string; name: string; }; } | undefined);
        const realAppId = appMeta?.application?.id;
        if (!realAppId) {
            logger.warn(`${appName}: could not resolve application id from /quests/${quest.id}; skipping play quest`);
            toast(`${appName}: failed to resolve game. Skipping (API changed).`, Toasts.Type.FAILURE);
            return;
        }
        const { body } = await RestAPI.get({ url: `/applications/public?application_ids=${realAppId}` });
        const appData = (body as PublicApplication[])[0];
        const exe = (appData.executables?.find(x => x.os === "win32")?.name ?? `${appName}.exe`).replace(/^>/, "");
        const pid = Math.floor(Math.random() * 30000) + 1000;
        const gameEntry: RunningGame = {
            cmdLine: `C:\\Program Files\\${appData.name}\\${exe}`,
            exeName: exe,
            exePath: `c:/program files/${appData.name.toLowerCase()}/${exe}`,
            hidden: false,
            isLauncher: false,
            id: realAppId,
            name: appData.name,
            pid,
            pidPath: [pid],
            processName: appData.name,
            start: Date.now(),
        };

        const existingGames = store.getRunningGames();
        const getRunningSnapshot = store.getRunningGames;
        const getForPIDSnapshot = store.getGameForPID;
        const entries = [gameEntry];
        store.getRunningGames = () => entries;
        store.getGameForPID = (p: number) => entries.find(x => x.pid === p);
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: existingGames, added: [gameEntry], games: entries });
        logger.info(`${appName}: running game pid=${pid}, awaiting heartbeats`);

        toast(`${appName}: waiting for heartbeats (~${Math.ceil(secondsNeeded / 60)} min). Keep Discord open.`);

        const { promise, resolve, reject } = Promise.withResolvers<void>();
        // Restore the snapshot and unsubscribe — used on both success and heartbeat timeout.
        function cleanup(): void {
            store.getRunningGames = getRunningSnapshot;
            store.getGameForPID = getForPIDSnapshot;
            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [gameEntry], added: [], games: [] });
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onBeat);
        }
        const onBeat = (data: HeartbeatEvent) => {
            if (data.questId !== quest.id) return;
            const value = Math.floor(data.userStatus?.progress?.[taskName]?.value ?? data.userStatus?.streamProgressSeconds ?? 0);
            logger.info(`${appName} play ${value}/${secondsNeeded}s`);
            if (value < secondsNeeded) return;
            clearTimeout(watchdog);
            cleanup();
            logger.info(`${appName}: play complete (${secondsNeeded}s)`);
            toast(`${appName}: play quest complete`, Toasts.Type.SUCCESS);
            resolve();
        };
        // Safety: if Discord stops sending heartbeats (server-side cancel, network drop,
        // tab closed mid-run), restore the original game store and bail out instead of
        // leaving the override in place forever.
        const watchdog = setTimeout(() => {
            cleanup();
            logger.warn(`${appName}: heartbeat timeout (${secondsNeeded + 300}s), giving up`);
            toast(`${appName}: heartbeat timeout. Try again later.`, Toasts.Type.FAILURE);
            reject(new Error("heartbeat timeout"));
        }, (secondsNeeded + 300) * 1000);
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onBeat);
        try { await promise; } finally { clearTimeout(watchdog); }
        return;
    }

    const reason = taskName === "PLAY_ON_PLAYSTATION" || taskName === "PLAY_ON_XBOX"
        ? "requires console connected"
        : taskName === "ACHIEVEMENT_IN_ACTIVITY"
            ? "requires Discord Activity"
            : "not supported";
    logger.warn(`${appName}: task ${taskName} not automatable (${reason})`);
    toast(`${appName}: ${taskName} not automatable (${reason})`, Toasts.Type.FAILURE);
}

let running = false;
async function completeAll(silent = false): Promise<void> {
    if (running) {
        if (!silent) toast("Already running.", Toasts.Type.FAILURE);
        return;
    }
    const questsStore = getStore<QuestsStore>("getQuest", "quests");
    if (!questsStore) {
        logger.warn("QuestsStore not found; open the Quests tab first");
        if (!silent) toast("Quests not loaded yet. Open Discord's Quests tab, then retry.", Toasts.Type.FAILURE);
        return;
    }

    const now = new Date();
    const all = [...questsStore.quests.values()];
    const notEnrolled = all.filter(q => !q.userStatus?.completedAt && !q.userStatus?.enrolledAt && new Date(q.config.expiresAt) >= now);
    const todo = all.filter(q => !!q.userStatus?.enrolledAt && !q.userStatus?.completedAt && new Date(q.config.expiresAt) >= now);
    logger.info(`Scan: ${todo.length} enrolled to complete, ${notEnrolled.length} not enrolled`);

    if (settings.store.autoEnroll) {
        for (const quest of notEnrolled) {
            try {
                const res = await RestAPI.post({ url: `/quests/${quest.id}/enroll`, body: { location: 8 } });
                const enrolled = res.body as { userStatus?: Quest["userStatus"]; } | undefined;
                quest.userStatus = enrolled?.userStatus ?? { enrolledAt: new Date().toISOString() };
                todo.push(quest);
                logger.info(`Enrolled: ${quest.config.messages.questName}`);
                if (!silent) toast(`${getAppName(quest)}: enrolled`);
            } catch (err) {
                logger.error("Enroll failed", quest.config.messages.questName, err);
                if (!silent) toast(`Enroll failed: ${quest.config.messages.questName}`, Toasts.Type.FAILURE);
            }
        }
    } else if (notEnrolled.length && !silent) {
        toast(`${notEnrolled.length} quest(s) not enrolled. Enable "autoEnroll" or accept them manually.`);
    }

    if (!todo.length) {
        if (!silent) toast("No enrolled quests to complete.");
        return;
    }

    running = true;
    toast(`Completing ${todo.length} quest(s)...`);
    logger.info(`Starting completion of ${todo.length} quest(s): ${todo.map(q => q.config.messages.questName).join(", ")}`);
    try {
        for (const quest of todo) {
            try {
                await completeQuest(quest);
            } catch (err) {
                logger.error("Failed for quest", quest.config.messages.questName, err);
                toast(`Error: ${quest.config.messages.questName}`, Toasts.Type.FAILURE);
            }
        }
        logger.info("All quests processed");
        toast("Done. Check Gift Inventory.", Toasts.Type.SUCCESS);
    } finally {
        running = false;
    }
}

// Stored so start/stop can subscribe/unsubscribe the same reference.
let autoHandler: (() => void) | undefined;

export default definePlugin({
    name: "QuestCompleter",
    description: "Complete Discord Quests on Linux (where Quests lack full native support).",
    authors: [{ name: "Alex", id: 0n }],
    settings,

    start() {
        if (!settings.store.autoComplete) return;
        autoHandler = () => { completeAll(true); };
        FluxDispatcher.subscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", autoHandler);
        FluxDispatcher.subscribe("QUESTS_ENROLL_SUCCESS", autoHandler);
    },

    stop() {
        if (!autoHandler) return;
        FluxDispatcher.unsubscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", autoHandler);
        FluxDispatcher.unsubscribe("QUESTS_ENROLL_SUCCESS", autoHandler);
        autoHandler = undefined;
    },
});
