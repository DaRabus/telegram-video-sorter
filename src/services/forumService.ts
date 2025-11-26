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
        if (this.forumCache.groupId) {
            console.log(`  📂 Using existing forum group: ${this.forumCache.groupId}`);
            return this.forumCache.groupId;
        }

        if (this.dryRun) {
            console.log(`  🔍 [DRY RUN] Would create forum group "sorted_all"`);
            return -1;
        }

        console.log(`  ✨ Creating forum group "sorted_all"...`);

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

            console.log(`  ✅ Created forum group "sorted_all" with ID: ${groupId}`);
            return groupId;
        } catch (error) {
            console.error(`  ❌ Error creating forum group:`, error);
            throw error;
        }
    }

    async getOrCreateTopic(groupId: number, matchString: string): Promise<number> {
        if (this.forumCache.topics[matchString]) {
            console.log(
                `  📂 Using existing topic for "${matchString}": ${this.forumCache.topics[matchString]}`
            );
            return this.forumCache.topics[matchString];
        }

        if (this.dryRun) {
            console.log(`  🔍 [DRY RUN] Would create topic "${matchString}"`);
            return -1;
        }

        console.log(`  ✨ Creating topic "${matchString}"...`);

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
}
