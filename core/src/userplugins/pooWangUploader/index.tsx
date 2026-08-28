/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addGlobalContextMenuPatch, type GlobalContextMenuPatchCallback, removeGlobalContextMenuPatch } from "@api/ContextMenu";
import type { MessageObject, SendMessageOptions, SendMessageProps } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Switch } from "@components/Switch";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { CloudUpload, RenderModalProps } from "@vencord/discord-types";
import { DraftType } from "@vencord/discord-types/enums";
import { findByProps, findByPropsLazy } from "@webpack";
import { closeModal, ComponentDispatch, ContextMenuApi, FluxDispatcher, Forms, Menu, MessageActions, Modal, openModal, showToast, TextInput, Toasts, useEffect, useState } from "@webpack/common";
import { composeUploadMessage, formatUploadLinks, isAttachmentPlusClassName, type PooWangUploadFile, type PooWangUploadResult, randomizeUploadName, secureRandomIndex, selectUploadRoute } from "./shared";

const Native = VencordNative.pluginHelpers.PooWangUploader as PluginNative<typeof NativeModule>;
const logger = new Logger("PooWangUploader");
const DraftManager = findByPropsLazy("clearDraft", "saveDraft") as {
    clearDraft(channelId: string, draftType: DraftType): void;
};
let tokenConfigured = false;
let attachmentMenuRequestedAt = 0;
let attachmentMenuNavId: string | undefined;
let attachmentMenuInjectionTimer: number | undefined;


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
        logger.info("Token save result", { ok: result.ok, configured: result.ok && Boolean(token.trim()), error: result.error });
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

function openTokenConfiguration() {
    openModal(rootProps => (
        <Modal {...rootProps} title="Configure poo.wang">
            <AccessTokenSetting />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
                <Button onClick={rootProps.onClose}>Done</Button>
            </div>
        </Modal>
    ));
}


function openQuickSettings() {
    openModal(rootProps => {
        const QuickSettings = () => {
            const [reroute, setReroute] = useState(settings.store.rerouteByDefault);
            const [largeFiles, setLargeFiles] = useState(settings.store.autoRerouteLargeFiles);

            return (
                <Modal {...rootProps} title="poo.wang quick settings">
                    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                        <div>
                            <Forms.FormTitle>Reroute uploads by default</Forms.FormTitle>
                            <Forms.FormText>Upload through poo.wang and send the link without asking.</Forms.FormText>
                        </div>
                        <Switch checked={reroute} onChange={value => {
                            settings.store.rerouteByDefault = value;
                            setReroute(value);
                        }} />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 16 }}>
                        <div>
                            <Forms.FormTitle>Reroute oversized files</Forms.FormTitle>
                            <Forms.FormText>Use poo.wang automatically at the configured size limit.</Forms.FormText>
                        </div>
                        <Switch checked={largeFiles} onChange={value => {
                            settings.store.autoRerouteLargeFiles = value;
                            setLargeFiles(value);
                        }} />
                    </label>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
                        <Button onClick={() => { rootProps.onClose(); openTokenConfiguration(); }}>Configure token</Button>
                        <Button onClick={rootProps.onClose}>Done</Button>
                    </div>
                </Modal>
            );
        };
        return <QuickSettings />;
    });
}

function injectQuickSettingsIntoAttachmentMenu(menu: HTMLElement): boolean {
    if (menu.querySelector('[data-vc-poo-wang-settings="true"]') || menu.textContent?.includes("poo.wang upload settings")) return true;

    const reference = menu.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]');
    if (!reference?.parentElement) return false;

    const item = reference.cloneNode(true) as HTMLElement;
    item.dataset.vcPooWangSettings = "true";
    item.setAttribute("role", "menuitem");
    item.setAttribute("aria-label", "poo.wang upload settings");
    item.removeAttribute("aria-checked");
    item.removeAttribute("aria-haspopup");
    item.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));

    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let replaced = false;
    while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        if (!text.nodeValue?.trim()) continue;
        text.nodeValue = replaced ? "" : "poo.wang upload settings";
        replaced = true;
    }
    if (!replaced) item.textContent = "poo.wang upload settings";

    const activate = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        ContextMenuApi.closeContextMenu();
        openQuickSettings();
    };
    item.addEventListener("click", activate, true);
    item.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") activate(event);
    }, true);
    reference.parentElement.append(item);
    logger.info("Injected poo.wang quick settings into attachment menu");
    return true;
}

function scheduleAttachmentMenuInjection(existingMenus: Set<Element>, attempt = 0) {
    clearTimeout(attachmentMenuInjectionTimer);
    attachmentMenuInjectionTimer = window.setTimeout(() => {
        const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'));
        const menu = menus.findLast(candidate => !existingMenus.has(candidate) && candidate.getClientRects().length > 0);
        if (menu && injectQuickSettingsIntoAttachmentMenu(menu)) {
            attachmentMenuInjectionTimer = undefined;
            return;
        }
        if (attempt < 20) scheduleAttachmentMenuInjection(existingMenus, attempt + 1);
        else attachmentMenuInjectionTimer = undefined;
    }, 50);
}
function UploadRouteModal(props: {
    rootProps: RenderModalProps;
    files: readonly File[];
    tokenConfigured: boolean;
    resolve(value: boolean | undefined): void;
}) {
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
            {!props.tokenConfigured && (
                <div style={{ marginTop: 12 }}>
                    <Forms.FormText>Configure a registered-account machine token to enable poo.wang.</Forms.FormText>
                    <Button onClick={() => { close(undefined); openTokenConfiguration(); }}>Configure token</Button>
                </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
                <Button onClick={() => close(undefined)}>Cancel</Button>
                <Button onClick={() => close(false)}>Upload with Discord</Button>
                <Button onClick={() => close(true)} disabled={!props.tokenConfigured}>Upload with poo.wang</Button>
            </div>
        </Modal>
    );
}

function askUploadRoute(files: readonly File[], hasToken: boolean): Promise<boolean | undefined> {
    const { promise, resolve } = Promise.withResolvers<boolean | undefined>();
    let settled = false;
    const settle = (value: boolean | undefined) => {
        if (settled) return;
        settled = true;
        resolve(value);
    };
    openModal(rootProps => (
        <UploadRouteModal rootProps={rootProps} files={files} tokenConfigured={hasToken} resolve={settle} />
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
    hookPlusButton: {
        type: OptionType.BOOLEAN,
        description: "Reroute files selected from Discord's + → Upload a File action",
        default: true
    },
    rerouteByDefault: {
        type: OptionType.BOOLEAN,
        description: "Upload through poo.wang immediately and send the link without asking; when disabled, ask between Cancel, Discord, and poo.wang",
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

const attachmentMenuPatch: GlobalContextMenuPatchCallback = (navId, children) => {
    const requestedNow = Date.now() - attachmentMenuRequestedAt <= 1_000;
    if (requestedNow) {
        attachmentMenuNavId = navId;
        attachmentMenuRequestedAt = 0;
        logger.info("Attachment menu detected", { navId });
    }
    if (navId !== attachmentMenuNavId) return;

    children.push(
        <Menu.MenuItem id="poo-wang-settings" label="poo.wang upload settings">
            <Menu.MenuCheckboxItem
                id="poo-wang-default"
                label="Reroute uploads through poo.wang by default"
                checked={settings.store.rerouteByDefault}
                action={() => settings.store.rerouteByDefault = !settings.store.rerouteByDefault}
            />
            <Menu.MenuCheckboxItem
                id="poo-wang-large-files"
                label="Automatically reroute oversized files"
                checked={settings.store.autoRerouteLargeFiles}
                action={() => settings.store.autoRerouteLargeFiles = !settings.store.autoRerouteLargeFiles}
            />
            <Menu.MenuItem id="poo-wang-token" label="Configure access token" action={openTokenConfiguration} />
        </Menu.MenuItem>
    );
};
const plugin = definePlugin({
    name: "PooWangUploader",
    description: "Reroutes selected or oversized Discord chat attachments through poo.wang",
    authors: [{ name: "Alex", id: 0n }],
    tags: ["Privacy", "Utility"],
    settings,

    plusContextListener: undefined as ((event: MouseEvent) => void) | undefined,

    start() {
        if (!IS_DISCORD_DESKTOP) return;
        void Native.hasAccessToken()
            .then(value => {
                tokenConfigured = value;
                logger.info("Plugin started", { tokenConfigured: value });
            })
            .catch(error => logger.error("Could not read poo.wang token state", error));

        this.plusContextListener = event => {
            const attachmentButton = event.composedPath().find(node =>
                node instanceof Element
                && typeof node.className === "string"
                && isAttachmentPlusClassName(node.className)
            );
            if (!attachmentButton) return;

            const existingMenus = new Set(document.querySelectorAll('[role="menu"]'));
            attachmentMenuRequestedAt = Date.now();
            scheduleAttachmentMenuInjection(existingMenus);
        };
        document.addEventListener("contextmenu", this.plusContextListener, true);
        addGlobalContextMenuPatch(attachmentMenuPatch);
    },

    stop() {
        tokenConfigured = false;
        attachmentMenuRequestedAt = 0;
        attachmentMenuNavId = undefined;
        clearTimeout(attachmentMenuInjectionTimer);
        attachmentMenuInjectionTimer = undefined;
        if (this.plusContextListener) document.removeEventListener("contextmenu", this.plusContextListener, true);
        removeGlobalContextMenuPatch(attachmentMenuPatch);
    },


    async uploadExternally(files: File[]): Promise<string | undefined> {
        const uploadedFiles: PooWangUploadFile[] = [];
        let failure: PooWangUploadResult | undefined;

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
                    logger.info("Upload started", { fileIndex: index + 1, fileCount: files.length, size: file.size, burnMode: settings.store.burnMode });
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
                    logger.info("Upload response", { fileIndex: index + 1, ok: result.ok, status: result.status, error: result.error });
                    report({ fileName: uploadName, fileIndex: index, fileCount: files.length, percent: 100 });
                } catch (error) {
                    result = { ok: false, status: 0, error: String(error) };
                } finally {
                    pollingProgress = false;
                    clearInterval(progressTimer);
                }
                if (!result.ok || !result.file) {
                    failure = result;
                    break;
                }
                uploadedFiles.push(result.file);
            }
        });

        if (failure) {
            logger.warn("poo.wang upload failed", failure.status, failure.error);
            showToast(`Uploaded ${uploadedFiles.length}/${files.length}. ${failure.error ?? "A file failed."}`, Toasts.Type.FAILURE);
            return;
        }

        showToast(`Uploaded ${uploadedFiles.length} file(s) to poo.wang.`, Toasts.Type.SUCCESS);
        return formatUploadLinks(uploadedFiles);
    },

    async onBeforeMessageSend(
        channelId: string,
        message: MessageObject,
        options: SendMessageOptions & { attachmentsToUpload?: CloudUpload[]; },
        _props: SendMessageProps
    ) {
        const store = findByProps("getUploads", "getUploadCount") as {
            getUploads(channelId: string, draftType: DraftType): CloudUpload[];
        } | null;
        const uploads = store?.getUploads(channelId, DraftType.ChannelMessage)
            .filter(upload => !upload.isThumbnail && upload.item?.file instanceof File) ?? [];
        if (!uploads.length) return;

        const files = uploads.map(upload => upload.item.file);
        const route = selectUploadRoute({
            enabled: settings.store.enabled,
            tokenConfigured,
            isThumbnail: false,
            fileSizes: files.map(file => file.size),
            rerouteByDefault: settings.store.rerouteByDefault,
            autoRerouteLargeFiles: settings.store.autoRerouteLargeFiles,
            largeFileThresholdBytes: settings.store.largeFileThresholdMb * 1024 * 1024
        });
        logger.info("Send-time upload route selected", { route, files: files.length, tokenConfigured });
        if (route === "discord") return;
        if (route === "prompt") {
            const reroute = await askUploadRoute(files, tokenConfigured);
            if (reroute === undefined) {
                uploads.forEach(upload => upload.removeFromMsgDraft());
                logger.info("Cleared draft attachments after upload route cancellation", { files: uploads.length, channelId });
                return { cancel: true };
            }
            if (!reroute) return;
        }

        const links = await this.uploadExternally(files);
        if (!links) return { cancel: true };
        const outgoingMessage = { ...message, content: composeUploadMessage(message.content, links) };
        const outgoingOptions = { ...options, attachmentsToUpload: [] };
        try {
            await MessageActions.sendMessage(channelId, outgoingMessage, true, outgoingOptions);
        } catch (error) {
            logger.error("Could not send poo.wang links", error);
            showToast("The file uploaded, but Discord could not send its link. Your draft was kept.", Toasts.Type.FAILURE);
            return { cancel: true };
        }
        const handledUploadIds = new Set(uploads.map(upload => upload.id));
        const clearHandledUploads = () => {
            const currentUploads = store?.getUploads(channelId, DraftType.ChannelMessage) ?? [];
            currentUploads
                .filter(upload => handledUploadIds.has(upload.id))
                .forEach(upload => upload.removeFromMsgDraft());
        };
        DraftManager.clearDraft(channelId, DraftType.ChannelMessage);
        ComponentDispatch.dispatchToLastSubscribed("CLEAR_TEXT");
        FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
        clearHandledUploads();
        window.setTimeout(clearHandledUploads, 0);
        logger.info("Sent poo.wang links and scheduled composer cleanup", { files: uploads.length, channelId });
        return { cancel: true };
    }
});

export default plugin;
