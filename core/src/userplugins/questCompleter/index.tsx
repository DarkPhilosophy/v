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
import { createDeferredHandler, type DeferredHandler } from "./deferredHandler";
import { createHeartbeatWait, getCompletionBatch, getEnrollmentBatch, getNextAutomationDelayMs, getRateLimitDelayMs, runConcurrentQuestBatch } from "./resilience";
import { isAutomatableQuest } from "./taskSupport";


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


const TASK_ORDER = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "PLAY_ON_PLAYSTATION", "PLAY_ON_XBOX", "ACHIEVEMENT_IN_ACTIVITY"] as const;

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

function isVideoQuest(quest: Quest): boolean {
    const tasks = quest.config.taskConfigV2?.tasks ?? quest.config.taskConfig?.tasks ?? {};
    return TASK_ORDER.find(taskName => tasks[taskName] != null)?.startsWith("WATCH_VIDEO") ?? false;
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

        const runningGameStore = store;
        const existingGames = runningGameStore.getRunningGames();
        const getRunningSnapshot = runningGameStore.getRunningGames.bind(runningGameStore);
        const getForPIDSnapshot = runningGameStore.getGameForPID.bind(runningGameStore);
        const entries = [gameEntry];
        runningGameStore.getRunningGames = () => entries;
        runningGameStore.getGameForPID = (p: number) => entries.find(x => x.pid === p);
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: existingGames, added: [gameEntry], games: entries });
        logger.info(`${appName}: running game pid=${pid}, awaiting heartbeats`);

        toast(`${appName}: waiting for heartbeats (~${Math.ceil(secondsNeeded / 60)} min). Keep Discord open.`);

        // Restore the snapshot when completion succeeds, the heartbeat fails, the
        // Gateway closes, or the watchdog expires.
        function cleanup(): void {
            runningGameStore.getRunningGames = getRunningSnapshot;
            runningGameStore.getGameForPID = getForPIDSnapshot;
            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [gameEntry], added: [], games: [] });
        }
        const heartbeat = createHeartbeatWait(
            FluxDispatcher,
            quest.id,
            taskName,
            secondsNeeded,
            cleanup
        );
        const watchdog = setTimeout(() => {
            logger.warn(`${appName}: heartbeat timeout (${secondsNeeded + 300}s), giving up`);
            toast(`${appName}: heartbeat timeout. Try again later.`, Toasts.Type.FAILURE);
            heartbeat.cancel(new Error("heartbeat timeout"));
        }, (secondsNeeded + 300) * 1000);
        try {
            await heartbeat.promise;
            logger.info(`${appName}: play complete (${secondsNeeded}s)`);
            toast(`${appName}: play quest complete`, Toasts.Type.SUCCESS);
        } finally {
            clearTimeout(watchdog);
        }
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
let autoEnrollBlockedUntil = 0;
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
    const notEnrolled = all.filter(q => {
        const tasks = q.config.taskConfigV2?.tasks ?? q.config.taskConfig?.tasks ?? {};
        return isAutomatableQuest(tasks) && !q.userStatus?.completedAt && !q.userStatus?.enrolledAt && new Date(q.config.expiresAt) >= now;
    });
    const todo = all.filter(q => {
        const tasks = q.config.taskConfigV2?.tasks ?? q.config.taskConfig?.tasks ?? {};
        return isAutomatableQuest(tasks) && !!q.userStatus?.enrolledAt && !q.userStatus?.completedAt && new Date(q.config.expiresAt) >= now;
    });
    logger.info(`Scan: ${todo.length} enrolled to complete, ${notEnrolled.length} not enrolled`);

    if (settings.store.autoEnroll) {
        if (Date.now() < autoEnrollBlockedUntil) {
            logger.info(`Auto-enroll paused for ${Math.ceil((autoEnrollBlockedUntil - Date.now()) / 1000)}s after rate limit`);
        } else {
            const enrollmentBatch = getEnrollmentBatch(notEnrolled);
            for (const [index, quest] of enrollmentBatch.entries()) {
                try {
                    const res = await RestAPI.post({ url: `/quests/${quest.id}/enroll`, body: { location: 8 } });
                    const enrolled = res.body as { userStatus?: Quest["userStatus"]; } | undefined;
                    if (!enrolled?.userStatus?.enrolledAt) {
                        logger.warn(`Enroll response missing valid userStatus for ${quest.config.messages.questName}; skipping until next scan`);
                        continue;
                    }
                    todo.push({ ...quest, userStatus: { ...enrolled.userStatus } });
                    logger.info(`Enrolled: ${quest.config.messages.questName}`);
                    if (!silent) toast(`${getAppName(quest)}: enrolled`);
                } catch (err) {
                    const retryDelayMs = getRateLimitDelayMs(err);
                    logger.error("Enroll failed", quest.config.messages.questName, err);
                    if (!silent) toast(`Enroll failed: ${quest.config.messages.questName}`, Toasts.Type.FAILURE);
                    if (retryDelayMs !== undefined) {
                        autoEnrollBlockedUntil = Date.now() + retryDelayMs;
                        logger.warn(`Auto-enroll rate limited; pausing for ${Math.ceil(retryDelayMs / 1000)}s`);
                        break;
                    }
                }
                if (index + 1 < enrollmentBatch.length) {
                    const { promise, resolve } = Promise.withResolvers<void>();
                    setTimeout(resolve, 750);
                    await promise;
                }
            }
        }
    } else if (notEnrolled.length && !silent) {
        toast(`${notEnrolled.length} quest(s) not enrolled. Enable "autoEnroll" or accept them manually.`);
    }

    if (!todo.length) {
        if (!silent) toast("No enrolled quests to complete.");
        return;
    }

    const completionBatch = silent ? getCompletionBatch(todo, isVideoQuest) : todo;
    const hasDeferredQuests = completionBatch.length < todo.length;
    running = true;
    if (!silent) toast(`Completing ${completionBatch.length} quest(s)...`);
    logger.info(`Starting completion of ${completionBatch.length}/${todo.length} quest(s): ${completionBatch.map(q => q.config.messages.questName).join(", ")}`);
    let successfulQuests = 0;
    try {
        await runConcurrentQuestBatch(
            completionBatch,
            isVideoQuest,
            async quest => {
                try {
                    await completeQuest(quest);
                    successfulQuests++;
                } catch (err) {
                    logger.error("Failed for quest", quest.config.messages.questName, err);
                    if (!silent) toast(`Error: ${quest.config.messages.questName}`, Toasts.Type.FAILURE);
                }
            },
            3
        );
        logger.info("Quest batch processed");
        if (!silent) toast("Done. Check Gift Inventory.", Toasts.Type.SUCCESS);
    } finally {
        running = false;
        if (silent && hasDeferredQuests && autoHandler) {
            autoContinuationDelayMs = getNextAutomationDelayMs(successfulQuests, autoContinuationDelayMs);
            clearTimeout(autoContinuationTimer);
            autoContinuationTimer = setTimeout(autoHandler, autoContinuationDelayMs);
        }
    }
}

// Stored so start/stop can subscribe/unsubscribe the same reference.
let autoHandler: DeferredHandler | undefined;
let autoContinuationTimer: ReturnType<typeof setTimeout> | undefined;
let autoContinuationDelayMs = 5_000;

export default definePlugin({
    name: "QuestCompleter",
    description: "Complete Discord Quests on Linux (where Quests lack full native support).",
    authors: [{ name: "Alex", id: 0n }],
    settings,

    start() {
        autoContinuationDelayMs = 5_000;
        if (!settings.store.autoComplete) return;
        autoHandler = createDeferredHandler(
            () => completeAll(true),
            error => logger.error("Automatic completion failed", error),
        );
        FluxDispatcher.subscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", autoHandler);
        FluxDispatcher.subscribe("QUESTS_ENROLL_SUCCESS", autoHandler);
    },

    stop() {
        clearTimeout(autoContinuationTimer);
        autoContinuationTimer = undefined;
        autoContinuationDelayMs = 5_000;
        if (!autoHandler) return;
        FluxDispatcher.unsubscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", autoHandler);
        FluxDispatcher.unsubscribe("QUESTS_ENROLL_SUCCESS", autoHandler);
        autoHandler.cancel();
        autoHandler = undefined;
    },
});
