import {Api, TelegramClient} from 'telegram';
import type {SortingConfig} from '../types/config';
import {MessageStorage} from './storage';
import {matchesVideo} from '../utils/video-matching';
import {formatDuration, getFileName, getFileSizeMB, getVideoDuration, normalizeFileName, sleep} from '../utils/helpers';

export interface VideoProcessorResult {
    processed: number;
    forwarded: number;
}

export interface VideoMetadata {
    fileName: string;
    normalizedName: string;
    duration: number | null;
    sizeMB: number;
}

export class VideoProcessor {
    constructor(
        private client: TelegramClient,
        private storage: MessageStorage,
        private sortConfig: SortingConfig
    ) {
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
                        this.storage.saveProcessedMessage(messageId);
                        continue;
                    }

                    const topicsToForward = this.getTopicsToForward(
                        videoMeta,
                        matchedStrings
                    );

                    if (topicsToForward.length === 0) {
                        console.log(`     ⏭️  Video already exists in all matching topics, skipping`);
                        this.storage.saveProcessedMessage(messageId);
                        continue;
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

                    this.storage.saveProcessedMessage(messageId);
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

        console.log(`  ✅ Finished processing source ${sourceId}`);
        return {processed, forwarded};
    }

    private extractVideoMetadata(message: any): VideoMetadata {
        const document = message.media?.document;
        const duration = getVideoDuration(document);
        const fileName = getFileName(document);
        const sizeMB = getFileSizeMB(document);
        const normalizedName = this.sortConfig.duplicateDetection?.normalizeFilenames !== false
            ? normalizeFileName(fileName)
            : fileName.toLowerCase();

        return {fileName, normalizedName, duration, sizeMB};
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

    private getTopicsToForward(
        videoMeta: VideoMetadata,
        matchedStrings: string[]
    ): string[] {
        const {fileName, normalizedName, duration, sizeMB} = videoMeta;
        const topicsToForward: string[] = [];

        for (const matchedString of matchedStrings) {
            const similarVideo = this.storage.findSimilarVideoInTopic(
                fileName,
                normalizedName,
                matchedString,
                duration || undefined,
                sizeMB,
                this.sortConfig.duplicateDetection
            );

            if (similarVideo) {
                console.log(`     ⏭️  Already exists in topic "${matchedString}": "${similarVideo.fileName}"`);
                if (duration && similarVideo.duration) {
                    console.log(`        ⏱️  Durations: ${formatDuration(duration)} vs ${formatDuration(similarVideo.duration)}`);
                }
                if (similarVideo.sizeMB) {
                    console.log(`        📏 Sizes: ${sizeMB.toFixed(2)} MB vs ${similarVideo.sizeMB.toFixed(2)} MB`);
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
