/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Cheap, always-on attribution of main-thread time to the plugin that spent it.
//
// The plugin manager and the message accessory/decoration renderers call `measure` around plugin
// code. Recording is one performance.now() pair and a Map update, so it stays on in normal use;
// PerfMonitor reads and resets the totals. Nothing here schedules work of its own.

export interface PluginCost {
    ms: number;
    calls: number;
    /** Most expensive single call in the window, and what it was. */
    worstMs: number;
    worstWhat: string;
}

const costs = new Map<string, PluginCost>();

function record(owner: string, what: string, ms: number) {
    let cost = costs.get(owner);
    if (!cost) costs.set(owner, cost = { ms: 0, calls: 0, worstMs: 0, worstWhat: "" });
    cost.ms += ms;
    cost.calls++;
    if (ms > cost.worstMs) {
        cost.worstMs = ms;
        cost.worstWhat = what;
    }
}

/** Run `fn`, charging its synchronous time to `owner`. Errors propagate unchanged. */
export function measure<T>(owner: string, what: string, fn: () => T): T {
    const start = performance.now();
    try {
        return fn();
    } finally {
        record(owner, what, performance.now() - start);
    }
}

/** Totals since the last call, most expensive first; the window is reset. */
export function takePluginCosts(): [string, PluginCost][] {
    const entries = [...costs].sort((a, b) => b[1].ms - a[1].ms);
    costs.clear();
    return entries;
}

/**
 * Renders `render(props)` as part of this component and charges the factory's time to `owner`.
 * Components the factory returns render later as children and are not included; per-frame
 * attribution of that work comes from the Long Animation Frames scripts in PerfMonitor.
 */
export function TimedRender<P>({ owner, what, render, props }: { owner: string; what: string; render: (props: P) => any; props: P; }) {
    return measure(owner, what, () => render(props));
}
