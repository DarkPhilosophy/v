import assert from "node:assert/strict";
import test from "node:test";

import { parseSteamAppIds } from "../core/src/userplugins/steamRichPresence/native.ts";

test("Steam process scan keeps unique game app IDs", () => {
    assert.deepEqual(
        parseSteamAppIds("0\n7\n730\n730\nnot-an-id\n1245620\n"),
        ["730", "1245620"]
    );
});
