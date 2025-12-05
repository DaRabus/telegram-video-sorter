#!/usr/bin/env ts-node

import {Api, TelegramClient} from 'telegram';
import {ConfigLoader} from './services/configLoader';
import {TelegramClientFactory} from './services/telegramClient';
import {ForwardingLogger, MessageStorage} from './services/storage';
import {ForumService} from './services/forumService';
import {matchesVideo, shouldExcludeVideo} from './utils/videoMatching';
import {formatDuration, getFileName, getFileSizeMB, getVideoDuration, handleRateLimit, normalizeFileName, sleep} from './utils/helpers';
import path from "node:path";

class TelegramVideoSorter {
    private config: ConfigLoader;
    private readonly client: TelegramClient;
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
        if (sortConfig.maxVideoDurationInSeconds) {
            console.log(
                `⏱️  Maximum video duration: ${sortConfig.maxVideoDurationInSeconds}s (${formatDuration(sortConfig.maxVideoDurationInSeconds)})`
            );
        }
        if (sortConfig.minFileSizeMB) {
            console.log(`📏 Minimum file size: ${sortConfig.minFileSizeMB} MB`);
        }
        if (sortConfig.maxFileSizeMB) {
            console.log(`📏 Maximum file size: ${sortConfig.maxFileSizeMB} MB`);
        }
        console.log(`🎯 Max forwards per run: ${sortConfig.maxForwards}`);
        console.log(`🔍 Searching for: ${matches.join(', ')}`);
        console.log(`🚫 Excluding: ${exclusions.join(', ')}`);
        if (sortConfig.duplicateDetection?.checkDuration) {
            console.log(
                `🔄 Duplicate detection: Duration-based (tolerance: ${sortConfig.duplicateDetection.durationToleranceSeconds || 30}s)`
            );
        }
        if (sortConfig.duplicateDetection?.checkFileSize) {
            console.log(
                `🔄 Duplicate detection: Size-based (tolerance: ${sortConfig.duplicateDetection.fileSizeTolerancePercent || 5}%)`
            );
        }

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

        // Clean up forum group (removes excluded videos and duplicates)
        // Note: This runs BEFORE processing to clean existing duplicates
        // New duplicates are prevented by the storage system during processing
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
                    limit: 500,
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

                const matchedStrings =
                    'media' in message
                        ? matchesVideo(
                            message as any,
                            matches,
                            exclusions,
                            sortConfig.minVideoDurationInSeconds
                        )
                        : [];

                if (matchedStrings.length > 0 && 'media' in message) {
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
                    const sizeMB = getFileSizeMB(document);
                    const normalizedName = sortConfig.duplicateDetection?.normalizeFilenames !== false
                        ? normalizeFileName(fileName)
                        : fileName.toLowerCase();

                    // Check file size constraints
                    if (sortConfig.minFileSizeMB && sizeMB < sortConfig.minFileSizeMB) {
                        console.log(`  ⏭️  Skipping (too small): "${fileName}" (${sizeMB.toFixed(2)} MB < ${sortConfig.minFileSizeMB} MB)`);
                        this.storage.saveProcessedMessage(messageId);
                        continue;
                    }
                    if (sortConfig.maxFileSizeMB && sizeMB > sortConfig.maxFileSizeMB) {
                        console.log(`  ⏭️  Skipping (too large): "${fileName}" (${sizeMB.toFixed(2)} MB > ${sortConfig.maxFileSizeMB} MB)`);
                        this.storage.saveProcessedMessage(messageId);
                        continue;
                    }

                    // Check duration constraints
                    if (sortConfig.maxVideoDurationInSeconds && duration && duration > sortConfig.maxVideoDurationInSeconds) {
                        console.log(`  ⏭️  Skipping (too long): "${fileName}" (${formatDuration(duration)} > ${formatDuration(sortConfig.maxVideoDurationInSeconds)})`);
                        this.storage.saveProcessedMessage(messageId);
                        continue;
                    }

                    // Enhanced duplicate detection
                    const similarVideo = this.storage.findSimilarVideo(
                        fileName,
                        normalizedName,
                        duration || undefined,
                        sizeMB,
                        sortConfig.duplicateDetection
                    );

                    if (similarVideo) {
                        console.log(`  ⏭️  Found similar video: "${fileName}"`);
                        console.log(`     🔍 Matches: "${similarVideo.fileName}"`);
                        if (duration && similarVideo.duration) {
                            console.log(`     ⏱️  Durations: ${formatDuration(duration)} vs ${formatDuration(similarVideo.duration)}`);
                        }
                        if (similarVideo.sizeMB) {
                            console.log(`     📏 Sizes: ${sizeMB.toFixed(2)} MB vs ${similarVideo.sizeMB.toFixed(2)} MB`);
                        }
                        this.storage.saveProcessedMessage(messageId);
                        continue;
                    }

                    console.log(`  ✨ Matches found: ${matchedStrings.join(', ')}`);
                    console.log(`     📹 File: ${fileName}`);
                    console.log(
                        `     ⏱️  Duration: ${duration ? formatDuration(duration) : 'unknown'}`
                    );
                    console.log(`     📏 Size: ${sizeMB.toFixed(2)} MB`);

                    // Forward to ALL matching topics in parallel
                    if (!sortConfig.dryRun && forumGroupId) {
                        const forwardPromises = matchedStrings.map(matchedString => {
                            const targetTopicId = topicIds[matchedString];
                            console.log(
                                `     🎯 Target: Topic "${matchedString}" (ID: ${targetTopicId})`
                            );
                            return this.forwardMessage(
                                sourceId,
                                message.id,
                                forumGroupId,
                                targetTopicId,
                                fileName,
                                matchedString,
                                duration ?? 0,
                                sizeMB,
                                false // Don't save metadata yet
                            ).then(success => ({success, matchedString}));
                        });

                        // Wait for all forwards to complete
                        const results = await Promise.all(forwardPromises);
                        const allSucceeded = results.every(r => r.success);

                        // Update stats for successful forwards
                        for (const {success, matchedString} of results) {
                            if (success) {
                                forwardStats[matchedString] = (forwardStats[matchedString] ?? 0) + 1;
                            }
                        }

                        if (allSucceeded) {
                            forwarded++;
                            // Only save video metadata once after all forwards succeed
                            this.storage.saveProcessedVideoName(fileName, duration || undefined, sizeMB, normalizedName);
                        }
                    } else if (sortConfig.dryRun) {
                        for (const matchedString of matchedStrings) {
                            const targetTopicId = topicIds[matchedString];
                            console.log(
                                `     🔍 [DRY RUN] Would forward to topic "${matchedString}" (ID: ${targetTopicId})`
                            );
                            forwardStats[matchedString] = (forwardStats[matchedString] ?? 0) + 1;
                        }
                        forwarded++;
                        this.storage.saveProcessedVideoName(fileName, duration || undefined, sizeMB, normalizedName);
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
        sizeMB: number,
        saveMetadata: boolean = true
    ): Promise<boolean> {
        let retryCount = 0;
        let success = false;
        const sortConfig = this.config.getConfig();
        const normalizedName = sortConfig.duplicateDetection?.normalizeFilenames !== false
            ? normalizeFileName(fileName)
            : fileName.toLowerCase();

        while (!success && retryCount <= 3) {
            try {
                const channelPeer = new Api.PeerChannel({
                    channelId: BigInt(Math.abs(forumGroupId)) as any
                });

                await this.client.invoke(
                    new Api.messages.ForwardMessages({
                        fromPeer: sourceId,
                        id: [messageId],
                        toPeer: channelPeer,
                        topMsgId: targetTopicId,
                        randomId: [Math.floor(Math.random() * 1e16) as any]
                    })
                );

                console.log(`     ✅ Forwarded to "${matchedKeyword}"`);

                this.logger.logForwardedVideo({
                    timestamp: new Date().toISOString(),
                    fileName,
                    matchedKeyword,
                    topicName: matchedKeyword,
                    sourceGroup: sourceId,
                    duration,
                    sizeMB: Number(sizeMB.toFixed(2))
                });

                // Only save metadata if requested (to avoid duplicate saves)
                if (saveMetadata) {
                    this.storage.saveProcessedVideoName(fileName, duration, sizeMB, normalizedName);
                }
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
