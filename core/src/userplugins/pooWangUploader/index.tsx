/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Switch } from "@components/Switch";
import { copyWithToast, insertTextIntoChatInputBox } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { closeModal, Forms, Modal, openModal, SelectedChannelStore, showToast, TextInput, Toasts, UploadHandler, useEffect, useState } from "@webpack/common";
import type * as NativeModule from "./native";
import { formatUploadLinks, type PooWangUploadResult, randomizeUploadName, secureRandomIndex, selectUploadRoute } from "./shared";

const Native = VencordNative.pluginHelpers.PooWangUploader as PluginNative<typeof NativeModule>;
const logger = new Logger("PooWangUploader");
let tokenConfigured = false;

interface UploadChannel {
    id: string;
}

interface UploadOptions {
    isThumbnail?: boolean;
    requireConfirm?: boolean;
}

function AccessTokenSetting() {
    const [token, setToken] = useState("");
    const [configured, setConfigured] = useState<boolean | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!IS_DISCORD_DESKTOP) {
            setConfigured(false);
            return;
        }
        let active = true;
        void Native.hasAccessToken().then(value => {
            tokenConfigured = value;
            if (active) setConfigured(value);
        }).catch(error => {
            logger.error("Could not read poo.wang token state", error);
            if (active) setConfigured(false);
        });
        return () => { active = false; };
    }, []);

    async function saveToken() {
        setSaving(true);
        const result = await Native.setAccessToken(token).catch(error => ({ ok: false, error: String(error) }));
        setSaving(false);
        if (!result.ok) {
            showToast(result.error ?? "Could not store the poo.wang token.", Toasts.Type.FAILURE);
            return;
        }
        setToken("");
        tokenConfigured = Boolean(token.trim());
        setConfigured(tokenConfigured);
        showToast(tokenConfigured ? "poo.wang token stored securely." : "poo.wang token removed.", Toasts.Type.SUCCESS);
    }

    async function clearToken() {
        setToken("");
        setSaving(true);
        const result = await Native.setAccessToken("").catch(error => ({ ok: false, error: String(error) }));
        setSaving(false);
        if (!result.ok) {
            showToast(result.error ?? "Could not remove the poo.wang token.", Toasts.Type.FAILURE);
            return;
        }
        tokenConfigured = false;
        setConfigured(false);
        showToast("poo.wang token removed.", Toasts.Type.SUCCESS);
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Forms.FormText>
                Registered accounts only: create a machine access token on poo.wang. It is encrypted with Electron safeStorage and is never written to Vencord settings or Settings Sync.
            </Forms.FormText>
            <Forms.FormText>Token status: {configured === null ? "checking…" : configured ? "configured" : "not configured"}</Forms.FormText>
            <TextInput
                type="password"
                placeholder="Paste a poo.wang machine token"
                value={token}
                onChange={setToken}
                disabled={saving}
            />
            <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={saveToken} disabled={saving || !token.trim()}>Save token</Button>
                <Button variant="dangerPrimary" onClick={clearToken} disabled={saving || !configured}>Remove token</Button>
            </div>
        </div>
    );
}

function UploadRouteModal(props: {
    rootProps: RenderModalProps;
    files: readonly File[];
    defaultReroute: boolean;
    resolve(value: boolean | undefined): void;
}) {
    const [reroute, setReroute] = useState(props.defaultReroute);
    const totalMb = props.files.reduce((total, file) => total + file.size, 0) / 1024 / 1024;
    const close = (value: boolean | undefined) => {
        props.resolve(value);
        props.rootProps.onClose();
    };

    return (
        <Modal {...props.rootProps} onClose={() => close(undefined)} title="Choose upload destination">
            <Forms.FormText>
                {props.files.length} file(s), {totalMb.toFixed(1)} MB total. Existing message text is preserved.
            </Forms.FormText>
            <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 16 }}>
                <div>
                    <Forms.FormTitle>Reroute upload through poo.wang</Forms.FormTitle>
                    <Forms.FormText>Replace Discord attachments with retention-controlled poo.wang links.</Forms.FormText>
                </div>
                <Switch checked={reroute} onChange={setReroute} />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
                <Button onClick={() => close(undefined)}>Cancel</Button>
                <Button onClick={() => close(reroute)}>{reroute ? "Upload to poo.wang" : "Use Discord upload"}</Button>
            </div>
        </Modal>
    );
}

function askUploadRoute(files: readonly File[], defaultReroute: boolean): Promise<boolean | undefined> {
    const { promise, resolve } = Promise.withResolvers<boolean | undefined>();
    let settled = false;
    const settle = (value: boolean | undefined) => {
        if (settled) return;
        settled = true;
        resolve(value);
    };
    openModal(rootProps => (
        <UploadRouteModal rootProps={rootProps} files={files} defaultReroute={defaultReroute} resolve={settle} />
    ));
    return promise;
}
interface VisibleUploadProgress {
    fileName: string;
    fileIndex: number;
    fileCount: number;
    percent: number;
}

function UploadProgressModal(props: {
    rootProps: RenderModalProps;
    initial: VisibleUploadProgress;
    subscribe(listener: (progress: VisibleUploadProgress) => void): () => void;
}) {
    const [progress, setProgress] = useState(props.initial);
    useEffect(() => props.subscribe(setProgress), [props.subscribe]);

    return (
        <Modal {...props.rootProps} title="Uploading to poo.wang">
            <Forms.FormTitle>{progress.fileName}</Forms.FormTitle>
            <Forms.FormText>
                File {progress.fileIndex + 1} of {progress.fileCount} — {progress.percent}%
            </Forms.FormText>
            <div style={{ height: 8, marginTop: 12, overflow: "hidden", borderRadius: 4, background: "var(--background-modifier-accent)" }}>
                <div style={{ height: "100%", width: `${progress.percent}%`, background: "var(--brand-500)", transition: "width 150ms linear" }} />
            </div>
        </Modal>
    );
}

async function withUploadProgress(
    files: readonly File[],
    task: (report: (progress: VisibleUploadProgress) => void) => Promise<void>
) {
    let current: VisibleUploadProgress = {
        fileName: files[0]?.name ?? "Preparing upload",
        fileIndex: 0,
        fileCount: files.length,
        percent: 0
    };
    const listeners = new Set<(progress: VisibleUploadProgress) => void>();
    const subscribe = (listener: (progress: VisibleUploadProgress) => void) => {
        listeners.add(listener);
        listener(current);
        return () => listeners.delete(listener);
    };
    const modalKey = openModal(rootProps => (
        <UploadProgressModal rootProps={rootProps} initial={current} subscribe={subscribe} />
    ));
    try {
        await task(progress => {
            current = progress;
            listeners.forEach(listener => listener(progress));
        });
    } finally {
        closeModal(modalKey);
    }
}

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Enable poo.wang upload routing for normal chat attachments",
        default: true
    },
    showChoice: {
        type: OptionType.BOOLEAN,
        description: "Show a per-upload checkbox to choose between Discord and poo.wang",
        default: true
    },
    rerouteByDefault: {
        type: OptionType.BOOLEAN,
        description: "Check the poo.wang reroute option by default; when the choice dialog is disabled, always use poo.wang",
        default: false
    },
    autoRerouteLargeFiles: {
        type: OptionType.BOOLEAN,
        description: "Automatically use poo.wang before Discord rejects a file at or above the configured size",
        default: true
    },
    largeFileThresholdMb: {
        type: OptionType.NUMBER,
        description: "Automatically reroute files at or above this size in MB",
        default: 25,
        isValid: value => Number.isFinite(value) && value >= 1 && value <= 90 || "Enter a value from 1 to 90 MB (the current poo.wang API maximum).",
        disabled() { return !this.store.autoRerouteLargeFiles; }
    },
    burnMode: {
        type: OptionType.SELECT,
        description: "Retention requested for new uploads. Availability depends on your poo.wang plan.",
        options: [
            { label: "Burn after first read", value: "Burn after first read" },
            { label: "Burn after 1 hour", value: "Burn after 1 hour" },
            { label: "Burn after 24 hours", value: "Burn after 24 hours" },
            { label: "Burn after 7 days", value: "Burn after 7 days", default: true },
            { label: "Burn after 30 days", value: "Burn after 30 days" },
            { label: "Keep permanently (Internal videos only)", value: "Keep permanently" }
        ]
    },
    randomizeFileNames: {
        type: OptionType.BOOLEAN,
        description: "Replace uploaded filenames with random ASCII names while preserving their extension",
        default: false
    },
    randomNameLength: {
        type: OptionType.NUMBER,
        description: "Number of random characters before the extension",
        default: 12,
        isValid: value => Number.isInteger(value) && value >= 3 && value <= 64 || "Enter an integer from 3 to 64.",
        disabled() { return !this.store.randomizeFileNames; }
    },
    randomNameCharacters: {
        type: OptionType.STRING,
        description: "Printable ASCII characters allowed in random filenames. Unsafe path characters are ignored.",
        default: "abcdefghijklmnopqrstuvwxyz0123456789",
        isValid: value => [...new Set(value)].some(character =>
            /^[\x20-\x7E]$/.test(character) && !/[\/\\:"*?<>|]/.test(character)
        ) || "Include at least one safe printable ASCII character.",
        disabled() { return !this.store.randomizeFileNames; }
    },
    accessToken: {
        type: OptionType.COMPONENT,
        component: AccessTokenSetting,
        target: "DESKTOP"
    }
});

export default definePlugin({
    name: "PooWangUploader",
    description: "Reroutes selected or oversized Discord chat attachments through poo.wang",
    authors: [{ name: "Alex", id: 0n }],
    tags: ["Privacy", "Utility"],
    settings,

    patches: [{
        find: "Unexpected mismatch between files and file metadata",
        replacement: {
            match: /async function (\i)\((\i),(\i),(\i)\)\{(?=let\{filesMetadata:)/,
            replace: "$&if($self.interceptUploads($2,$3,$4,arguments[3]))return;"
        }
    }],

    bypassNextUpload: false,

    start() {
        if (!IS_DISCORD_DESKTOP) return;
        void Native.hasAccessToken()
            .then(value => { tokenConfigured = value; })
            .catch(error => logger.error("Could not read poo.wang token state", error));
    },

    stop() {
        tokenConfigured = false;
    },

    interceptUploads(
        rawFiles: ArrayLike<File>,
        channel: UploadChannel,
        draftType: number,
        options?: UploadOptions
    ): boolean {
        if (this.bypassNextUpload) {
            this.bypassNextUpload = false;
            return false;
        }

        const files = Array.from(rawFiles);
        if (files.some(file => !(file instanceof File))) return false;
        const route = selectUploadRoute({
            enabled: settings.store.enabled,
            tokenConfigured,
            isThumbnail: options?.isThumbnail === true,
            fileSizes: files.map(file => file.size),
            showChoice: settings.store.showChoice,
            rerouteByDefault: settings.store.rerouteByDefault,
            autoRerouteLargeFiles: settings.store.autoRerouteLargeFiles,
            largeFileThresholdBytes: settings.store.largeFileThresholdMb * 1024 * 1024
        });
        if (route === "discord") return false;

        void this.routeUpload(route, files, channel, draftType, options);
        return true;
    },

    restoreDiscordUpload(
        files: File[],
        channel: UploadChannel,
        draftType: number,
        options?: UploadOptions,
        forceConfirmation = false
    ) {
        if (!files.length) return;
        this.bypassNextUpload = true;
        try {
            UploadHandler.promptToUpload(files, channel, draftType, forceConfirmation
                ? { ...options, requireConfirm: true }
                : options);
        } catch (error) {
            this.bypassNextUpload = false;
            logger.error("Could not restore Discord upload", error);
            showToast("The attachment could not be restored to the Discord composer.", Toasts.Type.FAILURE);
        }
    },

    async routeUpload(
        route: "prompt" | "poo-wang",
        files: File[],
        channel: UploadChannel,
        draftType: number,
        options?: UploadOptions
    ) {
        if (route === "prompt") {
            const reroute = await askUploadRoute(files, settings.store.rerouteByDefault);
            if (reroute === undefined) return;
            if (!reroute) {
                this.restoreDiscordUpload(files, channel, draftType, options);
                return;
            }
        }
        await this.uploadExternally(files, channel, draftType, options);
    },

    async uploadExternally(files: File[], channel: UploadChannel, draftType: number, options?: UploadOptions) {
        const urls: string[] = [];
        let failure: PooWangUploadResult | undefined;
        let failedIndex = files.length;

        await withUploadProgress(files, async report => {
            for (const [index, file] of files.entries()) {
                let uploadName = file.name;
                let result: PooWangUploadResult;
                const uploadId = crypto.randomUUID();
                let progressTimer: number | undefined;
                let pollingProgress = true;
                try {
                    if (settings.store.randomizeFileNames) {
                        uploadName = randomizeUploadName(
                            file.name,
                            settings.store.randomNameLength,
                            settings.store.randomNameCharacters,
                            secureRandomIndex
                        );
                    }
                    report({ fileName: uploadName, fileIndex: index, fileCount: files.length, percent: 0 });
                    progressTimer = window.setInterval(() => {
                        void Native.getUploadProgress(uploadId).then(progress => {
                            if (!pollingProgress || !progress || progress.total <= 0) return;
                            report({
                                fileName: uploadName,
                                fileIndex: index,
                                fileCount: files.length,
                                percent: Math.min(99, Math.floor(progress.uploaded / progress.total * 100))
                            });
                        });
                    }, 150);
                    result = await Native.uploadFile({
                        uploadId,
                        name: uploadName,
                        type: file.type,
                        data: new Uint8Array(await file.arrayBuffer()),
                        burnMode: settings.store.burnMode
                    });
                    report({ fileName: uploadName, fileIndex: index, fileCount: files.length, percent: 100 });
                } catch (error) {
                    result = { ok: false, status: 0, error: String(error) };
                } finally {
                    pollingProgress = false;
                    clearInterval(progressTimer);
                }
                if (!result.ok || !result.file) {
                    failure = result;
                    failedIndex = index;
                    break;
                }
                urls.push(result.file.url);
            }
        });

        const links = formatUploadLinks(urls);
        if (links) {
            if (SelectedChannelStore.getChannelId() === channel.id) {
                insertTextIntoChatInputBox(`\n${links}\n`);
            } else {
                await copyWithToast(links, "poo.wang links copied; the upload channel changed.");
            }
        }

        if (failure) {
            logger.warn("poo.wang upload failed", failure.status, failure.error);
            showToast(`Uploaded ${urls.length}/${files.length}. ${failure.error ?? "A file failed."}`, Toasts.Type.FAILURE);
            this.restoreDiscordUpload(files.slice(failedIndex), channel, draftType, options, true);
            return;
        }
        showToast(`Uploaded ${urls.length} file(s) to poo.wang.`, Toasts.Type.SUCCESS);
    }
});
