import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseSteamAppIds } from "../core/src/userplugins/steamRichPresence/parse.ts";

test("Steam process scan keeps unique game app IDs", () => {
    assert.deepEqual(
        parseSteamAppIds("0\n7\n730\n730\nnot-an-id\n1245620\n"),
        ["730", "1245620"]
    );
});

test("Steam process scan reports games but ignores Wine/Proton services that outlive them", { skip: process.platform !== "linux" }, async () => {
    const source = readFileSync(new URL("../core/src/userplugins/steamRichPresence/native.ts", import.meta.url), "utf8");
    const script = /const FIND_STEAM_APPS = String\.raw`([\s\S]*?)`;/.exec(source)?.[1];
    assert.ok(script, "scan script must be found");

    // Every process carries a SteamAppId; only argv[0] differs, exactly as for Wine's services.
    const env = (id: string) => ({ ...process.env, SteamAppId: id });
    const as = (argv0: string, id: string) => spawn("sh", ["-c", `exec -a '${argv0}' sleep 30`], { env: env(id), stdio: "ignore" });
    const children: ChildProcess[] = [
        spawn("sleep", ["30"], { env: env("424242"), stdio: "ignore" }),
        as("C:\\windows\\system32\\services.exe", "535353"),
        as("Z:\\games\\Proton Reaper\\ReaperGame.exe", "646464"),
        as("C:\\windows\\system32\\svchost.exe", "757575"),
        as("/usr/bin/wineserver", "868686"),
    ];
    try {
        await Promise.all(children.map(child => once(child, "spawn")));
        const ids = parseSteamAppIds(spawnSync("sh", ["-c", script], { encoding: "utf8" }).stdout);
        assert.ok(ids.includes("424242"), "a native game process must be reported");
        assert.ok(ids.includes("646464"), "a game must not be skipped because its path contains a filtered word");
        for (const leftover of ["535353", "757575", "868686"])
            assert.ok(!ids.includes(leftover), `Wine/Proton infrastructure (${leftover}) must not be reported`);
    } finally {
        for (const child of children) child.kill();
    }
});
