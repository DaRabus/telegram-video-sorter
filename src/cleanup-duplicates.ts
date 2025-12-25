import {Api, TelegramClient} from 'telegram';
import path from 'node:path';
import {ConfigLoader} from './services/config-loader';
import {TelegramClientFactory} from './services/telegram-client';
import {ForumService} from './services/forum-service';
import {getFileName, getVideoDuration, normalizeFileName, getFileSizeMB, sleep} from './utils/helpers';

interface VideoInfo {
    messageId: number;
    fileName: string;
    normalizedName: string;
    duration: number | null;
    sizeMB: number;
    topicId: number;
}

function calculateSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.includes(shorter)) {
        return shorter.length / longer.length;
    }
    
    let matchingChars = 0;
    const minLength = Math.min(str1.length, str2.length);
    for (let i = 0; i < minLength; i++) {
        if (str1[i] === str2[i]) {
            matchingChars++;
        } else {
            break;
        }
    }
    
    return matchingChars / Math.max(str1.length, str2.length);
}

function areVideosDuplicate(
    v1: VideoInfo,
    v2: VideoInfo,
    durationTolerance: number = 30,
    sizeTolerance: number = 2,
    similarityThreshold: number = 0.85
): boolean {
    // Check name similarity
    const nameSimilarity = calculateSimilarity(v1.normalizedName, v2.normalizedName);
    
    if (nameSimilarity < similarityThreshold) {
        return false;
    }
    
    // Check duration if available
    if (v1.duration && v2.duration) {
        const durationDiff = Math.abs(v1.duration - v2.duration);
        if (durationDiff > durationTolerance) {
            return false;
        }
    }
    
    // Check file size
    const sizeDiff = Math.abs(v1.sizeMB - v2.sizeMB);
    const sizePercentDiff = (sizeDiff / Math.max(v1.sizeMB, v2.sizeMB)) * 100;
    if (sizePercentDiff > sizeTolerance) {
        return false;
    }
    
    return true;
}

async function scanTopicForVideos(
    client: TelegramClient,
    forumGroupId: number,
    topicId: number,
    topicName: string
): Promise<VideoInfo[]> {
    const videos: VideoInfo[] = [];
    let offsetId = 0;
    
    console.log(`  📂 Scanning topic: ${topicName} (ID: ${topicId})`);
    
    while (true) {
        try {
            const result = await client.invoke(
                new Api.messages.GetReplies({
                    peer: forumGroupId,
                    msgId: topicId,
                    offsetId,
                    limit: 100,
                    addOffset: 0,
                    maxId: 0,
                    minId: 0,
                    hash: 0 as any
                })
            );
            
            const messages = 'messages' in result && Array.isArray(result.messages) ? result.messages : [];
            
            if (messages.length === 0) break;
            
            for (const message of messages) {
                if (!('media' in message) || !message.media) continue;
                
                const media = message.media as any;
                if (!media?.document) continue;
                
                const document = media.document;
                const hasVideoAttribute = document.attributes?.some(
                    (attr: any) => attr.className === 'DocumentAttributeVideo'
                );
                
                if (!hasVideoAttribute && !media.video) continue;
                
                const fileName = getFileName(document);
                const normalizedName = normalizeFileName(fileName);
                const duration = getVideoDuration(document);
                const sizeMB = getFileSizeMB(document);
                
                videos.push({
                    messageId: message.id,
                    fileName,
                    normalizedName,
                    duration,
                    sizeMB,
                    topicId
                });
            }
            
            if (messages.length > 0) {
                const lastMessage = messages[messages.length - 1];
                offsetId = lastMessage.id;
            } else {
                break;
            }
            
            await sleep(500); // Increased from 100ms to 500ms for better rate limiting
        } catch (error) {
            console.error(`    ❌ Error scanning topic ${topicName}:`, error);
            break;
        }
    }
    
    console.log(`    ✅ Found ${videos.length} videos`);
    return videos;
}

async function findDuplicates(videos: VideoInfo[]): Promise<Map<number, VideoInfo[]>> {
    const duplicateGroups = new Map<number, VideoInfo[]>();
    const processed = new Set<number>();
    
    for (let i = 0; i < videos.length; i++) {
        if (processed.has(i)) continue;
        
        const group: VideoInfo[] = [videos[i]];
        
        for (let j = i + 1; j < videos.length; j++) {
            if (processed.has(j)) continue;
            
            if (areVideosDuplicate(videos[i], videos[j])) {
                group.push(videos[j]);
                processed.add(j);
            }
        }
        
        if (group.length > 1) {
            // Sort by message ID (oldest first)
            group.sort((a, b) => a.messageId - b.messageId);
            duplicateGroups.set(videos[i].messageId, group);
        }
        
        processed.add(i);
    }
    
    return duplicateGroups;
}

async function deleteDuplicateMessages(
    client: TelegramClient,
    forumGroupId: number,
    duplicateGroups: Map<number, VideoInfo[]>,
    dryRun: boolean = true
): Promise<number> {
    let deletedCount = 0;
    
    for (const [, group] of duplicateGroups) {
        const [original, ...duplicates] = group;
        
        console.log(`\n  🔍 Duplicate group (${group.length} videos):`);
        console.log(`     📹 Original (KEEP): ${original.fileName} (msg: ${original.messageId})`);
        
        for (const dup of duplicates) {
            console.log(`     ❌ Duplicate: ${dup.fileName} (msg: ${dup.messageId})`);
            
            if (!dryRun) {
                try {
                    await client.invoke(
                        new Api.messages.DeleteMessages({
                            id: [dup.messageId],
                            revoke: true
                        })
                    );
                    deletedCount++;
                    console.log(`        ✅ Deleted message ${dup.messageId}`);
                    await sleep(500);
                } catch (error) {
                    console.error(`        ❌ Failed to delete message ${dup.messageId}:`, error);
                }
            } else {
                console.log(`        🔍 [DRY RUN] Would delete message ${dup.messageId}`);
                deletedCount++;
            }
        }
    }
    
    return deletedCount;
}

async function main() {
    console.log('🧹 Telegram Video Sorter - Duplicate Cleanup Utility\n');
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    const dryRun = !args.includes('--delete');
    
    if (dryRun) {
        console.log('🔍 Running in DRY RUN mode (no deletions will be performed)');
        console.log('   Use --delete flag to actually delete duplicate messages\n');
    } else {
        console.log('⚠️  DELETE MODE - Duplicate messages will be permanently deleted!\n');
    }
    
    const configLoader = new ConfigLoader();
    const sortConfig = configLoader.getConfig();
    const paths = configLoader.getPaths();
    const matches = configLoader.getMatches();
    
    // Initialize Telegram client
    const client = TelegramClientFactory.createClient(
        path.join(process.cwd(), '/session/', sortConfig.sessionFile)
    );
    
    await client.connect();
    console.log('✅ Connected to Telegram\n');
    
    // Get forum group and topics
    const forumService = new ForumService(client, paths.forumGroupCache, true);
    const forumGroupId = await forumService.getOrCreateForumGroup(sortConfig.sortedGroupName);
    
    // Create topics for each match string
    const topicIds: Record<string, number> = {};
    for (const matchString of matches) {
        topicIds[matchString] = await forumService.getOrCreateTopic(forumGroupId, matchString);
    }
    
    console.log(`📊 Scanning forum: ${sortConfig.sortedGroupName} (${Object.keys(topicIds).length} topics)\n`);
    
    let totalDuplicates = 0;
    let totalDeleted = 0;
    
    for (const [topicName, topicId] of Object.entries(topicIds)) {
        const videos = await scanTopicForVideos(client, forumGroupId, topicId, topicName);
        
        if (videos.length === 0) {
            console.log(`    ℹ️  No videos found in topic\n`);
            continue;
        }
        
        const duplicateGroups = await findDuplicates(videos);
        
        if (duplicateGroups.size === 0) {
            console.log(`    ✅ No duplicates found in topic\n`);
            continue;
        }
        
        console.log(`    ⚠️  Found ${duplicateGroups.size} duplicate groups`);
        
        const deleted = await deleteDuplicateMessages(client, forumGroupId, duplicateGroups, dryRun);
        totalDeleted += deleted;
        
        // Count total duplicates (excluding the original in each group)
        for (const [, group] of duplicateGroups) {
            totalDuplicates += group.length - 1;
        }
        
        console.log(`    📊 ${deleted} duplicates ${dryRun ? 'found' : 'deleted'} in this topic\n`);
        
        await sleep(1000);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total duplicates found: ${totalDuplicates}`);
    if (dryRun) {
        console.log(`Would delete: ${totalDeleted} messages`);
        console.log('\n💡 Run with --delete flag to actually delete these messages');
    } else {
        console.log(`Successfully deleted: ${totalDeleted} messages`);
    }
    console.log('='.repeat(60));
    
    await client.disconnect();
}

main().catch(console.error);
