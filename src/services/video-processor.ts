import {Api, TelegramClient} from 'telegram';
import type {SortingConfig} from '../types/config';
import {MessageStorage} from './storage';
import {matchesVideo} from '../utils/video-matching';
import {formatDuration, getFileName, getFileSizeMB, getVideoDuration, getVideoResolution, getMimeType, normalizeFileName, sleep, handleRateLimit} from '../utils/helpers';

export interface VideoProcessorResult {
    processed: number;
    forwarded: number;
}

export interface VideoMetadata {
    fileName: string;
    normalizedName: string;
    duration: number | null;
    sizeMB: number;
    width?: number;
    height?: number;
    mimeType?: string;
}

export class VideoProcessor {
    // Cache topic messages to avoid repeated GetReplies API calls
    private topicMessageCache: Map<string, Map<number, any>> = new Map();

    constructor(
        private client: TelegramClient,
        private storage: MessageStorage,
        private sortConfig: SortingConfig
    ) {
    }

    /**
     * Clear the topic message cache. Call this when starting to process a new batch of sources.
     */
    clearTopicCache(): void {
        this.topicMessageCache.clear();
    }

    private async findAndDeleteDuplicatesInTopic(
        forumGroupId: number,
        topicId: number,
        topicName: string,
        videoMeta: VideoMetadata
    ): Promise<number> {
        // Find all duplicates in the topic
        const duplicates = this.storage.findAllSimilarVideosInTopic(
            videoMeta.fileName,
            videoMeta.normalizedName,
            topicName,
            videoMeta.duration || undefined,
            videoMeta.sizeMB,
            this.sortConfig.duplicateDetection,
            videoMeta.width,
            videoMeta.height,
            videoMeta.mimeType
        );

        if (duplicates.length === 0) {
            return 0;
        }

        console.log(`     🔍 Found ${duplicates.length} duplicate(s) in database for topic "${topicName}"`);

        // Use cached messages or fetch from Telegram
        const cacheKey = `${forumGroupId}_${topicId}`;
        let messageMap = this.topicMessageCache.get(cacheKey);

        if (!messageMap) {
            console.log(`     📥 Fetching messages from topic "${topicName}" (not cached)...`);
            messageMap = await this.fetchTopicMessages(forumGroupId, topicId);
            this.topicMessageCache.set(cacheKey, messageMap);
        } else {
            console.log(`     ✅ Using cached messages for topic "${topicName}" (${messageMap.size} messages)`);
        }

        // Find message IDs that still exist in Telegram and match our duplicates
        // IMPROVED: Match by name AND metadata (duration/size/resolution/mimeType) for precise duplicate identification
        const messageIdsToDelete: number[] = [];
        const durationTolerance = this.sortConfig.duplicateDetection?.durationToleranceSeconds || 30;
        const sizeTolerance = this.sortConfig.duplicateDetection?.fileSizeTolerancePercent || 5;
        const resolutionTolerance = this.sortConfig.duplicateDetection?.resolutionTolerancePercent || 10;
        
        for (const message of messageMap.values()) {
            if (!('media' in message) || !message.media) continue;

            const media = message.media as any;
            if (!media?.document) continue;

            const fileName = getFileName(media.document);
            const normalizedName = normalizeFileName(fileName);
            const msgDuration = getVideoDuration(media.document);
            const msgSizeMB = getFileSizeMB(media.document);
            const msgResolution = getVideoResolution(media.document);
            const msgMimeType = getMimeType(media.document);

            // Check if this message matches any of our duplicates (by name AND metadata)
            const isDuplicate = duplicates.some(d => {
                // Name must match
                if (d.normalizedName !== normalizedName) return false;
                
                // If duration check is enabled, verify duration match
                if (this.sortConfig.duplicateDetection?.checkDuration && msgDuration && d.duration) {
                    const durationDiff = Math.abs(msgDuration - d.duration);
                    if (durationDiff > durationTolerance) return false;
                }
                
                // If size check is enabled, verify size match
                if (this.sortConfig.duplicateDetection?.checkFileSize && msgSizeMB && d.sizeMB) {
                    const sizeDiff = Math.abs(msgSizeMB - d.sizeMB);
                    const sizePercentDiff = (sizeDiff / Math.max(msgSizeMB, d.sizeMB)) * 100;
                    if (sizePercentDiff > sizeTolerance) return false;
                }
                
                // If resolution check is enabled, verify resolution match
                if (this.sortConfig.duplicateDetection?.checkResolution && msgResolution && d.width && d.height) {
                    const pixels1 = msgResolution.width * msgResolution.height;
                    const pixels2 = d.width * d.height;
                    const pixelDiff = Math.abs(pixels1 - pixels2);
                    const pixelPercentDiff = (pixelDiff / Math.max(pixels1, pixels2)) * 100;
                    if (pixelPercentDiff > resolutionTolerance) return false;
                }
                
                // If MIME type check is enabled, verify MIME type match
                if (this.sortConfig.duplicateDetection?.checkMimeType && msgMimeType && d.mimeType) {
                    if (msgMimeType.toLowerCase() !== d.mimeType.toLowerCase()) return false;
                }
                
                return true;
            });
            
            if (isDuplicate) {
                messageIdsToDelete.push(message.id);
            }
        }

        if (messageIdsToDelete.length === 0) {
            console.log(`     ℹ️  No duplicate messages found in Telegram topic "${topicName}" (they may have been deleted already)`);
            // Clean up database entries for this specific topic
            const normalizedNames = duplicates.map(d => d.normalizedName);
            this.storage.deleteVideosFromTopic(normalizedNames, topicName);
            return 0;
        }

        console.log(`     🗑️  Deleting ${messageIdsToDelete.length} duplicate message(s) from topic "${topicName}"...`);

        // Delete messages from Telegram
        if (!this.sortConfig.dryRun) {
            try {
                await this.client.invoke(
                    new Api.channels.DeleteMessages({
                        channel: forumGroupId,
                        id: messageIdsToDelete
                    })
                );
                console.log(`     ✅ Deleted ${messageIdsToDelete.length} duplicate message(s) from topic "${topicName}"`);

                // Remove deleted messages from cache
                for (const msgId of messageIdsToDelete) {
                    messageMap.delete(msgId);
                }

                // Also delete from database (for this specific topic)
                const normalizedNames = duplicates.map(d => d.normalizedName);
                this.storage.deleteVideosFromTopic(normalizedNames, topicName);

                await sleep(500); // Wait after deletion
            } catch (error) {
                console.error(`     ❌ Error deleting messages:`, error);
                throw error;
            }
        } else {
            console.log(`     🔍 [DRY RUN] Would delete ${messageIdsToDelete.length} duplicate message(s)`);
        }

        return messageIdsToDelete.length;
    }

    /**
     * Fetch all messages from a topic and return them as a Map for quick lookup
     */
    private async fetchTopicMessages(
        forumGroupId: number,
        topicId: number
    ): Promise<Map<number, any>> {
        const messageMap = new Map<number, any>();
        let offsetId = 0;
        let hasMore = true;
        let batchCount = 0;
        const maxBatches = 50; // Limit to prevent infinite loops

        while (hasMore && batchCount < maxBatches) {
            batchCount++;
            let retryCount = 0;
            let success = false;

            while (!success && retryCount < 3) {
                try {
                    const result = await this.client.invoke(
                        new Api.messages.GetReplies({
                            peer: forumGroupId,
                            msgId: topicId,
                            offsetId,
                            limit: 100,
                            addOffset: 0,
                            maxId: 0,
                            minId: 0,
                            hash: BigInt(0) as any
                        })
                    );

                    const messages = 'messages' in result ? result.messages : [];
                    
                    if (messages.length === 0) {
                        hasMore = false;
                        break;
                    }

                    // Add to map
                    for (const msg of messages) {
                        if ('id' in msg) {
                            messageMap.set(msg.id, msg);
                        }
                    }

                    // Update offset for next batch
                    const lastMessage = messages.at(-1);
                    if (lastMessage && 'id' in lastMessage) {
                        offsetId = lastMessage.id;
                    } else {
                        hasMore = false;
                    }

                    success = true;
                } catch (error) {
                    const shouldRetry = await handleRateLimit(error, retryCount);
                    if (shouldRetry) {
                        retryCount++;
                        console.log(`     🔄 Retrying (attempt ${retryCount}/3)...`);
                    } else {
                        console.error(`     ❌ Error fetching topic messages:`, error);
                        hasMore = false;
                        break;
                    }
                }
            }

            // Rate limiting: Wait longer between batches
            if (hasMore && success) {
                await sleep(500); // Increased from 100ms to 500ms
            }
        }

        console.log(`     📊 Cached ${messageMap.size} messages from topic`);
        return messageMap;
    }

    async processSource(
        sourceId: number,
        forumGroupId: number,
        topicIds: Record<string, number>,
        matches: string[],
        exclusions: string[],
        totalForwarded: number,
        forwardStats: Record<string, number>,
        onForward: (
            sourceId: number,
            messageId: number,
            forumGroupId: number,
            targetTopicId: number,
            fileName: string,
            topicName: string,
            duration: number,
            sizeMB: number,
            normalizedName: string
        ) => Promise<boolean>
    ): Promise<VideoProcessorResult> {
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
                    limit: 100,  // Telegram API limit
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
            
            // Quick filter: only process messages with media
            const mediaMessages = messages.filter(m => 'media' in m && m.media);
            console.log(`  📦 Batch ${batchCount}: ${messages.length} messages (${mediaMessages.length} with media)`);

            for (const message of mediaMessages) {
                const messageId = `${sourceId}_${message.id}`;

                // Skip already processed - don't count these
                if (this.storage.hasProcessedMessage(messageId)) {
                    continue;
                }

                // CRITICAL FIX: Mark as processed IMMEDIATELY to prevent duplicate processing
                // in the same batch before the video is forwarded
                this.storage.saveProcessedMessage(messageId);

                const matchedStrings = matchesVideo(
                    message as any,
                    matches,
                    exclusions,
                    this.sortConfig.minVideoDurationInSeconds
                );
                
                processed++;

                if (matchedStrings.length > 0) {
                    if (forwarded >= this.sortConfig.maxForwards) {
                        console.log(
                            `\n⚠️  Reached maximum forwards limit (${this.sortConfig.maxForwards}), stopping...`
                        );
                        hasMore = false;
                        break;
                    }

                    const videoMeta = this.extractVideoMetadata(message);

                    if (!this.validateVideoConstraints(videoMeta)) {
                        continue;
                    }

                    // CRITICAL FIX: Pre-check if video already exists in ALL potential topics
                    // This catches duplicates that were just processed in this batch
                    const existingTopics: string[] = [];
                    const newTopics: string[] = [];
                    
                    for (const topic of matchedStrings) {
                        const existing = this.storage.findSimilarVideoInTopic(
                            videoMeta.fileName,
                            videoMeta.normalizedName,
                            topic,
                            videoMeta.duration || undefined,
                            videoMeta.sizeMB,
                            this.sortConfig.duplicateDetection,
                            videoMeta.width,
                            videoMeta.height,
                            videoMeta.mimeType
                        );
                        if (existing) {
                            existingTopics.push(topic);
                        } else {
                            newTopics.push(topic);
                        }
                    }

                    if (existingTopics.length > 0 && newTopics.length === 0) {
                        console.log(`     ⏭️  Video already exists in ALL matching topics (${existingTopics.join(', ')}), skipping: "${videoMeta.fileName}"`);
                        continue;
                    } else if (existingTopics.length > 0) {
                        console.log(`     ℹ️  Video exists in: ${existingTopics.join(', ')} | New topics: ${newTopics.join(', ')}`);
                    }

                    // CRITICAL FIX: Save to storage IMMEDIATELY for new topics to prevent race conditions
                    // This ensures that if another identical video comes in during async operations below,
                    // it will be caught by the duplicate check
                    if (!this.sortConfig.dryRun) {
                        for (const topic of newTopics) {
                            this.storage.saveProcessedVideoName(
                                videoMeta.fileName, 
                                topic, 
                                videoMeta.duration ?? undefined, 
                                videoMeta.sizeMB, 
                                videoMeta.normalizedName,
                                videoMeta.width,
                                videoMeta.height,
                                videoMeta.mimeType
                            );
                        }
                        console.log(`     💾 Pre-registered video in ${newTopics.length} topic(s) to prevent race conditions`);
                    }

                    const {topicsToForward, deletedCount} = await this.getTopicsToForwardWithDuplicateHandling(
                        forumGroupId,
                        topicIds,
                        videoMeta,
                        matchedStrings
                    );

                    if (topicsToForward.length === 0) {
                        console.log(`     ⏭️  No topics to forward to after duplicate handling`);
                        continue;
                    }

                    if (deletedCount > 0) {
                        console.log(`     ✨ Replaced ${deletedCount} duplicate(s), forwarding new version...`);
                    }

                    this.logVideoMatch(videoMeta, matchedStrings);

                    const forwardResult = await this.forwardToTopics(
                        sourceId,
                        message.id,
                        forumGroupId,
                        topicIds,
                        topicsToForward,
                        videoMeta,
                        forwardStats,
                        onForward
                    );

                    if (forwardResult) {
                        forwarded++;
                    }
                }
            }

            if (messages.length > 0) {
                const lastMessage = messages.at(-1);
                if (lastMessage) offsetId = lastMessage.id;
            } else {
                hasMore = false;
            }

            await sleep(500); // Increased from 100ms to 500ms for better rate limiting
        }

        console.log(`  ✅ Finished processing source ${sourceId}`);
        return {processed, forwarded};
    }

    private extractVideoMetadata(message: any): VideoMetadata {
        const document = message.media?.document;
        const duration = getVideoDuration(document);
        const fileName = getFileName(document);
        const sizeMB = getFileSizeMB(document);
        const resolution = getVideoResolution(document);
        const mimeType = getMimeType(document);
        const normalizedName = this.sortConfig.duplicateDetection?.normalizeFilenames !== false
            ? normalizeFileName(fileName)
            : fileName.toLowerCase();

        return {
            fileName, 
            normalizedName, 
            duration, 
            sizeMB,
            width: resolution?.width,
            height: resolution?.height,
            mimeType: mimeType || undefined
        };
    }

    private validateVideoConstraints(videoMeta: VideoMetadata): boolean {
        const {fileName, duration, sizeMB} = videoMeta;

        // Check file size constraints
        if (this.sortConfig.minFileSizeMB && sizeMB < this.sortConfig.minFileSizeMB) {
            console.log(`  ⏭️  Skipping (too small): "${fileName}" (${sizeMB.toFixed(2)} MB < ${this.sortConfig.minFileSizeMB} MB)`);
            return false;
        }
        if (this.sortConfig.maxFileSizeMB && sizeMB > this.sortConfig.maxFileSizeMB) {
            console.log(`  ⏭️  Skipping (too large): "${fileName}" (${sizeMB.toFixed(2)} MB > ${this.sortConfig.maxFileSizeMB} MB)`);
            return false;
        }

        // Check duration constraints
        if (this.sortConfig.maxVideoDurationInSeconds && duration && duration > this.sortConfig.maxVideoDurationInSeconds) {
            console.log(`  ⏭️  Skipping (too long): "${fileName}" (${formatDuration(duration)} > ${formatDuration(this.sortConfig.maxVideoDurationInSeconds)})`);
            return false;
        }

        return true;
    }

    private async getTopicsToForwardWithDuplicateHandling(
        forumGroupId: number,
        topicIds: Record<string, number>,
        videoMeta: VideoMetadata,
        matchedStrings: string[]
    ): Promise<{topicsToForward: string[], deletedCount: number}> {
        const {fileName, normalizedName, duration, sizeMB, width, height, mimeType} = videoMeta;
        const topicsToForward: string[] = [];
        let deletedCount = 0;

        for (const matchedString of matchedStrings) {
            const similarVideo = this.storage.findSimilarVideoInTopic(
                fileName,
                normalizedName,
                matchedString,
                duration || undefined,
                sizeMB,
                this.sortConfig.duplicateDetection,
                width,
                height,
                mimeType
            );

            if (similarVideo) {
                console.log(`     🔄 Duplicate exists in topic "${matchedString}": "${similarVideo.fileName}"`);
                if (duration && similarVideo.duration) {
                    console.log(`        ⏱️  Durations: ${formatDuration(duration)} vs ${formatDuration(similarVideo.duration)}`);
                }
                if (similarVideo.sizeMB) {
                    console.log(`        📏 Sizes: ${sizeMB.toFixed(2)} MB vs ${similarVideo.sizeMB.toFixed(2)} MB`);
                }
                if (width && height && similarVideo.width && similarVideo.height) {
                    console.log(`        📺 Resolutions: ${width}x${height} vs ${similarVideo.width}x${similarVideo.height}`);
                }
                if (mimeType && similarVideo.mimeType) {
                    console.log(`        🎬 MIME types: ${mimeType} vs ${similarVideo.mimeType}`);
                }
                
                // Delete the duplicates and then forward the new video
                const topicId = topicIds[matchedString];
                const deleted = await this.findAndDeleteDuplicatesInTopic(
                    forumGroupId,
                    topicId,
                    matchedString,
                    videoMeta
                );
                deletedCount += deleted;
                topicsToForward.push(matchedString);
            } else {
                topicsToForward.push(matchedString);
            }
        }

        return {topicsToForward, deletedCount};
    }

    // Legacy method kept for backward compatibility
    private getTopicsToForward(
        videoMeta: VideoMetadata,
        matchedStrings: string[]
    ): string[] {
        const {fileName, normalizedName, duration, sizeMB, width, height, mimeType} = videoMeta;
        const topicsToForward: string[] = [];

        for (const matchedString of matchedStrings) {
            const similarVideo = this.storage.findSimilarVideoInTopic(
                fileName,
                normalizedName,
                matchedString,
                duration || undefined,
                sizeMB,
                this.sortConfig.duplicateDetection,
                width,
                height,
                mimeType
            );

            if (similarVideo) {
                console.log(`     ⏭️  Already exists in topic "${matchedString}": "${similarVideo.fileName}"`);
                if (duration && similarVideo.duration) {
                    console.log(`        ⏱️  Durations: ${formatDuration(duration)} vs ${formatDuration(similarVideo.duration)}`);
                }
                if (similarVideo.sizeMB) {
                    console.log(`        📏 Sizes: ${sizeMB.toFixed(2)} MB vs ${similarVideo.sizeMB.toFixed(2)} MB`);
                }
                if (width && height && similarVideo.width && similarVideo.height) {
                    console.log(`        📺 Resolutions: ${width}x${height} vs ${similarVideo.width}x${similarVideo.height}`);
                }
                if (mimeType && similarVideo.mimeType) {
                    console.log(`        🎬 MIME types: ${mimeType} vs ${similarVideo.mimeType}`);
                }
            } else {
                topicsToForward.push(matchedString);
            }
        }

        return topicsToForward;
    }

    private logVideoMatch(videoMeta: VideoMetadata, matchedStrings: string[]): void {
        const {fileName, duration, sizeMB} = videoMeta;

        console.log(`  ✨ Matches found: ${matchedStrings.join(', ')}`);
        console.log(`     📹 File: ${fileName}`);
        console.log(`     ⏱️  Duration: ${duration ? formatDuration(duration) : 'unknown'}`);
        console.log(`     📏 Size: ${sizeMB.toFixed(2)} MB`);
    }

    private async forwardToTopics(
        sourceId: number,
        messageId: number,
        forumGroupId: number,
        topicIds: Record<string, number>,
        topicsToForward: string[],
        videoMeta: VideoMetadata,
        forwardStats: Record<string, number>,
        onForward: (
            sourceId: number,
            messageId: number,
            forumGroupId: number,
            targetTopicId: number,
            fileName: string,
            topicName: string,
            duration: number,
            sizeMB: number,
            normalizedName: string
        ) => Promise<boolean>
    ): Promise<boolean> {
        const {fileName, normalizedName, duration, sizeMB} = videoMeta;

        if (!this.sortConfig.dryRun && forumGroupId) {
            // Note: Video is already saved to storage earlier (before async operations)
            // to prevent race conditions during batch processing
            
            const forwardPromises = topicsToForward.map(matchedString => {
                const targetTopicId = topicIds[matchedString];
                console.log(`     🎯 Forwarding to topic "${matchedString}" (ID: ${targetTopicId})`);

                return onForward(
                    sourceId,
                    messageId,
                    forumGroupId,
                    targetTopicId,
                    fileName,
                    matchedString,
                    duration ?? 0,
                    sizeMB,
                    normalizedName
                ).then(success => ({success, matchedString}));
            });

            const results = await Promise.all(forwardPromises);
            const allSucceeded = results.every(r => r.success);

            for (const {success, matchedString} of results) {
                if (success) {
                    forwardStats[matchedString] = (forwardStats[matchedString] ?? 0) + 1;
                }
            }

            return allSucceeded;
        } else if (this.sortConfig.dryRun) {
            for (const matchedString of topicsToForward) {
                const targetTopicId = topicIds[matchedString];
                console.log(`     🔍 [DRY RUN] Would forward to topic "${matchedString}" (ID: ${targetTopicId})`);
                forwardStats[matchedString] = (forwardStats[matchedString] ?? 0) + 1;
            }
            return true;
        }

        return false;
    }
}
