/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Logger } from "@utils/Logger";
import type { Message } from "@vencord/discord-types";
import { Parser, SelectedChannelStore, useEffect, useReducer, UserStore } from "@webpack/common";

import { settings } from "./settings";
import { TranslateIcon } from "./TranslateIcon";
import { cl, getMessageContent, isPendingSentTranslation, sentOriginals, translate, type TranslationValue } from "./utils";

const logger = new Logger("Translate");

// ── Per-message view state ────────────────────────────────────────────────────
//
// A message always shows exactly ONE version: Discord's own content, or the alternative text
// (the translation of an incoming message, or what you typed before your message was
// auto-translated). The accessory renders the alternative in place of the content; the header
// toggle switches between the two. Both read this store, which lives at module level so the
// choice survives the chat list unmounting and remounting rows.

type AltSource = "auto" | "manual" | "outgoing";

interface MessageView {
    altText: string;
    /** Language the alternative was translated from, for the toggle tooltip. */
    language: string;
    source: AltSource;
    showAlt: boolean;
}

const views = new Map<string, MessageView>();
const viewListeners = new Map<string, Set<() => void>>();
const MAX_VIEWS = 500;

function notify(messageId: string) {
    for (const listener of viewListeners.get(messageId) ?? []) listener();
}

function setAlt(messageId: string, altText: string, language: string, source: AltSource) {
    const previous = views.get(messageId);
    // Keep the user's explicit choice when the same alternative is published again (remounts).
    const showAlt = previous && previous.altText === altText ? previous.showAlt : settings.store.immersiveMode || source === "manual";
    if (!previous && views.size >= MAX_VIEWS) {
        const oldest = views.keys().next().value;
        if (oldest) views.delete(oldest);
    }
    views.set(messageId, { altText, language, source, showAlt });
    notify(messageId);
}

function clearAlt(messageId: string, sources: readonly AltSource[]) {
    const view = views.get(messageId);
    if (!view || !sources.includes(view.source)) return;
    views.delete(messageId);
    notify(messageId);
}

export function toggleView(messageId: string) {
    const view = views.get(messageId);
    if (!view) return;
    view.showAlt = !view.showAlt;
    notify(messageId);
}

/** Drop every automatically produced translation, e.g. when auto-translate is switched off. */
export function clearAutoTranslations() {
    for (const [messageId, view] of views) {
        if (view.source !== "auto") continue;
        views.delete(messageId);
        notify(messageId);
    }
}

function useMessageView(messageId: string): MessageView | undefined {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        let listeners = viewListeners.get(messageId);
        if (!listeners) viewListeners.set(messageId, listeners = new Set());
        listeners.add(rerender);
        return () => {
            listeners.delete(rerender);
            if (!listeners.size) viewListeners.delete(messageId);
        };
    }, [messageId]);
    return views.get(messageId);
}

/** Manual "Translate" from the message popover or context menu. */
export function handleTranslate(messageId: string, data: TranslationValue) {
    setAlt(messageId, data.text, data.sourceLanguage, "manual");
}

// ── Auto-translate request cache (shared by remounts and duplicate renders) ──

const translationCache = new Map<string, TranslationValue>();
const inflightRequests = new Map<string, Promise<TranslationValue>>();
const MAX_CACHE = 500;
let requestFailedLogged = false;

function cacheKeyFor(message: Message, content: string): string {
    const { service, receivedInput, receivedOutput } = settings.store;
    return `${message.id}:${content}:${service}:${receivedInput}:${receivedOutput}`;
}

function translateCached(key: string, content: string): Promise<TranslationValue> {
    const cached = translationCache.get(key);
    if (cached) return Promise.resolve(cached);
    let request = inflightRequests.get(key);
    if (!request) {
        request = translate("received", content).then(value => {
            if (translationCache.size >= MAX_CACHE) {
                const oldest = translationCache.keys().next().value;
                if (oldest) translationCache.delete(oldest);
            }
            translationCache.set(key, value);
            return value;
        }).finally(() => inflightRequests.delete(key));
        inflightRequests.set(key, request);
    }
    return request;
}

function isVencordEmbedded(message: object): boolean {
    return "vencordEmbeddedBy" in message && Boolean((message as Record<string, unknown>).vencordEmbeddedBy);
}

// Same rules Discord uses for a normal message body, so mentions, emoji, links, headings and
// lists keep their formatting in the translated version.
function renderMarkdown(text: string, message: Message) {
    return Parser.parse(text, true, {
        channelId: message.channel_id,
        messageId: message.id,
        allowLinks: true,
        allowHeading: true,
        allowList: true,
        allowEmojiLinks: true,
        viewingChannelId: SelectedChannelStore.getChannelId(),
    });
}

// ── Accessory: produces the alternative and renders it in place of the content ──

export function TranslationAccessory({ message }: { message: Message; }) {
    const { autoTranslateReceived, receivedInput, receivedOutput, service } =
        settings.use(["autoTranslateReceived", "immersiveMode", "receivedInput", "receivedOutput", "service"]);
    const view = useMessageView(message.id);
    const sentOriginal = sentOriginals.get(message.id);

    // Outgoing: your message was auto-translated on send; the alternative is what you typed.
    useEffect(() => {
        if (sentOriginal) setAlt(message.id, sentOriginal.original, sentOriginal.targetLanguage, "outgoing");
    }, [message.id, sentOriginal?.original]);

    // Incoming (and own messages without a mapping): translate automatically when enabled.
    useEffect(() => {
        if (isVencordEmbedded(message) || sentOriginal) return;
        if (!autoTranslateReceived) {
            clearAlt(message.id, ["auto"]);
            return;
        }
        const content = getMessageContent(message);
        if (!content) return;
        const me = UserStore.getCurrentUser();
        if (me?.id === message.author.id && isPendingSentTranslation(message.channel_id, content)) return;

        let cancelled = false;
        translateCached(cacheKeyFor(message, content), content)
            .then(value => { if (!cancelled) setAlt(message.id, value.text, value.sourceLanguage, "auto"); })
            .catch(error => {
                if (requestFailedLogged) return;
                requestFailedLogged = true;
                logger.warn("Automatic translation failed", error);
            });
        return () => { cancelled = true; };
        // message.content: an edit must be translated again.
    }, [autoTranslateReceived, message.id, message.content, receivedInput, receivedOutput, service, sentOriginal?.original]);

    if (!view) return null;
    // Messages that continue a group have no header, so the header toggle cannot appear there.
    // This inline copy covers them; CSS hides it whenever the row does have a header.
    const inlineToggle = <TranslationToggle message={message} inline />;
    if (!view.showAlt) return <div className={cl("inline-only")}>{inlineToggle}</div>;
    return (
        <div className={cl("alt", "hide-original")}>
            {inlineToggle}
            {renderMarkdown(view.altText, message)}
        </div>
    );
}

// ── Header toggle: next to the name, only on messages that have an alternative ──

export function TranslationToggle({ message, inline = false }: { message: Message; inline?: boolean; }) {
    const view = useMessageView(message.id);
    if (!view) return null;

    const showing = view.showAlt;
    const label = view.source === "outgoing"
        ? (showing ? "Showing what you typed. Click to show what was sent" : "Showing what was sent. Click to show what you typed")
        : (showing ? `Translated${view.language ? ` from ${view.language}` : ""}. Click to show the original` : "Original. Click to show the translation");

    return (
        <span
            role="button"
            tabIndex={0}
            aria-pressed={showing}
            aria-label={label}
            title={label}
            className={cl("toggle", { "toggle-off": !showing, "inline-toggle": inline })}
            onClick={event => { event.stopPropagation(); toggleView(message.id); }}
            onKeyDown={event => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                toggleView(message.id);
            }}
        >
            <TranslateIcon width={16} height={16} />
        </span>
    );
}
