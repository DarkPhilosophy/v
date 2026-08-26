import assert from "node:assert/strict";
import test from "node:test";

import { installDiscordKnownNoiseFilter } from "../core/src/discordNoise.ts";

test("Discord noise filter suppresses only the known BaseGlow diagnostic", () => {
    const errors: unknown[][] = [];
    const consoleLike = { error: (...args: unknown[]) => errors.push(args), warn() { } };
    installDiscordKnownNoiseFilter(consoleLike);

    consoleLike.error("Could not find a View Model linked to Artboard BaseGlowRemapped.");
    consoleLike.error("a real error");

    assert.deepEqual(errors, [["a real error"]]);
});

test("Discord noise filter suppresses only known warning strings", () => {
    const warnings: unknown[][] = [];
    const structuredWarning = new Error("[CloudSyncUtils] CloudSync is not supported on this platform");
    const consoleLike = {
        error() { },
        warn: (...args: unknown[]) => warnings.push(args)
    };
    installDiscordKnownNoiseFilter(consoleLike);

    consoleLike.warn("[CloudSyncUtils] CloudSync is not supported on this platform");
    consoleLike.warn("Requested message E+Q26x does not have a value in the requested locale ro nor the default locale en-US");
    consoleLike.warn("[scriptCost] retained URL count exceeded maxUrls (1000); evicting lowest-cost entries.");
    consoleLike.warn("a real warning");
    consoleLike.warn(structuredWarning);

    assert.deepEqual(warnings, [
        ["[CloudSyncUtils] CloudSync is not supported on this platform"],
        ["a real warning"],
        [structuredWarning]
    ]);
});

test("Discord noise filter forwards structured errors", () => {
    const errors: unknown[][] = [];
    const consoleLike = { error: (...args: unknown[]) => errors.push(args), warn() { } };
    installDiscordKnownNoiseFilter(consoleLike);

    const error = new Error("Could not find a View Model linked to Artboard BaseGlowRemapped.");
    consoleLike.error(error);

    assert.deepEqual(errors, [[error]]);
});
