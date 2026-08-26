import assert from "node:assert/strict";
import test from "node:test";

import { installDiscordKnownNoiseFilter } from "../core/src/discordNoise.ts";

test("Discord noise filter suppresses only the known BaseGlow diagnostic", () => {
    const errors: unknown[][] = [];
    const consoleLike = { error: (...args: unknown[]) => errors.push(args) };
    installDiscordKnownNoiseFilter(consoleLike);

    consoleLike.error("Could not find a View Model linked to Artboard BaseGlowRemapped.");
    consoleLike.error("a real error");

    assert.deepEqual(errors, [["a real error"]]);
});

test("Discord noise filter forwards structured errors", () => {
    const errors: unknown[][] = [];
    const consoleLike = { error: (...args: unknown[]) => errors.push(args) };
    installDiscordKnownNoiseFilter(consoleLike);

    const error = new Error("Could not find a View Model linked to Artboard BaseGlowRemapped.");
    consoleLike.error(error);

    assert.deepEqual(errors, [[error]]);
});
