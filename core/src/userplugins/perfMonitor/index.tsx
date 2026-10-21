/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { type PluginCost, takePluginCosts } from "@api/PerfAttribution";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";

const logger = new Logger("PerfMonitor");

const settings = definePluginSettings({
    slowFrameMs: {
        type: OptionType.SLIDER,
        description: "A frame slower than this counts as a stall (ms)",
        markers: [100, 150, 200, 300, 500],
        default: 200,
        stickToMarkers: true
    },
    stallsToWarn: {
        type: OptionType.SLIDER,
        description: "Warn after this many stalls within one minute",
        markers: [3, 5, 10, 20],
        default: 5,
        stickToMarkers: true
    },
    cooldownMinutes: {
        type: OptionType.SLIDER,
        description: "Minimum time between two warnings (minutes)",
        markers: [5, 10, 30, 60],
        default: 10,
        stickToMarkers: true
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a notification when Discord becomes slow (the console report is always written)",
        default: true
    }
});

// ── What the browser tells us about each slow frame ─────────────────────────────

/** Where a stalled frame's time went. `style` is style recalculation and layout (themes, CSS). */
interface Stall {
    at: number;
    duration: number;
    style: number;
    bySource: Record<string, number>;
}

// Subset of the Long Animation Frames API (Chromium 123+), not yet in the DOM typings.
interface LoafScript {
    duration: number;
    sourceURL: string;
    invoker: string;
}
interface LoafEntry extends PerformanceEntry {
    styleAndLayoutStart: number;
    scripts: LoafScript[];
}

/** Group a script by who owns it. Plugin-level detail comes from PerfAttribution. */
function sourceOf(script: LoafScript): string {
    const url = script.sourceURL;
    if (url.includes("installHook")) return "React DevTools";
    if (url.includes("renderer.js") || url.includes("VencordRenderer")) return "Vencord / plugins";
    if (url.startsWith("WebpackModule") || url.includes("/WebpackModule")) return "Discord code patched by plugins";
    if (!url) return "browser / extensions";
    return "Discord";
}

const WINDOW_MS = 60_000;
let stalls: Stall[] = [];
let observer: PerformanceObserver | undefined;
let reportTimer: number | undefined;
let lastWarning = 0;

function onFrames(list: PerformanceObserverEntryList) {
    const threshold = settings.store.slowFrameMs;
    for (const raw of list.getEntries()) {
        const entry = raw as LoafEntry;
        if (entry.duration < threshold) continue;
        const end = entry.startTime + entry.duration;
        const bySource: Record<string, number> = {};
        for (const script of entry.scripts) {
            const source = sourceOf(script);
            bySource[source] = (bySource[source] ?? 0) + script.duration;
        }
        stalls.push({
            at: Date.now(),
            duration: entry.duration,
            style: entry.styleAndLayoutStart ? end - entry.styleAndLayoutStart : 0,
            bySource
        });
    }
}

// ── Periodic report: correlate stalls with what plugins spent ────────────────────

function percent(part: number, whole: number) {
    return whole > 0 ? Math.round(100 * part / whole) : 0;
}

function describePlugin([name, cost]: [string, PluginCost]) {
    return `${name} ${Math.round(cost.ms)} ms (${cost.calls} calls, worst ${Math.round(cost.worstMs)} ms in ${cost.worstWhat})`;
}

function report() {
    const now = Date.now();
    stalls = stalls.filter(stall => now - stall.at < WINDOW_MS);
    const pluginCosts = takePluginCosts();
    if (stalls.length < settings.store.stallsToWarn) return;

    const total = stalls.reduce((sum, stall) => sum + stall.duration, 0);
    const style = stalls.reduce((sum, stall) => sum + stall.style, 0);
    const sources: Record<string, number> = {};
    for (const stall of stalls)
        for (const [source, ms] of Object.entries(stall.bySource)) sources[source] = (sources[source] ?? 0) + ms;
    const ranked = Object.entries(sources).sort((a, b) => b[1] - a[1]);
    const plugins = pluginCosts.filter(([, cost]) => cost.ms >= 20).slice(0, 5);

    const lines = [
        `${stalls.length} stalls (slowest ${Math.round(Math.max(...stalls.map(s => s.duration)))} ms) in the last minute.`,
        `CSS / layout: ${percent(style, total)}% of stalled time (themes, QuickCSS).`,
        ...ranked.slice(0, 3).map(([source, ms]) => `${source}: ${percent(ms, total)}%`),
        ...(plugins.length ? ["Plugin time:", ...plugins.map(describePlugin)] : [])
    ];
    logger.warn("Discord is slow\n" + lines.join("\n"));

    if (!settings.store.notify || now - lastWarning < settings.store.cooldownMinutes * 60_000) return;
    lastWarning = now;
    const culprit = style > total / 2
        ? "CSS (theme / QuickCSS)"
        : plugins[0]?.[0] ?? ranked[0]?.[0] ?? "unknown";
    showNotification({
        title: "Discord is running slowly",
        body: `${stalls.length} stalls in a minute. Main cause: ${culprit}. Details in the console (PerfMonitor).`,
        noPersist: false
    });
    stalls = [];
}

export default definePlugin({
    name: "PerfMonitor",
    description: "Watches for stalled frames and tells you what caused them: a plugin, Discord, React DevTools or CSS from themes.",
    authors: [{ name: "DarkPhilosophy", id: 0n }],
    settings,

    start() {
        if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
            logger.warn("Long Animation Frames API unavailable; PerfMonitor is idle.");
            return;
        }
        // The observer is passive: the browser hands us frames that already happened.
        observer = new PerformanceObserver(onFrames);
        observer.observe({ type: "long-animation-frame", buffered: false });
        reportTimer = window.setInterval(report, 15_000);
    },

    stop() {
        observer?.disconnect();
        observer = undefined;
        clearInterval(reportTimer);
        reportTimer = undefined;
        stalls = [];
        takePluginCosts();
    }
});
