import * as fs from 'node:fs';
import {Api, TelegramClient} from 'telegram';
import type {ForumGroupCache} from '../types/config';

export class ForumService {
    private forumCache: ForumGroupCache = {topics: {}};
    private readonly cacheFile: string;
    private client: TelegramClient;
    private readonly dryRun: boolean;

    constructor(client: TelegramClient, cacheFile: string, dryRun: boolean) {
        this.client = client;
        this.cacheFile = cacheFile;
        this.dryRun = dryRun;
        this.loadCache();
    }

    private loadCache(): void {
        if (fs.existsSync(this.cacheFile)) {
            try {
                this.forumCache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
            } catch (error) {
                console.error('Error loading forum cache:', error);
                this.forumCache = {topics: {}};
            }
        }
    }

    private saveCache(): void {
        fs.writeFileSync(this.cacheFile, JSON.stringify(this.forumCache, null, 2));
    }

    async getOrCreateForumGroup(groupName: string): Promise<number> {
        // Check cache first
        if (this.forumCache.groupId) {
            console.log(`  📂 Using cached forum group: ${this.forumCache.groupId}`);
            return this.forumCache.groupId;
        }

        if (this.dryRun) {
            console.log(`  🔍 [DRY RUN] Would search/create forum group "${groupName}"`);
            return -1;
        }

        // Search for existing forum group by name
        console.log(`  🔍 Searching for existing forum group "${groupName}"...`);
        const existingGroupId = await this.findForumGroupByName(groupName);

        if (existingGroupId) {
            console.log(`  ✅ Found existing forum group "${groupName}" with ID: ${existingGroupId}`);
            this.forumCache.groupId = existingGroupId;
            this.saveCache();
            return existingGroupId;
        }

        // Create new forum group if not found
        console.log(`  ✨ Forum group "${groupName}" not found, creating new one...`);

        try {
            const result = await this.client.invoke(
                new Api.channels.CreateChannel({
                    title: groupName,
                    about: 'Auto-sorted videos organized by topics',
                    megagroup: true,
                    forum: true
                })
            );

            let groupId: number;

            if ('chats' in result && result.chats.length > 0) {
                const chat = result.chats[0];
                if ('id' in chat) {
                    groupId = -Math.abs(Number(chat.id));
                } else {
                    throw new Error('Could not extract group ID from result');
                }
            } else {
                throw new Error('Group creation returned no chats');
            }

            this.forumCache.groupId = groupId;
            this.saveCache();

            console.log(`  ✅ Created forum group "${groupName}" with ID: ${groupId}`);
            return groupId;
        } catch (error) {
            console.error(`  ❌ Error creating forum group:`, error);
            throw error;
        }
    }

    private async findForumGroupByName(groupName: string): Promise<number | null> {
        try {
            console.log('     Fetching dialogs...');
            const dialogs = await this.client.getDialogs({limit: 500});

            const normalizedSearchName = groupName.toLowerCase().trim();

            for (const dialog of dialogs) {
                const entity = dialog.entity;

                // Check if it's a channel/supergroup with forum enabled
                if ('forum' in entity && entity.forum) {
                    const title = 'title' in entity ? entity.title : '';
                    const normalizedTitle = title.toLowerCase().trim();

                    if (normalizedTitle === normalizedSearchName) {
                        const id = 'id' in entity ? Number(entity.id) : null;
                        if (id) {
                            // Convert to the proper format (negative for channels/supergroups)
                            return -Math.abs(id);
                        }
                    }
                }
            }

            console.log(`     No existing forum group found with name "${groupName}"`);
            return null;
        } catch (error) {
            console.error('     ⚠️  Error searching for forum group:', error);
            return null;
        }
    }

    async getOrCreateTopic(groupId: number, matchString: string): Promise<number> {
        // Check cache first
        if (this.forumCache.topics[matchString]) {
            console.log(
                `  📂 Using cached topic for "${matchString}": ${this.forumCache.topics[matchString]}`
            );
            return this.forumCache.topics[matchString];
        }

        if (this.dryRun) {
            console.log(`  🔍 [DRY RUN] Would search/create topic "${matchString}"`);
            return -1;
        }

        // Search for existing topic by name
        console.log(`  🔍 Searching for existing topic "${matchString}"...`);
        const existingTopicId = await this.findTopicByName(groupId, matchString);

        if (existingTopicId) {
            console.log(`  ✅ Found existing topic "${matchString}" with ID: ${existingTopicId}`);
            this.forumCache.topics[matchString] = existingTopicId;
            this.saveCache();
            return existingTopicId;
        }

        // Create new topic if not found
        console.log(`  ✨ Topic "${matchString}" not found, creating new one...`);

        try {
            const channelPeer = new Api.PeerChannel({
                channelId: BigInt(Math.abs(groupId)) as any
            });

            const result = await this.client.invoke(
                new Api.channels.CreateForumTopic({
                    channel: channelPeer,
                    title: matchString,
                    randomId: BigInt(Math.floor(Math.random() * 1e16)) as any
                })
            );

            let topicId: number;

            if ('updates' in result) {
                const updates = Array.isArray(result.updates) ? result.updates : [];
                const messageUpdate = updates.find(
                    (update: any) => 'message' in update && 'id' in update.message
                );

                if (messageUpdate && 'message' in messageUpdate) {
                    topicId = Number((messageUpdate as any).message.id);
                } else {
                    throw new Error('Could not extract topic ID from result');
                }
            } else {
                throw new Error('Topic creation returned unexpected result');
            }

            this.forumCache.topics[matchString] = topicId;
            this.saveCache();

            console.log(`  ✅ Created topic "${matchString}" with ID: ${topicId}`);
            return topicId;
        } catch (error) {
            console.error(`  ❌ Error creating topic "${matchString}":`, error);
            throw error;
        }
    }

    private async findTopicByName(groupId: number, topicName: string): Promise<number | null> {
        try {
            const channelPeer = new Api.PeerChannel({
                channelId: BigInt(Math.abs(groupId)) as any
            });

            const result = await this.client.invoke(
                new Api.channels.GetForumTopics({
                    channel: channelPeer,
                    offsetDate: 0,
                    offsetId: 0,
                    offsetTopic: 0,
                    limit: 100
                })
            );

            const normalizedSearchName = topicName.toLowerCase().trim();

            if ('topics' in result && Array.isArray(result.topics)) {
                for (const topic of result.topics) {
                    if ('title' in topic) {
                        const normalizedTitle = topic.title.toLowerCase().trim();
                        if (normalizedTitle === normalizedSearchName && 'id' in topic) {
                            return Number(topic.id);
                        }
                    }
                }
            }

            console.log(`     No existing topic found with name "${topicName}"`);
            return null;
        } catch (error) {
            console.error(`     ⚠️  Error searching for topic "${topicName}":`, error);
            return null;
        }
    }
}
