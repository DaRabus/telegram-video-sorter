import {Api, TelegramClient} from 'telegram';
import type {SortingConfig} from '../types/config';
import {getFileName, sleep} from '../utils/helpers';
import {shouldExcludeVideo} from '../utils/video-matching';

export interface CleanupResult {
    totalExcluded: number;
    totalDuplicates: number;
}

export class ForumCleaner {
    constructor(
        private client: TelegramClient,
        private sortConfig: SortingConfig
    ) {
    }

    async cleanupForumGroup(
        groupId: number,
        exclusions: string[],
        skipCleanup: boolean = false
    ): Promise<CleanupResult> {
        // Skip cleanup if disabled or in dry run with no exclusions
        if (skipCleanup) {
            console.log('\n⏭️  Skipping forum cleanup (disabled)');
            return {totalExcluded: 0, totalDuplicates: 0};
        }
        
        console.log('\n🧹 Scanning forum group for excluded videos and duplicates...');

        let totalExcluded = 0;
        let totalDuplicates = 0;

        try {
            let offsetId = 0;
            let hasMore = true;
            // Track videos per topic: Map<topicId, Map<normalizedFileName, messageIds[]>>
            const videosByTopic = new Map<number, Map<string, number[]>>();

            while (hasMore) {
                const result = await this.client.invoke(
                    new Api.messages.GetHistory({
                        peer: groupId,
                        offsetId,
                        limit: 100,  // Telegram API limit
                        addOffset: 0,
                        maxId: 0,
                        minId: 0,
                        hash: 0 as any
                    })
                );
                console.log(`🔍 Fetching messages from group: ${groupId} (offset: ${offsetId})`);

                const messages =
                    'messages' in result && Array.isArray(result.messages)
                        ? result.messages
                        : [];

                if (messages.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const message of messages) {
                    if ('media' in message && message.media) {
                        const document = (message as any).media?.document;
                        const fileName = getFileName(document);
                        const messageText = 'message' in message ? (message.message ?? '') : '';
                        // Get topic ID from reply_to if available (forum messages have this)
                        const topicId = (message as any).replyTo?.replyToTopId ?? 0;

                        if (!fileName) continue;

                        const normalizedFileName = fileName.toLowerCase();

                        if (shouldExcludeVideo(messageText, fileName, exclusions)) {
                            totalExcluded += await this.deleteExcludedVideo(message.id, fileName);
                            continue;
                        }

                        // Track by topic
                        if (!videosByTopic.has(topicId)) {
                            videosByTopic.set(topicId, new Map());
                        }
                        const topicVideos = videosByTopic.get(topicId)!;
                        
                        if (!topicVideos.has(normalizedFileName)) {
                            topicVideos.set(normalizedFileName, []);
                        }
                        topicVideos.get(normalizedFileName)?.push(message.id);
                    }
                }

                if (messages.length > 0) {
                    const lastMessage = messages.at(-1);
                    if (lastMessage) offsetId = lastMessage.id;
                } else {
                    hasMore = false;
                }

                await sleep(500);
            }

            // Clean up duplicates per topic
            totalDuplicates = await this.cleanDuplicatesPerTopic(videosByTopic);

            console.log('\n✅ Cleanup complete:');
            console.log(`   Excluded videos removed: ${totalExcluded}`);
            console.log(`   Duplicate videos removed: ${totalDuplicates}`);
        } catch (error) {
            console.error('❌ Error during cleanup:', error);
        }

        return {totalExcluded, totalDuplicates};
    }

    private async deleteExcludedVideo(messageId: number, fileName: string): Promise<number> {
        console.log(`  🚫 Removing excluded video: "${fileName}"`);

        if (!this.sortConfig.dryRun) {
            try {
                await this.client.invoke(
                    new Api.messages.DeleteMessages({
                        id: [messageId],
                        revoke: true
                    })
                );
                return 1;
            } catch (error) {
                console.error(`  ❌ Error removing excluded video:`, error);
                return 0;
            }
        } else {
            console.log(`  🔍 [DRY RUN] Would remove excluded video`);
            return 1;
        }
    }

    private async cleanDuplicatesPerTopic(videosByTopic: Map<number, Map<string, number[]>>): Promise<number> {
        let totalDuplicates = 0;
        
        // Collect all IDs to delete in batches for efficiency
        const allToDelete: number[] = [];
        
        for (const [topicId, videosByFilename] of videosByTopic.entries()) {
            for (const [fileName, messageIds] of videosByFilename.entries()) {
                if (messageIds.length > 1) {
                    const toDelete = messageIds.slice(1);
                    console.log(
                        `  🔄 Topic ${topicId}: Found ${messageIds.length} copies of "${fileName}", removing ${toDelete.length}...`
                    );
                    allToDelete.push(...toDelete);
                    totalDuplicates += toDelete.length;
                }
            }
        }
        
        if (allToDelete.length === 0) {
            return 0;
        }
        
        if (!this.sortConfig.dryRun) {
            // Delete in batches of 100 (Telegram limit)
            const batchSize = 100;
            for (let i = 0; i < allToDelete.length; i += batchSize) {
                const batch = allToDelete.slice(i, i + batchSize);
                try {
                    await this.client.invoke(
                        new Api.messages.DeleteMessages({
                            id: batch,
                            revoke: true
                        })
                    );
                    console.log(`  🗑️  Deleted batch of ${batch.length} duplicates`);
                } catch (error) {
                    console.error(`  ❌ Error removing duplicates batch:`, error);
                }
                
                if (i + batchSize < allToDelete.length) {
                    await sleep(200);
                }
            }
        } else {
            console.log(`  🔍 [DRY RUN] Would remove ${allToDelete.length} total duplicates`);
        }

        return totalDuplicates;
    }
}
