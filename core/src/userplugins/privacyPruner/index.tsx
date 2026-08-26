import "./styles.css";

import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import { findGroupChildrenByChildId, type NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin, { type IconComponent } from "@utils/types";
import type { Channel, Guild, Message } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, GuildStore, Menu, SelectedChannelStore, UserStore } from "@webpack/common";

import { GlobalDefaultsSettings, openChannelPruningModal, openDeleteConfirmation, openPrivacyManager } from "./components";
import { DEFAULT_PRUNING_TEMPLATE, classifyAutoApplyTarget, registerNewId, type PruningTemplate } from "./defaults";
import { setChannelPolicy, setGuildEnabled, setMessageKept } from "./model";
import { enableChannelPolicy, queueOwnMessage, startScheduler, stopScheduler } from "./runtime";
import { readSyncedState, settings, writeSyncedState } from "./settings";

const PrivacyIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12 2 4 5v6c0 5.25 3.4 9.74 8 11 4.6-1.26 8-5.75 8-11V5l-8-3Zm0 3.18 5 1.87V11c0 3.72-2.2 7.25-5 8.42C9.2 18.25 7 14.72 7 11V7.05l5-1.87Zm-1 3.32v4.09l-1.3-1.3-1.4 1.42 3.7 3.7 5.2-5.2-1.4-1.42-2.8 2.8V8.5h-2Z" />
    </svg>
);

function channelInput(channel: Channel) {
    return {
        channelId: channel.id,
        guildId: channel.guild_id ?? null,
        channelName: channel.name || "Direct Message",
    };
}

const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

function policyChannelFor(channel: Channel): Channel {
    if (!THREAD_CHANNEL_TYPES.has(channel.type) || !channel.parent_id) return channel;
    return ChannelStore.getChannel(channel.parent_id) ?? channel;
}

const PrivateChannelSortStore = findStoreLazy("PrivateChannelSortStore") as { getPrivateChannelIds(): string[]; };
const MESSAGE_CAPABLE_GUILD_CHANNEL_TYPES = new Set([0, 2, 5, 13, 15, 16]);
let knownGuildIds = new Set<string>();
let knownPrivateChannelIds = new Set<string>();

function readDefaultTemplate(): PruningTemplate {
    try {
        const parsed = JSON.parse(settings.store.defaultTemplate) as PruningTemplate;
        if (
            typeof parsed.retentionMs === "number" &&
            typeof parsed.maximumLookbackMs === "number" &&
            typeof parsed.scanIntervalMs === "number"
        ) return { ...DEFAULT_PRUNING_TEMPLATE, ...parsed };
    } catch {
        // Use the stable defaults.
    }
    return DEFAULT_PRUNING_TEMPLATE;
}

function readAutoManagedGuildIds(): Set<string> {
    try {
        const ids = JSON.parse(settings.store.autoManagedGuildIds);
        return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
    } catch {
        return new Set();
    }
}

function markAutoManagedGuild(guildId: string): void {
    const ids = readAutoManagedGuildIds();
    ids.add(guildId);
    settings.store.autoManagedGuildIds = JSON.stringify([...ids]);
}

function applyTemplateToChannel(channel: Channel): void {
    if (THREAD_CHANNEL_TYPES.has(channel.type) || !MESSAGE_CAPABLE_GUILD_CHANNEL_TYPES.has(channel.type)) return;
    enableChannelPolicy(channel.id, channel.guild_id ?? null, {
        ...readDefaultTemplate(),
        enabled: true,
    });
}

function applyTemplateToPrivateChannel(channel: Channel): void {
    const target = classifyAutoApplyTarget(channel);
    if (
        target === "dm" && !settings.store.autoApplyDms ||
        target === "groupDm" && !settings.store.autoApplyGroupDms ||
        target == null
    ) return;
    enableChannelPolicy(channel.id, null, { ...readDefaultTemplate(), enabled: true });
}

function disableChannel(channel: Channel): void {
    const state = readSyncedState();
    const record = state.channels[channel.id];
    if (!record) return;
    writeSyncedState(setChannelPolicy(state, channel.id, channel.guild_id ?? null, { ...record.policy, enabled: false }));
}

const messageContextMenu: NavContextMenuPatchCallback = (children, props: { message?: Message; channel?: Channel; }) => {
    const { message } = props;
    const currentUser = UserStore.getCurrentUser();
    if (!message || !currentUser || message.author.id !== currentUser.id) return;
    const state = readSyncedState();
    const kept = state.kept[message.id] != null;
    children.push(
        <Menu.MenuItem
            id="vc-privacy-pruner-message"
            label="Privacy Pruning"
        >
            <Menu.MenuItem
                id="vc-privacy-pruner-keep"
                label={kept ? "Remove Keep" : "Keep Message"}
                action={() => writeSyncedState(setMessageKept(readSyncedState(), {
                    messageId: message.id,
                    channelId: message.channel_id,
                    guildId: props.channel?.guild_id,
                }, !kept))}
            />
            <Menu.MenuItem
                id="vc-privacy-pruner-delete-now"
                label="Delete Now"
                color="danger"
                action={() => openDeleteConfirmation(message.channel_id, message.id, () => {
                    writeSyncedState(setMessageKept(readSyncedState(), {
                        messageId: message.id,
                        channelId: message.channel_id,
                        guildId: props.channel?.guild_id,
                    }, false));
                })}
            />
            <Menu.MenuItem id="vc-privacy-pruner-manager" label="Open Privacy Manager" action={openPrivacyManager} />
        </Menu.MenuItem>
    );
};

function setKeepForMessage(message: Message, keep: boolean): void {
    const channel = ChannelStore.getChannel(message.channel_id);
    writeSyncedState(setMessageKept(readSyncedState(), {
        messageId: message.id,
        channelId: message.channel_id,
        guildId: channel?.guild_id,
    }, keep));
}

const guildContextMenu: NavContextMenuPatchCallback = (children, props: { guild?: Guild; }) => {
    const guild = props.guild;
    if (!guild) return;
    const state = readSyncedState();
    const enabled = state.guilds[guild.id]?.enabled === true;
    const group = findGroupChildrenByChildId("privacy", children) ?? children;
    group.push(
        <Menu.MenuCheckboxItem
            id="vc-privacy-pruner-guild"
            label="Enable Privacy Pruning for Guild"
            checked={enabled}
            action={() => writeSyncedState(setGuildEnabled(readSyncedState(), guild.id, !enabled))}
        />
    );
};

const channelContextMenu: NavContextMenuPatchCallback = (children, props: { channel?: Channel; }) => {
    const selectedChannel = props.channel;
    if (!selectedChannel) return;
    const channel = policyChannelFor(selectedChannel);
    const state = readSyncedState();
    const record = state.channels[channel.id];
    const guildEnabled = channel.guild_id ? state.guilds[channel.guild_id]?.enabled === true : true;
    const active = record?.policy.enabled === true;
    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    group.push(
        <Menu.MenuItem id="vc-privacy-pruner-channel" label="Privacy Pruning">
            <Menu.MenuItem
                id="vc-privacy-pruner-channel-settings"
                label={active ? "Open Channel Pruning Settings" : "Enable Pruning for This Channel"}
                action={() => openChannelPruningModal(channelInput(channel))}
            />
            {active && !guildEnabled && channel.guild_id && (
                <Menu.MenuItem id="vc-privacy-pruner-guild-paused" label="Paused — Guild pruning is disabled" disabled />
            )}
            {active && (
                <Menu.MenuItem id="vc-privacy-pruner-disable-channel" label="Disable for This Channel" action={() => disableChannel(channel)} />
            )}
            <Menu.MenuItem id="vc-privacy-pruner-open-manager" label="Open Privacy Manager" action={openPrivacyManager} />
        </Menu.MenuItem>
    );
};

const PrivacyChatButton: ChatBarButtonFactory = ({ isMainChat }) => {
    settings.use(["syncedState"]);
    if (!isMainChat) return null;
    const channelId = SelectedChannelStore.getChannelId();
    const selectedChannel = channelId ? ChannelStore.getChannel(channelId) : undefined;
    if (!selectedChannel) return null;
    const channel = policyChannelFor(selectedChannel);
    const state = readSyncedState();
    const record = state.channels[channel.id];
    const guildEnabled = channel.guild_id ? state.guilds[channel.guild_id]?.enabled === true : true;
    const active = record?.policy.enabled === true && guildEnabled;
    const configured = record?.policy.enabled === true;
    const tooltip = active
        ? "Privacy Pruning active"
        : configured
            ? "Privacy Pruning configured but paused"
            : "Configure Privacy Pruning";
    return (
        <ChatBarButton tooltip={tooltip} onClick={() => openChannelPruningModal(channelInput(channel))}>
            <PrivacyIcon className={active ? "vc-privacy-pruner-icon-active" : configured ? "vc-privacy-pruner-icon-paused" : undefined} />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "PrivacyPruner",
    description: "Automatically deletes your expired messages while preserving messages explicitly marked Keep.",
    authors: [{ name: "Alex", id: 0n }],
    tags: ["Privacy", "Chat"],
    settings,
    settingsAboutComponent: GlobalDefaultsSettings,
    contextMenus: {
        message: messageContextMenu,
        "guild-context": guildContextMenu,
        "guild-header-popout": guildContextMenu,
        "channel-context": channelContextMenu,
        "thread-context": channelContextMenu,
        "gdm-context": channelContextMenu,
        "user-context": channelContextMenu,
    },
    messagePopoverButton: {
        icon: PrivacyIcon,
        render(message) {
            const currentUser = UserStore.getCurrentUser();
            if (!currentUser || message.author.id !== currentUser.id) return null;
            const channel = ChannelStore.getChannel(message.channel_id);
            const kept = readSyncedState().kept[message.id] != null;
            return {
                label: kept ? "Remove Keep" : "Keep Message",
                icon: PrivacyIcon,
                message,
                channel,
                onClick: () => setKeepForMessage(message, !kept),
            };
        },
    },
    chatBarButton: {
        icon: PrivacyIcon,
        render: PrivacyChatButton,
    },
    flux: {
        MESSAGE_CREATE({ message }: { message: Message; }) {
            const currentUser = UserStore.getCurrentUser();
            if (!currentUser || message.author.id !== currentUser.id) return;
            const timestamp = new Date(message.timestamp).getTime();
            if (!Number.isFinite(timestamp)) return;

            const selectedChannel = ChannelStore.getChannel(message.channel_id);
            const parentChannel = selectedChannel ? policyChannelFor(selectedChannel) : undefined;
            const inheritedParentId = parentChannel && parentChannel.id !== message.channel_id
                ? parentChannel.id
                : undefined;
            const state = readSyncedState();
            const policyChannelId = inheritedParentId && state.channels[inheritedParentId]?.policy.includeThreads
                ? inheritedParentId
                : message.channel_id;
            queueOwnMessage(policyChannelId, message.id, timestamp, message.channel_id);
        },
        GUILD_CREATE({ guild }: { guild: Guild & { channels?: Channel[]; }; }) {
            if (!registerNewId(knownGuildIds, guild.id)) return;
            if (!settings.store.autoApplyGuilds) return;
            markAutoManagedGuild(guild.id);
            writeSyncedState(setGuildEnabled(readSyncedState(), guild.id, true));
            for (const channel of guild.channels ?? []) applyTemplateToChannel(channel);
        },
        CHANNEL_CREATE({ channel }: { channel: Channel; }) {
            if (channel.guild_id) {
                if (readAutoManagedGuildIds().has(channel.guild_id)) applyTemplateToChannel(channel);
                return;
            }
            if (!registerNewId(knownPrivateChannelIds, channel.id)) return;
            applyTemplateToPrivateChannel(channel);
        },
    },
    start() {
        knownGuildIds = new Set(Object.keys(GuildStore.getGuilds()));
        knownPrivateChannelIds = new Set(PrivateChannelSortStore.getPrivateChannelIds());
        void startScheduler(settings.store.scanOnStartup);
    },
    stop: stopScheduler,
});
