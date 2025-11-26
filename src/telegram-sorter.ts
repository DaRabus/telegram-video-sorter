#!/usr/bin/env ts-node

import {Api, TelegramClient} from 'telegram';
import {ConfigLoader} from './services/configLoader';
import {TelegramClientFactory} from './services/telegramClient';
import {ForwardingLogger, MessageStorage} from './services/storage';
import {ForumService} from './services/forumService';
import {matchesVideo, shouldExcludeVideo} from './utils/videoMatching';
import {formatDuration, getFileName, getVideoDuration, handleRateLimit, sleep} from './utils/helpers';
import path from "node:path";

class TelegramVideoSorter {
    private config: ConfigLoader;
    private client: TelegramClient;
    private storage: MessageStorage;
    private logger: ForwardingLogger;
    private forumService: ForumService;

    constructor() {
        this.config = new ConfigLoader();
        const paths = this.config.getPaths();
        const sortConfig = this.config.getConfig();

        this.client = TelegramClientFactory.createClient(
            path.join(process.cwd(), "/session/", sortConfig.sessionFile)
        );
        this.storage = new MessageStorage(paths.processedLogFile);
        this.logger = new ForwardingLogger(paths.forwardingLogFile);
        this.forumService = new ForumService(this.client, paths.forumGroupCache, sortConfig.dryRun);
    }

    async run(): Promise<void> {
        const sortConfig = this.config.getConfig();
        const matches = this.config.getMatches();
        const exclusions = this.config.getExclusions();

        console.log('🚀 Starting Telegram Video Sorter...');
        console.log(
            `📋 Dry run mode: ${sortConfig.dryRun ? 'ON (no messages will be forwarded)' : 'OFF'}`
        );
        console.log(
            `⏱️  Minimum video duration: ${sortConfig.minVideoDurationInSeconds}s (${formatDuration(sortConfig.minVideoDurationInSeconds)})`
        );
        console.log(`🎯 Max forwards per run: ${sortConfig.maxForwards}`);
        console.log(`🔍 Searching for: ${matches.join(', ')}`);
        console.log(`🚫 Excluding: ${exclusions.join(', ')}`);

        await this.client.connect();
        console.log('✅ Connected to Telegram');

        this.storage.loadProcessedMessages();
        this.storage.loadProcessedVideoNames();
        console.log(
            `📝 Loaded ${this.storage.getProcessedMessagesCount()} previously processed messages`
        );
        console.log(
            `📝 Loaded ${this.storage.getProcessedVideoNamesCount()} previously processed video names`
        );

        // Create/load forum group and topics
        console.log('\n📂 Preparing forum group and topics...');
        const forumGroupId = await this.forumService.getOrCreateForumGroup(sortConfig.sortedGroupName);

        // Create topics for each match string
        const topicIds: Record<string, number> = {};
        for (const matchString of matches) {
            topicIds[matchString] = await this.forumService.getOrCreateTopic(forumGroupId, matchString);
        }

        // Clean up forum group
        await this.cleanupForumGroup(forumGroupId, exclusions);

        // Process videos
        const stats = await this.processVideos(forumGroupId, topicIds, matches, exclusions, sortConfig);

        // Print summary
        this.printSummary(stats, sortConfig.dryRun);

        await this.client.disconnect();
        console.log('👋 Disconnected from Telegram');
    }

    private async cleanupForumGroup(groupId: number, exclusions: string[]): Promise<void> {
        console.log('\n🧹 Scanning forum group for excluded videos and duplicates...');

        let totalExcluded = 0;
        let totalDuplicates = 0;
        const sortConfig = this.config.getConfig();

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
                            console.log(`  🚫 Removing excluded video: "${fileName}"`);

                            if (!sortConfig.dryRun) {
                                try {
                                    await this.client.invoke(
                                        new Api.messages.DeleteMessages({
                                            id: [message.id],
                                            revoke: true
                                        })
                                    );
                                    totalExcluded++;
                                } catch (error) {
                                    console.error(`  ❌ Error removing excluded video:`, error);
                                }
                            } else {
                                console.log(`  🔍 [DRY RUN] Would remove excluded video`);
                                totalExcluded++;
                            }
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
            for (const [fileName, messageIds] of videosByFilename.entries()) {
                if (messageIds.length > 1) {
                    const toDelete = messageIds.slice(1);
                    console.log(
                        `  🔄 Found ${messageIds.length} copies of "${fileName}", removing ${toDelete.length}...`
                    );

                    if (!sortConfig.dryRun) {
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

            console.log('\n✅ Cleanup complete:');
            console.log(`   Excluded videos removed: ${totalExcluded}`);
            console.log(`   Duplicate videos removed: ${totalDuplicates}`);
        } catch (error) {
            console.error('❌ Error during cleanup:', error);
        }
    }

    private async processVideos(
        forumGroupId: number,
        topicIds: Record<string, number>,
        matches: string[],
        exclusions: string[],
        sortConfig: any
    ): Promise<{ totalProcessed: number; totalForwarded: number; forwardStats: Record<string, number> }> {
        let totalProcessed = 0;
        let totalForwarded = 0;
        const forwardStats: Record<string, number> = {};

        const sourceGroups = sortConfig.sourceGroups ?? [];
        const useAllGroups = !sortConfig.sourceGroups || sortConfig.sourceGroups.length === 0;

        let dialogsToProcess;
        if (useAllGroups) {
            dialogsToProcess = await this.getAccessibleDialogs();
            console.log(`\n🌐 Processing ALL accessible groups/channels...`);
        } else {
            console.log(`\n📋 Processing ${sourceGroups.length} specified groups...`);
            dialogsToProcess = sourceGroups.map((id: any) => ({entity: {id}}));
        }

        for (const dialog of dialogsToProcess) {
            if (totalForwarded >= sortConfig.maxForwards) {
                console.log(
                    `\n⚠️  Reached maximum forwards limit (${sortConfig.maxForwards}), stopping...`
                );
                break;
            }

            const sourceId = useAllGroups ? dialog.entity?.id : dialog.entity.id;
            if (!sourceId) continue;

            console.log(`\n📂 Processing source: ${sourceId}`);

            try {
                const result = await this.processSource(
                    sourceId,
                    forumGroupId,
                    topicIds,
                    matches,
                    exclusions,
                    sortConfig,
                    totalForwarded,
                    forwardStats
                );

                totalProcessed += result.processed;
                totalForwarded = result.forwarded;
            } catch (error) {
                console.error(`  ❌ Error processing source ${sourceId}:`, error);
            }
        }

        return {totalProcessed, totalForwarded, forwardStats};
    }

    private async processSource(
        sourceId: number,
        forumGroupId: number,
        topicIds: Record<string, number>,
        matches: string[],
        exclusions: string[],
        sortConfig: any,
        totalForwarded: number,
        forwardStats: Record<string, number>
    ): Promise<{ processed: number; forwarded: number }> {
        let processed = 0;
        let forwarded = totalForwarded;
        let offsetId = 0;
        let hasMore = true;
        let batchCount = 0;

        while (hasMore) {
            const result = await this.client.invoke(
                new Api.messages.GetHistory({
                    peer: sourceId,
                    offsetId,
                    limit: 100,
                    addOffset: 0,
                    maxId: 0,
                    minId: 0,
                    hash: 0 as any
                })
            );

            const messages =
                'messages' in result && Array.isArray(result.messages)
                    ? result.messages
                    : [];

            if (messages.length === 0) {
                hasMore = false;
                break;
            }

            batchCount++;
            console.log(`  📦 Batch ${batchCount}: Processing ${messages.length} messages...`);

            for (const message of messages) {
                const messageId = `${sourceId}_${message.id}`;

                if (this.storage.hasProcessedMessage(messageId)) {
                    continue;
                }

                processed++;

                const matchedString =
                    'media' in message
                        ? matchesVideo(
                            message as any,
                            matches,
                            exclusions,
                            sortConfig.minVideoDurationInSeconds
                        )
                        : null;

                if (matchedString && 'media' in message) {
                    if (forwarded >= sortConfig.maxForwards) {
                        console.log(
                            `\n⚠️  Reached maximum forwards limit (${sortConfig.maxForwards}), stopping...`
                        );
                        hasMore = false;
                        break;
                    }

                    const document = (message as any).media?.document;
                    const duration = getVideoDuration(document);
                    const fileName = getFileName(document);
                    const size = Number.parseInt(document?.size ?? '0', 10);

                    if (this.storage.isVideoDuplicate(fileName)) {
                        console.log(`  ⏭️  Found duplicate: "${fileName}" (already processed)`);
                        await this.cleanDuplicatesInForumGroup(forumGroupId, fileName);
                        this.storage.saveProcessedMessage(messageId);
                        continue;
                    }

                    console.log(`  ✨ Match found: "${matchedString}"`);
                    console.log(`     📹 File: ${fileName}`);
                    console.log(
                        `     ⏱️  Duration: ${duration ? formatDuration(duration) : 'unknown'}`
                    );
                    console.log(`     📏 Size: ${(size / 1024 / 1024).toFixed(2)} MB`);

                    const targetTopicId = topicIds[matchedString];
                    console.log(
                        `     🎯 Target: Forum group ${forumGroupId}, Topic ${targetTopicId}`
                    );

                    if (!sortConfig.dryRun && forumGroupId && targetTopicId) {
                        const success = await this.forwardMessage(
                            sourceId,
                            message.id,
                            forumGroupId,
                            targetTopicId,
                            fileName,
                            matchedString,
                            duration ?? 0,
                            size
                        );

                        if (success) {
                            forwarded++;
                            forwardStats[matchedString] = (forwardStats[matchedString] ?? 0) + 1;
                        }
                    } else if (sortConfig.dryRun) {
                        console.log(
                            `     🔍 [DRY RUN] Would forward to forum group ${forumGroupId}, topic ${targetTopicId}`
                        );
                        forwardStats[matchedString] = (forwardStats[matchedString] ?? 0) + 1;
                        forwarded++;
                        this.storage.saveProcessedVideoName(fileName);
                    }

                    this.storage.saveProcessedMessage(messageId);
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

        console.log(`  ✅ Finished processing source ${sourceId}`);
        return {processed, forwarded};
    }

    private async forwardMessage(
        sourceId: number,
        messageId: number,
        forumGroupId: number,
        targetTopicId: number,
        fileName: string,
        matchedKeyword: string,
        duration: number,
        size: number
    ): Promise<boolean> {
        let retryCount = 0;
        let success = false;

        while (!success && retryCount <= 3) {
            try {
                await this.client.invoke(
                    new Api.messages.ForwardMessages({
                        fromPeer: sourceId,
                        id: [messageId],
                        toPeer: forumGroupId,
                        topMsgId: targetTopicId,
                        randomId: [Math.floor(Math.random() * 1e16) as any]
                    })
                );

                console.log(`     ✅ Forwarded successfully`);

                this.logger.logForwardedVideo({
                    timestamp: new Date().toISOString(),
                    fileName,
                    matchedKeyword,
                    topicName: matchedKeyword,
                    sourceGroup: sourceId,
                    duration,
                    sizeMB: Number((size / 1024 / 1024).toFixed(2))
                });

                this.storage.saveProcessedVideoName(fileName);
                success = true;
            } catch (error) {
                const shouldRetry = await handleRateLimit(error, retryCount);
                if (shouldRetry) {
                    retryCount++;
                } else {
                    console.error(`     ❌ Error forwarding message:`, error);
                    break;
                }
            }
        }

        return success;
    }

    private async cleanDuplicatesInForumGroup(groupId: number, fileName: string): Promise<void> {
        console.log(`  🔍 Checking for duplicates of "${fileName}" in forum group...`);

        try {
            const result = await this.client.invoke(
                new Api.messages.GetHistory({
                    peer: groupId,
                    offsetId: 0,
                    limit: 100,
                    addOffset: 0,
                    maxId: 0,
                    minId: 0,
                    hash: 0 as any
                })
            );

            const messages =
                'messages' in result && Array.isArray(result.messages)
                    ? result.messages
                    : [];

            const duplicates: number[] = [];
            const normalizedFileName = fileName.toLowerCase();

            for (const message of messages) {
                if ('media' in message && message.media) {
                    const document = (message as any).media?.document;
                    const msgFileName = getFileName(document);

                    if (msgFileName.toLowerCase() === normalizedFileName) {
                        duplicates.push(message.id);
                    }
                }
            }

            if (duplicates.length > 1) {
                const toDelete = duplicates.slice(1);
                console.log(
                    `  ⚠️  Found ${duplicates.length} copies of "${fileName}", removing ${toDelete.length}...`
                );

                const sortConfig = this.config.getConfig();
                if (!sortConfig.dryRun) {
                    try {
                        await this.client.invoke(
                            new Api.messages.DeleteMessages({
                                id: toDelete,
                                revoke: true
                            })
                        );
                        console.log(`  ✅ Removed ${toDelete.length} duplicate(s) of "${fileName}"`);
                    } catch (error) {
                        console.error(`  ❌ Error removing duplicates:`, error);
                    }
                } else {
                    console.log(`  🔍 [DRY RUN] Would remove ${toDelete.length} duplicate(s)`);
                }
            } else {
                console.log(`  ✅ No duplicates found for "${fileName}"`);
            }
        } catch (error) {
            console.error(`  ❌ Error checking for duplicates:`, error);
        }
    }

    private async getAccessibleDialogs() {
        console.log('🔍 Fetching all accessible chats...');
        const dialogs = await this.client.getDialogs({limit: 500});
        const groups = dialogs.filter((dialog) => dialog.isGroup || dialog.isChannel);
        console.log(`📊 Found ${groups.length} accessible groups/channels`);
        return groups;
    }

    private printSummary(
        stats: { totalProcessed: number; totalForwarded: number; forwardStats: Record<string, number> },
        dryRun: boolean
    ): void {
        console.log('\n' + '='.repeat(60));
        console.log('📊 Summary:');
        console.log(`   Total messages checked: ${stats.totalProcessed}`);
        console.log(`   Videos forwarded: ${stats.totalForwarded}`);
        console.log(`   Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
        console.log('\n   Breakdown by match:');
        for (const [match, count] of Object.entries(stats.forwardStats)) {
            console.log(`     ${match}: ${count} videos`);
        }
        console.log('='.repeat(60));
    }
}

// Run the script if executed directly
if (require.main === module) {
    const sorter = new TelegramVideoSorter();
    sorter.run().catch((error: Error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

export {TelegramVideoSorter};
