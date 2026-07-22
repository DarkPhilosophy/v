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
    config: {
        expiresAt: string;
        application: { id: string; name: string; };
        messages: { questName: string; };
        taskConfig?: { tasks: Record<string, QuestTask>; };
        taskConfigV2?: { tasks: Record<string, QuestTask>; };
    };
    userStatus?: {
        enrolledAt?: string;
        completedAt?: string;
        progress?: Record<string, { value: number; }>;
        streamProgressSeconds?: number;
    } | null;
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
        description: "Complete PLAY_ON_DESKTOP / STREAM_ON_DESKTOP quests (runs in real time via heartbeat spoof)",
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

async function completeQuest(quest: Quest): Promise<void> {
    const tasks = quest.config.taskConfigV2?.tasks ?? quest.config.taskConfig?.tasks ?? {};
    const taskName = TASK_ORDER.find(t => tasks[t] != null);
    const appName = quest.config.application.name;

    if (!taskName) {
        logger.warn("Unknown task type for quest", appName, Object.keys(tasks));
        return;
    }

    const secondsNeeded = tasks[taskName].target;
    const appId = quest.config.application.id;
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
            const next = Math.min(secondsNeeded, done + Math.floor(Math.random() * 7) + 1, maxByElapsed);
            if (next <= done) {
                await sleep(1000);
                continue;
            }
            await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: next } });
            done = next;
            logger.info(`${appName} video ${done}/${secondsNeeded}s`);
            await sleep(1000);
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
        const { body } = await RestAPI.get({ url: `/applications/public?application_ids=${appId}` });
        const appData = (body as PublicApplication[])[0];
        const exe = (appData.executables?.find(x => x.os === "win32")?.name ?? `${appName}.exe`).replace(/^>/, "");
        const pid = Math.floor(Math.random() * 30000) + 1000;
        const fakeGame: RunningGame = {
            cmdLine: `C:\\Program Files\\${appData.name}\\${exe}`,
            exeName: exe,
            exePath: `c:/program files/${appData.name.toLowerCase()}/${exe}`,
            hidden: false,
            isLauncher: false,
            id: appId,
            name: appData.name,
            pid,
            pidPath: [pid],
            processName: appData.name,
            start: Date.now(),
        };

        const realGames = store.getRunningGames();
        const realGetRunning = store.getRunningGames;
        const realGetForPID = store.getGameForPID;
        const fake = [fakeGame];
        store.getRunningGames = () => fake;
        store.getGameForPID = (p: number) => fake.find(x => x.pid === p);
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: fake });
        logger.info(`${appName}: spoofed running game pid=${pid}, awaiting heartbeats`);

        toast(`${appName}: waiting for heartbeats (~${Math.ceil(secondsNeeded / 60)} min). Keep Discord open.`);

        const { promise, resolve } = Promise.withResolvers<void>();
        const onBeat = (data: HeartbeatEvent) => {
            if (data.questId !== quest.id) return;
            const value = Math.floor(data.userStatus?.progress?.[taskName]?.value ?? data.userStatus?.streamProgressSeconds ?? 0);
            logger.info(`${appName} play ${value}/${secondsNeeded}s`);
            if (value < secondsNeeded) return;
            store.getRunningGames = realGetRunning;
            store.getGameForPID = realGetForPID;
            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onBeat);
            logger.info(`${appName}: play complete (${secondsNeeded}s)`);
            toast(`${appName}: play quest complete`, Toasts.Type.SUCCESS);
            resolve();
        };
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onBeat);
        await promise;
        return;
    }

    logger.warn(`${appName}: task ${taskName} not automatable`);
    toast(`${appName}: task ${taskName} not automatable (e.g. real stream)`, Toasts.Type.FAILURE);
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
                if (!silent) toast(`${quest.config.application.name}: enrolled`);
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
    description: "Complete Discord Quests without the game installed (video + play/stream via heartbeat spoof).",
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
