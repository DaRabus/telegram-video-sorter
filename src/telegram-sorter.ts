#!/usr/bin/env ts-node

import {TelegramClient} from 'telegram';
import path from 'node:path';
import {ConfigLoader} from './services/config-loader';
import {TelegramClientFactory} from './services/telegram-client';
import {ForwardingLogger, MessageStorage} from './services/storage';
import {ForumService} from './services/forum-service';
import {VideoProcessor} from './services/video-processor';
import {MessageForwarder} from './services/message-forwarder';
import {ForumCleaner} from './services/forum-cleaner';
import {ConsoleLogger} from './services/console-logger';

class TelegramVideoSorter {
    private config: ConfigLoader;
    private readonly client: TelegramClient;
    private storage: MessageStorage;
    private logger: ForwardingLogger;
    private forumService: ForumService;
    private videoProcessor: VideoProcessor;
    private messageForwarder: MessageForwarder;
    private forumCleaner: ForumCleaner;

    constructor() {
        this.config = new ConfigLoader();
        const paths = this.config.getPaths();
        const sortConfig = this.config.getConfig();

        this.client = TelegramClientFactory.createClient(
            path.join(process.cwd(), '/session/', sortConfig.sessionFile)
        );
        this.storage = new MessageStorage(paths.processedLogFile);
        this.logger = new ForwardingLogger(paths.forwardingLogFile);
        this.forumService = new ForumService(this.client, paths.forumGroupCache, sortConfig.dryRun);
        this.videoProcessor = new VideoProcessor(this.client, this.storage, sortConfig);
        this.messageForwarder = new MessageForwarder(this.client, this.storage, this.logger);
        this.forumCleaner = new ForumCleaner(this.client, sortConfig);
    }

    async run(): Promise<void> {
        const sortConfig = this.config.getConfig();
        const matches = this.config.getMatches();
        const exclusions = this.config.getExclusions();

        ConsoleLogger.logStartup(sortConfig, matches, exclusions);

        await this.client.connect();
        console.log('✅ Connected to Telegram');

        this.storage.loadProcessedMessages();
        this.storage.loadProcessedVideoNames();
        ConsoleLogger.logStorageStats(
            this.storage.getProcessedMessagesCount(),
            this.storage.getProcessedVideoNamesCount()
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
        await this.forumCleaner.cleanupForumGroup(forumGroupId, exclusions);

        // Process videos
        const stats = await this.processVideos(forumGroupId, topicIds, matches, exclusions, sortConfig);

        // Print summary
        ConsoleLogger.logSummary(stats, sortConfig.dryRun);

        // Close database connection
        this.storage.close();

        await this.client.disconnect();
        console.log('👋 Disconnected from Telegram');
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

        // Always fetch all accessible dialogs first
        const allDialogs = await this.getAccessibleDialogs();

        let dialogsToProcess;
        if (useAllGroups) {
            dialogsToProcess = allDialogs;
            console.log(`\n🌐 Processing ALL accessible groups/channels...`);
        } else {
            // Filter dialogs based on specified source IDs
            console.log(`\n📋 Processing ${sourceGroups.length} specified groups...`);

            // Convert string IDs to numbers and create a Set for faster lookup
            const specifiedIds = new Set(
                sourceGroups.map((id: string | number) => {
                    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
                    // Store absolute value for matching
                    return Math.abs(numId);
                })
            );

            dialogsToProcess = allDialogs.filter(dialog => {
                const entityId = dialog.entity?.id;
                if (!entityId) return false;

                const absId = Math.abs(Number(entityId));
                return specifiedIds.has(absId);
            });

            console.log(`  ✅ Found ${dialogsToProcess.length} matching groups/channels from your list`);

            if (dialogsToProcess.length === 0) {
                console.warn(`  ⚠️  WARNING: None of the specified source IDs were found in accessible dialogs!`);
                console.warn(`      Make sure you have access to these groups/channels and the IDs are correct.`);
            }
        }

        for (const dialog of dialogsToProcess) {
            if (totalForwarded >= sortConfig.maxForwards) {
                console.log(
                    `\n⚠️  Reached maximum forwards limit (${sortConfig.maxForwards}), stopping...`
                );
                break;
            }

            const sourceEntity = dialog.entity;
            const sourceId = sourceEntity?.id;

            if (!sourceEntity || !sourceId) {
                console.warn(`  ⚠️  Skipping invalid source entity`);
                continue;
            }

            const dialogTitle = dialog.title || 'Unknown';
            console.log(`\n📂 Processing source: ${sourceId} (${sourceEntity.className || 'Unknown type'}) - "${dialogTitle}"`);

            try {
                const result = await this.videoProcessor.processSource(
                    sourceEntity,
                    forumGroupId,
                    topicIds,
                    matches,
                    exclusions,
                    totalForwarded,
                    forwardStats,
                    this.messageForwarder.forwardMessage.bind(this.messageForwarder)
                );

                totalProcessed += result.processed;
                totalForwarded = result.forwarded;
            } catch (error) {
                console.error(`  ❌ Error processing source ${sourceId}:`, error);
            }
        }

        return {totalProcessed, totalForwarded, forwardStats};
    }

    private async getAccessibleDialogs() {
        console.log('🔍 Fetching all accessible chats...');
        const dialogs = await this.client.getDialogs({limit: 500});
        const groups = dialogs.filter((dialog) => dialog.isGroup || dialog.isChannel);
        console.log(`📊 Found ${groups.length} accessible groups/channels`);
        console.log("\n📝 Available groups/channels with IDs:");

        const groupDetails = groups.map((dialog) => {
            const groupName = dialog.title ?? 'Unknown';
            const entity = dialog.entity;

            // Extract the correct ID based on entity type
            let groupId: string | undefined;
            if (entity && 'id' in entity) {
                const rawId = entity.id;
                // For channels and megagroups, convert to negative ID format
                if ('className' in entity &&
                    (entity.className === 'Channel' || entity.className === 'Chat')) {
                    // Convert BigInt to string if necessary
                    const idValue = typeof rawId === 'bigint' ? Number(rawId) : rawId;
                    // Telegram uses negative IDs for groups/channels in some contexts
                    groupId = (-Math.abs(Number(idValue))).toString();
                } else {
                    groupId = rawId.toString();
                }
            }

            const groupType = dialog.isGroup ? 'Group' : dialog.isChannel ? 'Channel' : 'Unknown Type';

            // Enhanced logging for group/channel extracted details
            console.log(`  📂 ${groupType} Name: "${groupName}", ID: ${groupId} (Entity: ${entity?.className || 'Unknown'})`);
            if (!groupId) {
                console.warn(`  ❌ Unable to extract a valid ID for "${groupName}". Verify the entity format.`);
            }
            return {name: groupName, id: groupId, type: groupType, entity: dialog.entity};
        });

        console.log("\n🌟 To use these groups for sortConfig.sourceGroups, add the following valid IDs:");
        const validIds = groupDetails.filter(group => group.id).map(group => group.id);
        if (validIds.length === 0) {
            console.warn("⚠️ No valid group/channel IDs found to use for sortConfig.sourceGroups.");
        } else {
            console.log(validIds.join(', '));
        }

        // Return dialogs with entity objects for proper resolution
        return groups;
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
