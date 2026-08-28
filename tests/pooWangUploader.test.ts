import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatUploadLinks, getUploadError, isAttachmentPlusClassName, parseUploadFile, randomizeUploadName, selectUploadRoute } from "../core/src/userplugins/pooWangUploader/shared.ts";

test("poo.wang upload response maps a public file link", () => {
    assert.deepEqual(parseUploadFile({
        success: true,
        files: [{ id: "file-1", name: "photo.webp", url: "https://poo.wang/f/file-1" }]
    }), {
        id: "file-1",
        name: "photo.webp",
        url: "https://poo.wang/f/file-1"
    });
});

test("poo.wang upload response rejects malformed and off-origin links", () => {
    assert.equal(parseUploadFile({ files: [] }), undefined);
    assert.equal(parseUploadFile({ files: [{ id: "1", name: "x", url: "https://example.com/f/1" }] }), undefined);
    assert.equal(parseUploadFile({ files: [{ id: "1", name: "x", url: "https://poo.wang/s/1" }] }), undefined);
});

test("poo.wang API errors remain visible", () => {
    assert.equal(getUploadError({ error: "Daily upload limit reached." }, "fallback"), "Daily upload limit reached.");
    assert.equal(getUploadError({}, "fallback"), "fallback");
});

test("multiple poo.wang links are inserted on separate lines", () => {
    assert.equal(formatUploadLinks(["https://poo.wang/f/a", "https://poo.wang/f/b"]), "https://poo.wang/f/a\nhttps://poo.wang/f/b");
});

test("default routing is silent while opt-in routing prompts", () => {
    const base = {
        enabled: true,
        tokenConfigured: true,
        isThumbnail: false,
        rerouteByDefault: false,
        autoRerouteLargeFiles: true,
        largeFileThresholdBytes: 25 * 1024 * 1024
    };
    assert.equal(selectUploadRoute({ ...base, fileSizes: [2 * 1024 * 1024] }), "prompt");
    assert.equal(selectUploadRoute({ ...base, fileSizes: [2 * 1024 * 1024], rerouteByDefault: true }), "poo-wang");
    assert.equal(selectUploadRoute({ ...base, fileSizes: [25 * 1024 * 1024] }), "poo-wang");
    assert.equal(selectUploadRoute({ ...base, fileSizes: [30 * 1024 * 1024], tokenConfigured: false }), "prompt");
    assert.equal(selectUploadRoute({ ...base, fileSizes: [30 * 1024 * 1024], isThumbnail: true }), "discord");
});

test("disabled choice follows the configured default route", () => {
    const base = {
        enabled: true,
        tokenConfigured: true,
        isThumbnail: false,
        fileSizes: [1024],
        autoRerouteLargeFiles: false,
        largeFileThresholdBytes: 25 * 1024 * 1024
    };
    assert.equal(selectUploadRoute({ ...base, rerouteByDefault: true }), "poo-wang");
    assert.equal(selectUploadRoute({ ...base, rerouteByDefault: false }), "prompt");
});

test("random upload names use configured printable ASCII and preserve extensions", () => {
    const indices = [0, 1, 2, 3];
    let next = 0;
    assert.equal(randomizeUploadName("archive.tar.gz", 4, "ab_!c/💥", () => indices[next++]), "ab_!.tar.gz");
    assert.equal(randomizeUploadName("photo.png", 3, "x", () => 0), "xxx.png");
    assert.throws(() => randomizeUploadName("file.txt", 8, "💥/\\:*?", () => 0), /printable ASCII/);
});
test("attachment menu detection accepts current Discord plus classes", () => {
    assert.equal(isAttachmentPlusClassName("attachButtonPlus__0923f"), true);
    assert.equal(isAttachmentPlusClassName("attachButton__0923f"), true);
    assert.equal(isAttachmentPlusClassName("emojiButton__0923f"), false);
});



test("plugin keeps native draft previews and reroutes only when sending", () => {
    const source = readFileSync(new URL("../core/src/userplugins/pooWangUploader/index.tsx", import.meta.url), "utf8");
    assert.match(source, /import type \{ MessageObject \} from "@api\/MessageEvents"/);
    assert.doesNotMatch(source, /patches:\s*\[/);
    assert.doesNotMatch(source, /chatBarButton:/);
    assert.doesNotMatch(source, /document\.addEventListener\("(?:click|change|drop|paste)"/);
    assert.match(source, /document\.addEventListener\("contextmenu"/);
    assert.match(source, /async onBeforeMessageSend/);
    assert.match(source, /getUploads\(channelId, DraftType\.ChannelMessage\)/);
    assert.match(source, /upload\.removeFromMsgDraft\(\)/);
    assert.match(source, /message\.content = \[message\.content\.trim\(\), links\]/);
    assert.match(source, /addGlobalContextMenuPatch\(attachmentMenuPatch\)/);
    assert.match(source, /poo-wang-settings/);
    assert.match(source, /poo-wang-default/);
    assert.match(source, /poo-wang-large-files/);
    assert.match(source, /injectQuickSettingsIntoAttachmentMenu/);
    assert.match(source, /data-vc-poo-wang-settings/);
    assert.match(source, /poo\.wang quick settings/);
    assert.match(source, />Cancel</);
    assert.match(source, />Upload with Discord</);
    assert.match(source, />Upload with poo\.wang</);
});

test("Linux token storage falls back to Secret Service without plaintext files", () => {
    const source = readFileSync(new URL("../core/src/userplugins/pooWangUploader/native.ts", import.meta.url), "utf8");
    assert.match(source, /safeStorage\.isEncryptionAvailable\(\)/);
    assert.doesNotMatch(source, /dialog\.showOpenDialog/);
    assert.match(source, /existsSync\("\/.flatpak-info"\)/);
    assert.match(source, /"flatpak-spawn"/);
    assert.match(source, /"--host", "secret-tool"/);
    assert.match(source, /from "node:https"/);
    assert.match(source, /\["store", "--label=poo\.wang Vencord uploader"/);
    assert.match(source, /\["lookup", \.\.\.SECRET_SERVICE_ATTRIBUTES\]/);
});
