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

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Menu, UserStore } from "@webpack/common";

import { settings } from "./settings";
import { setShouldShowTranslateEnabledTooltip, TranslateChatBarIcon, TranslateIcon } from "./TranslateIcon";
import { handleTranslate, TranslationAccessory, TranslationToggle } from "./TranslationAccessory";
import { getMessageContent, getTargetLanguageName, pendingSent, QUEUE_TTL_MS, sentOriginals, translate } from "./utils";
const logger = new Logger("Translate");

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    const content = getMessageContent(message);
    if (!content) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;

    group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
        <Menu.MenuItem
            id="vc-trans"
            label="Translate"
            icon={TranslateIcon}
            leadingAccessory={{ type: "icon", icon: TranslateIcon }}
            action={async () => {
                const trans = await translate("received", content);
                handleTranslate(message.id, trans);
            }}
        />
    ));
};

let tooltipTimeout: ReturnType<typeof setTimeout>;


export default definePlugin({
    name: "Translate",
    description: "Translate messages with Google Translate, DeepL or Kagi.",
    tags: ["Chat", "Utility"],
    authors: [Devs.Ven, Devs.AshtonMemer, Devs.koish1],
    dependencies: ["MessageAccessoriesAPI", "MessageDecorationsAPI"],
    settings,
    contextMenus: {
        "message": messageCtxPatch
    },
    // not used, just here in case some other plugin wants it or w/e
    translate,

    // The accessory replaces the message body with the alternative version; the decoration is the
    // toggle next to the name. Both exist only while this plugin runs, and the toggle only
    // renders on messages that actually have an alternative.
    start() {
        addMessageAccessory("Translate", props => <TranslationAccessory message={props.message} />, 0);
        addMessageDecoration("Translate", props => props.message ? <TranslationToggle message={props.message} /> : null);
        logger.info("Accessory registered; auto-received:", settings.store.autoTranslateReceived, "translated by default:", settings.store.immersiveMode);
    },

    stop() {
        removeMessageAccessory("Translate");
        removeMessageDecoration("Translate");
    },

    chatBarButton: {
        icon: TranslateIcon,
        render: TranslateChatBarIcon
    },

    messagePopoverButton: {
        icon: TranslateIcon,
        render(message: Message) {
            const content = getMessageContent(message);
            if (!content) return null;

            return {
                label: "Translate",
                icon: TranslateIcon,
                onClick: async () => {
                    const trans = await translate("received", content);
                    handleTranslate(message.id, trans);
                }
            };
        }
    },

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: Message; optimistic?: boolean; }) {
            // Only correlate on server-confirmed messages to guarantee FIFO correctness.
            // Ignoring optimistic avoids misattributing queue entries when multiple
            // messages are in-flight. The original text appears after confirmation (~200ms),
            // not on the optimistic preview — acceptable tradeoff for correctness.
            if (optimistic) return;
            const queue = pendingSent.get(message.channel_id);
            if (!queue || queue.length === 0) return;
            // Evict stale entries (failed sends, network drops) to prevent stuck queue
            const now = Date.now();
            while (queue.length > 0 && now - queue[0].ts > QUEUE_TTL_MS) queue.shift();
            if (queue.length === 0) return;
            const me = UserStore.getCurrentUser();
            if (!me || message.author?.id !== me.id) return;
            // FIFO with content guard: peek head, verify match before consuming.
            // Prevents an intervening non-translated message from stealing the entry.
            const entry = queue[0];
            if (!entry || entry.translated !== message.content) return;
            queue.shift();
            sentOriginals.set(message.id, entry);
            // Evict oldest if over capacity
            if (sentOriginals.size > 500) {
                const firstKey = sentOriginals.keys().next().value;
                if (firstKey) sentOriginals.delete(firstKey);
            }
        }
    },

    async onBeforeMessageSend(channelId: string, message) {
        if (!settings.store.autoTranslate) return;
        if (!message.content) return;

        setShouldShowTranslateEnabledTooltip?.(true);
        clearTimeout(tooltipTimeout);
        tooltipTimeout = setTimeout(() => setShouldShowTranslateEnabledTooltip?.(false), 2000);

        const original = message.content;
        // A failed translation (offline, provider error) must never block or break sending:
        // translate() already showed a toast, so send what the user typed.
        const trans = await translate("sent", original).catch(error => {
            logger.warn("Outgoing translation failed; sending the original text", error);
            return undefined;
        });
        if (!trans) return;
        const targetLang = getTargetLanguageName("sent");
        const entry = { original, translated: trans.text, targetLanguage: targetLang, ts: Date.now() };
        const queue = pendingSent.get(channelId);
        if (queue) queue.push(entry);
        else pendingSent.set(channelId, [entry]);
        message.content = trans.text;
    },

    async onBeforeMessageEdit(channelId: string, messageId: string, message) {
        if (!settings.store.autoTranslate) return;
        if (!message.content) return;

        const original = message.content;
        const trans = await translate("sent", original).catch(error => {
            logger.warn("Edit translation failed; saving the original text", error);
            return undefined;
        });
        if (!trans) return;
        // Update the outgoing mapping so immersive mode shows the correct original
        const targetLang = getTargetLanguageName("sent");
        sentOriginals.set(messageId, { original, translated: trans.text, targetLanguage: targetLang });
        message.content = trans.text;
    }
});
