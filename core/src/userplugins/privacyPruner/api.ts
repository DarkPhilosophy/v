import { Constants, RestAPI, SnowflakeUtils } from "@webpack/common";

import type { PrunableMessage, PruningApi } from "./engine";
import { parseChannelHistoryPage, parseMessageAroundPage, parseSearchPage } from "./history";
import { isArchivedThreadError } from "./guards";

export async function fetchMessageDetail(channelId: string, messageId: string): Promise<PrunableMessage> {
    const response = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query: { around: messageId, limit: 1 },
    });
    const message = parseMessageAroundPage(response.body, messageId);
    if (message == null) throw new Error("Discord did not return the requested message.");
    return message;
}

const temporarilyUnarchivedThreads = new Set<string>();


export const discordPruningApi: PruningApi = {
    async listOwnMessagesPage(input) {
        if (input.guildId == null) {
            const response = await RestAPI.get({
                url: Constants.Endpoints.MESSAGES(input.channelId),
                query: {
                    limit: 100,
                    before: input.beforeId ?? SnowflakeUtils.fromTimestamp(input.newestTimestamp),
                },
            });
            return parseChannelHistoryPage(response.body, input.userId, input.oldestTimestamp);
        }

        const response = await RestAPI.get({
            url: `/guilds/${input.guildId}/messages/search`,
            query: {
                author_id: input.userId,
                channel_id: input.channelId,
                limit: 25,
                min_id: SnowflakeUtils.fromTimestamp(input.oldestTimestamp),
                max_id: input.beforeId ?? SnowflakeUtils.fromTimestamp(input.newestTimestamp),
                sort_by: "timestamp",
                sort_order: "desc",
            },
        });
        return parseSearchPage(response.body, input.userId, input.channelId, input.includeThreads);
    },

    async deleteOwnMessage(channelId, messageId): Promise<void> {
        try {
            await RestAPI.del({ url: Constants.Endpoints.MESSAGE(channelId, messageId) });
        } catch (error) {
            if (!isArchivedThreadError(error)) throw error;

            const channelUrl = Constants.Endpoints.CHANNEL(channelId);
            await RestAPI.patch({ url: channelUrl, body: { archived: false } });
            temporarilyUnarchivedThreads.add(channelId);
            await RestAPI.del({ url: Constants.Endpoints.MESSAGE(channelId, messageId) });
        }
    },

    async finishDeletion(channelId): Promise<void> {
        if (!temporarilyUnarchivedThreads.delete(channelId)) return;
        await RestAPI.patch({
            url: Constants.Endpoints.CHANNEL(channelId),
            body: { archived: true },
        });
    },
};
