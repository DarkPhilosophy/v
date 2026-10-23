/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { addGlobalContextMenuPatch, type GlobalContextMenuPatchCallback, removeGlobalContextMenuPatch } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import type { MessageObject, SendMessageOptions, SendMessageProps } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Switch } from "@components/Switch";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { Channel, CloudUpload, RenderModalProps } from "@vencord/discord-types";
import { DraftType } from "@vencord/discord-types/enums";
import { findByProps, findByPropsLazy } from "@webpack";
import { ChannelStore, closeModal, ComponentDispatch, ContextMenuApi, FluxDispatcher, Forms, Menu, MessageActions, Modal, openModal, PermissionsBits, PermissionStore, SelectedChannelStore, showToast, TextInput, useEffect, useRef, UserStore, useState } from "@webpack/common";
import type * as NativeModule from "./native";
import { composeUploadMessages, formatBlockedUploadLinks, formatUploadLinks, isAttachmentPlusClassName, type PinnedUploadRoute, type PooWangUploadFile, type PooWangUploadResult, type PromptRouteChoice, randomizeUploadName, resolvePromptChoice, secureRandomIndex, selectUploadRoute, shouldInterceptBlockedUpload } from "./shared";

const Native = VencordNative.pluginHelpers.PooWangUploader as PluginNative<typeof NativeModule>;
const logger = new Logger("PooWangUploader");
const Premium = findByPropsLazy("getUserMaxFileSize", "isPremiumExactly");
const DraftManager = findByPropsLazy("clearDraft", "saveDraft") as {
    clearDraft(channelId: string, draftType: DraftType): void;
};
let tokenConfigured = false;
let attachmentMenuRequestedAt = 0;
let attachmentMenuNavId: string | undefined;
let attachmentMenuInjectionTimer: number | undefined;

const LAST_ROUTE_KEY = "PooWangUploader_lastPromptRoute";
/** Last explicit pick in the "Ask each time" chooser; preselected next time. */
let lastPromptRoute: PromptRouteChoice | undefined;


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
            showToast({ text: result.error ?? "Could not store the poo.wang token.", variant: "critical" });
            return;
        }
        setToken("");
        tokenConfigured = Boolean(token.trim());
        setConfigured(tokenConfigured);
        showToast({ text: tokenConfigured ? "poo.wang token stored securely." : "poo.wang token removed.", variant: "success" });
    }

    async function clearToken() {
        setToken("");
        setSaving(true);
        const result = await Native.setAccessToken("").catch(error => ({ ok: false, error: String(error) }));
        setSaving(false);
        if (!result.ok) {
            showToast({ text: result.error ?? "Could not remove the poo.wang token.", variant: "critical" });
            return;
        }
        tokenConfigured = false;
        setConfigured(false);
        showToast({ text: "poo.wang token removed.", variant: "success" });
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
            const [route, setRoute] = useState(settings.store.uploadRoute);
            const [largeFiles, setLargeFiles] = useState(settings.store.autoRerouteLargeFiles);

            return (
                <Modal {...rootProps} title="poo.wang quick settings">
                    <div>
                        <Forms.FormTitle>Where uploads go</Forms.FormTitle>
                        <Forms.FormText>Pick one to stop being asked every time.</Forms.FormText>
                        {([["prompt", "Ask each time"], ["discord", "Always Discord"], ["poo-wang", "Always poo.wang"]] as const).map(([value, label]) => (
                            <Button
                                key={value}
                                variant={route === value ? "primary" : "secondary"}
                                style={{ marginRight: 8, marginTop: 8 }}
                                onClick={() => { settings.store.uploadRoute = value; setRoute(value); }}
                            >
                                {label}
                            </Button>
                        ))}
                    </div>
                    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 16 }}>
                        <div>
                            <Forms.FormTitle>Reroute oversized files</Forms.FormTitle>
                            <Forms.FormText>Override Always Discord when a file reaches your threshold or Discord rejects its size. Ask each time still asks.</Forms.FormText>
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
interface UploadRouteOptions {
    /** Discord cannot carry these files at all (e.g. missing ATTACH_FILES), so offering it would be a lie. */
    discordUnavailable?: boolean;
    discordSizeExceeded?: boolean;
    discordNeedsNitro?: boolean;
}

function UploadRouteModal(props: {
    rootProps: RenderModalProps;
    files: readonly File[];
    tokenConfigured: boolean;
    options: UploadRouteOptions;
    resolve(value: boolean | undefined): void;
}) {
    const [remember, setRemember] = useState(false);
    const totalMb = props.files.reduce((total, file) => total + file.size, 0) / 1024 / 1024;
    const close = (value: boolean | undefined) => {
        if (value !== undefined) {
            // The last pick becomes the next preselection; cancelling changes nothing.
            lastPromptRoute = value ? "poo-wang" : "discord";
            void DataStore.set(LAST_ROUTE_KEY, lastPromptRoute)
                .catch(error => logger.error("Could not save last upload route", error));
            // "Remember" still pins the route permanently and skips the chooser.
            if (remember) settings.store.uploadRoute = value ? "poo-wang" : "discord";
        }
        props.resolve(value);
        props.rootProps.onClose();
    };

    // Remember a destination without bypassing the chooser or unavailable-route safeguards.
    const oversized = props.files.some(file => file.size >= settings.store.largeFileThresholdMb * 1024 * 1024);
    const enterChoice = resolvePromptChoice({
        tokenConfigured: props.tokenConfigured,
        discordUnavailable: props.options.discordUnavailable,
        oversizedAutoReroute: !!props.options.discordSizeExceeded || (oversized && settings.store.autoRerouteLargeFiles),
        lastChoice: lastPromptRoute,
    });
    const initialButton = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        // Let the modal's focus lock mount before applying the saved preselection.
        const frame = requestAnimationFrame(() => initialButton.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, []);

    return (
        <Modal {...props.rootProps} onClose={() => { props.resolve(undefined); props.rootProps.onClose(); }} title="Choose upload destination">
            <Forms.FormText>
                {props.files.length} file(s), {totalMb.toFixed(1)} MB total.
                {props.options.discordUnavailable && " Discord does not allow attachments in this channel, so these can only go to poo.wang."}
                {props.options.discordSizeExceeded && " These files exceed Discord's current upload limit. poo.wang is recommended; choosing Discord will show its size-limit notice."}
            </Forms.FormText>
            {!props.tokenConfigured && (
                <div style={{ marginTop: 12 }}>
                    <Forms.FormText>Configure a registered-account machine token to enable poo.wang.</Forms.FormText>
                    <Button onClick={() => { props.resolve(undefined); props.rootProps.onClose(); openTokenConfiguration(); }}>Configure token</Button>
                </div>
            )}
            <label className="vc-poo-wang-route-remember">
                <Switch checked={remember} onChange={setRemember} />
                Always use this destination (skip this chooser)
            </label>
            <div className="vc-poo-wang-route-buttons">
                <Button size="small" variant="secondary" ref={enterChoice === undefined ? initialButton : undefined} onClick={() => close(undefined)}>Cancel</Button>
                <div className="vc-poo-wang-route-destinations" role="group" aria-label="Upload via">
                    <span className="vc-poo-wang-route-label" aria-hidden="true">Upload via</span>
                    {!props.options.discordUnavailable && (
                        <Button size="small" variant="secondary" ref={enterChoice === "discord" ? initialButton : undefined} onClick={() => close(false)}>{props.options.discordNeedsNitro ? "Discord Nitro" : "Discord"}</Button>
                    )}
                    <Button size="small" variant="secondary" className={props.options.discordSizeExceeded && props.tokenConfigured ? "vc-poo-wang-recommended" : undefined} aria-label={props.options.discordSizeExceeded ? "poo.wang (recommended)" : "poo.wang"} ref={enterChoice === "poo-wang" ? initialButton : undefined} onClick={() => close(true)} disabled={!props.tokenConfigured}>poo.wang</Button>
                </div>
            </div>
        </Modal>
    );
}

function askUploadRoute(files: readonly File[], hasToken: boolean, options: UploadRouteOptions): Promise<boolean | undefined> {
    const { promise, resolve } = Promise.withResolvers<boolean | undefined>();
    let settled = false;
    const settle = (value: boolean | undefined) => {
        if (settled) return;
        settled = true;
        resolve(value);
    };
    openModal(rootProps => (
        <UploadRouteModal rootProps={rootProps} files={files} tokenConfigured={hasToken} options={options} resolve={settle} />
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
    uploadRoute: {
        type: OptionType.SELECT,
        description: "Ask each time always shows the chooser. Always Discord and Always poo.wang skip it; oversized rerouting can override Always Discord.",
        options: [
            { label: "Ask each time", value: "prompt", default: true },
            { label: "Always Discord", value: "discord" },
            { label: "Always poo.wang", value: "poo-wang" }
        ]
    },
    autoRerouteLargeFiles: {
        type: OptionType.BOOLEAN,
        description: "Override Always Discord for files at your threshold or over Discord's actual limit. Ask each time still asks.",
        default: true
    },
    largeFileThresholdMb: {
        type: OptionType.NUMBER,
        description: "Reroute Always Discord uploads at or above this size in MB; Discord's own lower limit also triggers rerouting",
        default: 25,
        isValid: (value: number) => Number.isFinite(value) && value >= 1 && value <= 90 || "Enter a value from 1 to 90 MB (the current poo.wang API maximum).",
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
        isValid: (value: number) => Number.isInteger(value) && value >= 3 && value <= 64 || "Enter an integer from 3 to 64.",
        disabled() { return !this.store.randomizeFileNames; }
    },
    randomNameCharacters: {
        type: OptionType.STRING,
        description: "Printable ASCII characters allowed in random filenames. Unsafe path characters are ignored.",
        default: "abcdefghijklmnopqrstuvwxyz0123456789",
        isValid: (value: string) => [...new Set(value)].some(character =>
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

/**
 * Before `uploadRoute` existed, "always poo.wang" was the boolean `rerouteByDefault`.
 * Carry that choice over once, otherwise anyone who had it on silently goes back to
 * being asked on every send.
 */
function migrateLegacyRouteSetting(): void {
    const store = settings.store as unknown as Record<string, unknown>;
    if (!("rerouteByDefault" in store)) return;
    if (store.rerouteByDefault === true && settings.store.uploadRoute === "prompt") {
        settings.store.uploadRoute = "poo-wang";
        logger.info("Migrated legacy rerouteByDefault=true to uploadRoute=poo-wang");
    }
    delete store.rerouteByDefault;
}

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
            <Menu.MenuRadioItem
                id="poo-wang-route-prompt"
                group="poo-wang-route"
                label="Ask each time"
                checked={settings.store.uploadRoute === "prompt"}
                action={() => settings.store.uploadRoute = "prompt"}
            />
            <Menu.MenuRadioItem
                id="poo-wang-route-discord"
                group="poo-wang-route"
                label="Always Discord"
                checked={settings.store.uploadRoute === "discord"}
                action={() => settings.store.uploadRoute = "discord"}
            />
            <Menu.MenuRadioItem
                id="poo-wang-route-poo-wang"
                group="poo-wang-route"
                label="Always poo.wang"
                checked={settings.store.uploadRoute === "poo-wang"}
                action={() => settings.store.uploadRoute = "poo-wang"}
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

/** The composer for the currently open channel; paste/drop anywhere else (message edit, search, settings) is none of our business. */
function isComposerTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[class*="channelTextArea"], [role="textbox"][data-slate-editor="true"]') != null;
}

async function routeBlockedUpload(
    files: File[],
    channelId = SelectedChannelStore.getChannelId(),
    options: UploadRouteOptions = { discordUnavailable: true }
): Promise<boolean> {
    if (!channelId) return false;

    const route = selectUploadRoute({
        enabled: settings.store.enabled,
        tokenConfigured,
        isThumbnail: false,
        fileSizes: files.map(file => file.size),
        pinnedRoute: settings.store.uploadRoute as PinnedUploadRoute,
        autoRerouteLargeFiles: settings.store.autoRerouteLargeFiles,
        largeFileThresholdBytes: settings.store.largeFileThresholdMb * 1024 * 1024,
        discordSizeExceeded: options.discordSizeExceeded
    });
    if (route === "discord" && options.discordSizeExceeded) return false;
    // Permission-blocked uploads cannot use Discord; size-blocked uploads can
    // explicitly return to Discord's own size-limit/Nitro notice.
    if (route !== "poo-wang") {
        const reroute = await askUploadRoute(files, tokenConfigured, options);
        if (reroute === undefined) return true;
        if (!reroute) return !options.discordSizeExceeded;
    }

    const uploaded = await plugin.uploadExternally(files);
    if (!uploaded) return true;

    const channel = ChannelStore.getChannel(channelId);
    const canEmbed = channel == null || channel.isPrivate() || PermissionStore.can(PermissionsBits.EMBED_LINKS, channel);
    const [content] = composeUploadMessages("", [formatBlockedUploadLinks(uploaded, canEmbed)]);
    try {
        await MessageActions.sendMessage(
            channelId,
            { content, invalidEmojis: [], tts: false, validNonShortcutEmojis: [] },
            true,
            { attachmentsToUpload: [] }
        );
        logger.info("Sent poo.wang links for upload Discord would have blocked", { channelId, files: uploaded.length, canEmbed });
    } catch (error) {
        logger.error("Could not send poo.wang links for blocked upload", error);
        showToast({ text: "The files uploaded to poo.wang, but Discord could not send their links.", variant: "critical" });
    }
    return true;
}

/** Blocked upload = Discord would reject it, so nothing but poo.wang can carry it. */
function isBlockedUploadContext(files: readonly File[]): boolean {
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId ? ChannelStore.getChannel(channelId) : undefined;
    const canAttachFiles = channel == null || channel.isPrivate() || PermissionStore.can(PermissionsBits.ATTACH_FILES, channel);
    return shouldInterceptBlockedUpload({
        enabled: settings.store.enabled,
        tokenConfigured,
        canAttachFiles,
        fileCount: files.length
    });
}

function interceptBlockedFiles(event: Event, files: File[]): void {
    if (!files.length || !isBlockedUploadContext(files)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    logger.info("Intercepted upload Discord would reject for missing ATTACH_FILES", { channelId: SelectedChannelStore.getChannelId(), files: files.length, type: event.type });
    void routeBlockedUpload(files);
}

// Discord's drop zone covers the whole chat pane, not just the textbox, so a drop
// only needs to land in the chat area. dragover must be cancelled too or Discord
// claims the drag before drop ever fires.
function isChatAreaTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[class*="chatContent"], [class*="chat_"], main') != null;
}

function interceptBlockedDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes("Files") || !isChatAreaTarget(event.target)) return;
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId ? ChannelStore.getChannel(channelId) : undefined;
    const canAttachFiles = channel == null || channel.isPrivate() || PermissionStore.can(PermissionsBits.ATTACH_FILES, channel);
    if (canAttachFiles || !settings.store.enabled || !tokenConfigured) return;
    event.preventDefault();
    event.stopImmediatePropagation();
}

function interceptBlockedDrop(event: DragEvent): void {
    if (!isChatAreaTarget(event.target)) return;
    interceptBlockedFiles(event, Array.from(event.dataTransfer?.files ?? []));
}

// Paste stays restricted to the composer: an image pasted into search or a
// message-edit box must never leave for a third-party host.
function interceptBlockedPaste(event: ClipboardEvent): void {
    if (!isComposerTarget(event.target)) return;
    const files = Array.from(event.clipboardData?.items ?? [])
        .filter(item => item.kind === "file")
        .map(item => item.getAsFile())
        .filter((file): file is File => file != null);
    interceptBlockedFiles(event, files);
}

const plugin = definePlugin({
    name: "PooWangUploader",
    description: "Reroutes selected or oversized Discord chat attachments through poo.wang",
    authors: [{ name: "Alex", id: 0n }],
    tags: ["Privacy", "Utility"],
    settings,

    patches: [{
        find: "Unexpected mismatch between files and file metadata",
        replacement: {
            // Intercept only after Discord's own compression/size validation rejects
            // an attachment. Picker, paste and drop share this path; normal drafts do not change.
            match: /(if\(\(0,\i\.\i\)\(\{files:(\i),guildId:\i\}\)\))return void (\i)\((\i),\2\);/,
            replace: "$1{if(await $self.handleOversizedUpload($2,$4,arguments[2],arguments[3]?.isThumbnail))return;return void $3($4,$2);}"
        }
    }],

    async handleOversizedUpload(files: File[], channel: Channel, draftType: DraftType, isThumbnail = false): Promise<boolean> {
        if (!settings.store.enabled || !tokenConfigured || isThumbnail || draftType !== DraftType.ChannelMessage) return false;
        return routeBlockedUpload(files, channel.id, {
            discordSizeExceeded: true,
            discordNeedsNitro: !Premium.isPremiumExactly(UserStore.getCurrentUser(), 2)
        });
    },

    plusContextListener: undefined as ((event: MouseEvent) => void) | undefined,

    start() {
        if (!IS_DISCORD_DESKTOP) return;
        migrateLegacyRouteSetting();
        void DataStore.get<string>(LAST_ROUTE_KEY)
            .then(value => {
                if (lastPromptRoute === undefined && (value === "discord" || value === "poo-wang")) lastPromptRoute = value;
            })
            .catch(error => logger.error("Could not read last upload route", error));
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
        document.addEventListener("dragover", interceptBlockedDragOver, true);
        document.addEventListener("drop", interceptBlockedDrop, true);
        document.addEventListener("paste", interceptBlockedPaste, true);
        addGlobalContextMenuPatch(attachmentMenuPatch);
    },

    stop() {
        tokenConfigured = false;
        attachmentMenuRequestedAt = 0;
        attachmentMenuNavId = undefined;
        clearTimeout(attachmentMenuInjectionTimer);
        attachmentMenuInjectionTimer = undefined;
        if (this.plusContextListener) document.removeEventListener("contextmenu", this.plusContextListener, true);
        document.removeEventListener("dragover", interceptBlockedDragOver, true);
        document.removeEventListener("drop", interceptBlockedDrop, true);
        document.removeEventListener("paste", interceptBlockedPaste, true);
        removeGlobalContextMenuPatch(attachmentMenuPatch);
    },


    async uploadExternally(files: File[]): Promise<PooWangUploadFile[] | undefined> {
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
            showToast({ text: `Uploaded ${uploadedFiles.length}/${files.length}. ${failure.error ?? "A file failed."}`, variant: "critical" });
            return;
        }

        showToast({ text: `Uploaded ${uploadedFiles.length} file(s) to poo.wang.`, variant: "success" });
        return uploadedFiles;
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

        const handledUploadIds = uploads.map(upload => upload.id);
        // upload.cancel() sends DELETE /attachments/<upload> to Discord. Calling it on every retry
        // below sent three DELETEs per file: the 2nd and 3rd 404, then Discord rate-limits the
        // attachments endpoint (429), which stalls the next paste's upload and with it sending.
        // Cancel once; the retries only re-dispatch the local removal.
        let cancelled = false;
        const removeHandledUploads = () => {
            if (!cancelled) {
                cancelled = true;
                uploads.forEach(upload => upload.cancel());
            }
            FluxDispatcher.dispatch({
                type: "UPLOAD_ATTACHMENT_REMOVE_FILES",
                channelId,
                attachmentIds: handledUploadIds,
                draftType: DraftType.ChannelMessage
            });
        };
        const scheduleUploadRemoval = () => {
            removeHandledUploads();
            window.setTimeout(removeHandledUploads, 0);
            window.setTimeout(removeHandledUploads, 250);
        };

        const files = uploads.map(upload => upload.item.file);
        const route = selectUploadRoute({
            enabled: settings.store.enabled,
            tokenConfigured,
            isThumbnail: false,
            fileSizes: files.map(file => file.size),
            pinnedRoute: settings.store.uploadRoute as PinnedUploadRoute,
            autoRerouteLargeFiles: settings.store.autoRerouteLargeFiles,
            largeFileThresholdBytes: settings.store.largeFileThresholdMb * 1024 * 1024
        });
        logger.info("Send-time upload route selected", { route, files: files.length, tokenConfigured });
        if (route === "discord") return;
        if (route === "prompt") {
            const reroute = await askUploadRoute(files, tokenConfigured, {});
            if (reroute === undefined) {
                // Dismissing the chooser (X or Cancel) only aborts this send. The draft,
                // its attachments and the typed text are the user's context and stay put;
                // cancel:true leaves the composer uncleared, so they can pick again.
                logger.info("Upload route chooser dismissed; draft kept", { files: uploads.length, channelId });
                return { cancel: true };
            }
            if (!reroute) return;
        }

        const uploadedFiles = await this.uploadExternally(files);
        if (!uploadedFiles) return { cancel: true };
        const messageContents = composeUploadMessages(message.content, [formatUploadLinks(uploadedFiles)]);
        const originalOptions = { ...options, attachmentsToUpload: [] };
        let sentMessages = 0;
        try {
            for (const content of messageContents) {
                const carriesOriginalOptions = sentMessages === 0;
                await MessageActions.sendMessage(
                    channelId,
                    carriesOriginalOptions
                        ? { ...message, content }
                        : { content, invalidEmojis: [], tts: false, validNonShortcutEmojis: [] },
                    true,
                    carriesOriginalOptions
                        ? originalOptions
                        : { location: options.location, attachmentsToUpload: [] }
                );
                sentMessages++;
            }
        } catch (error) {
            logger.error("Could not send poo.wang message sequence", error);
            showToast({
                text: sentMessages > 0
                    ? `Sent ${sentMessages} message(s), but the grouped poo.wang previews failed.`
                    : "The files uploaded, but Discord could not send their links. Your draft was kept.",
                variant: "critical"
            });
            if (sentMessages === 0) return { cancel: true };
        }

        DraftManager.clearDraft(channelId, DraftType.ChannelMessage);
        ComponentDispatch.dispatchToLastSubscribed("CLEAR_TEXT");
        FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
        scheduleUploadRemoval();
        logger.info("Sent grouped poo.wang previews and removed composer uploads", { files: uploads.length, channelId, sentMessages });
        return { cancel: true };
    }
});

export default plugin;
