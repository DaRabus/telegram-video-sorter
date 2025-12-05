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
        exclusions: string[]
    ): Promise<CleanupResult> {
        console.log('\n🧹 Scanning forum group for excluded videos and duplicates...');

        let totalExcluded = 0;
        let totalDuplicates = 0;

        try {
            let offsetId = 0;
            let hasMore = true;
            const videosByFilename = new Map<string, number[]>();

            while (hasMore) {
                const result = await this.client.invoke(
                    new Api.messages.GetHistory({
                        peer: groupId,
                        offsetId,
                        limit: 100,
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

                        if (!fileName) continue;

                        const normalizedFileName = fileName.toLowerCase();

                        if (shouldExcludeVideo(messageText, fileName, exclusions)) {
                            totalExcluded += await this.deleteExcludedVideo(message.id, fileName);
                            continue;
                        }

                        if (!videosByFilename.has(normalizedFileName)) {
                            videosByFilename.set(normalizedFileName, []);
                        }
                        videosByFilename.get(normalizedFileName)?.push(message.id);
                    }
                }

                if (messages.length > 0) {
                    const lastMessage = messages.at(-1);
                    if (lastMessage) offsetId = lastMessage.id;
                } else {
                    hasMore = false;
                }

                await sleep(1500);
            }

            // Clean up duplicates
            totalDuplicates = await this.cleanDuplicates(videosByFilename);

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

    private async cleanDuplicates(videosByFilename: Map<string, number[]>): Promise<number> {
        let totalDuplicates = 0;

        for (const [fileName, messageIds] of videosByFilename.entries()) {
            if (messageIds.length > 1) {
                const toDelete = messageIds.slice(1);
                console.log(
                    `  🔄 Found ${messageIds.length} copies of "${fileName}", removing ${toDelete.length}...`
                );

                if (!this.sortConfig.dryRun) {
                    try {
                        await this.client.invoke(
                            new Api.messages.DeleteMessages({
                                id: toDelete,
                                revoke: true
                            })
                        );
                        totalDuplicates += toDelete.length;
                    } catch (error) {
                        console.error(`  ❌ Error removing duplicates:`, error);
                    }
                } else {
                    console.log(`  🔍 [DRY RUN] Would remove ${toDelete.length} duplicates`);
                    totalDuplicates += toDelete.length;
                }

                await sleep(1000);
            }
        }

        return totalDuplicates;
    }
}
