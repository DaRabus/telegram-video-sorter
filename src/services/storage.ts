import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import type {ForwardingLogEntry} from '../types/config';

interface VideoMetadata {
    fileName: string;
    normalizedName: string;
    duration?: number;
    sizeMB?: number;
}

interface VideoTopicMetadata extends VideoMetadata {
    topicName: string;
}

export class MessageStorage {
    private readonly db: Database.Database;
    private readonly dbPath: string;
    private readonly legacyLogFile: string;
    private readonly legacyVideoNamesFile: string;
    private readonly legacyMetadataFile: string;

    // Prepared statement cache for performance
    private stmtHasMessage!: Database.Statement;
    private stmtSaveMessage!: Database.Statement;
    private stmtSaveVideo!: Database.Statement;

    constructor(processedLogFile: string) {
        this.legacyLogFile = processedLogFile;
        this.legacyVideoNamesFile = processedLogFile.replace('.txt', '-videos.txt');
        this.legacyMetadataFile = processedLogFile.replace('.txt', '-metadata.json');
        this.dbPath = processedLogFile.replace('.txt', '.db');

        // Initialize database
        this.db = new Database(this.dbPath);
        this.initializeDatabase();
        this.prepareStatements();
    }

    private prepareStatements(): void {
        // Pre-compile frequently used statements for ~10x faster execution
        this.stmtHasMessage = this.db.prepare('SELECT 1 FROM processed_messages WHERE message_id = ? LIMIT 1');
        this.stmtSaveMessage = this.db.prepare('INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)');
        this.stmtSaveVideo = this.db.prepare(
            'INSERT OR IGNORE INTO processed_videos (file_name, normalized_name, topic_name, duration, size_mb) VALUES (?, ?, ?, ?, ?)'
        );
    }

    private initializeDatabase(): void {
        // Create tables with indexes
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS processed_messages
            (
                message_id   TEXT PRIMARY KEY,
                processed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            CREATE TABLE IF NOT EXISTS processed_videos
            (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                file_name       TEXT    NOT NULL,
                normalized_name TEXT    NOT NULL,
                topic_name      TEXT    NOT NULL,
                duration        REAL,
                size_mb         REAL,
                processed_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                UNIQUE (normalized_name, topic_name)
            );

            CREATE INDEX IF NOT EXISTS idx_normalized_name ON processed_videos (normalized_name);
            CREATE INDEX IF NOT EXISTS idx_topic_name ON processed_videos (topic_name);
            CREATE INDEX IF NOT EXISTS idx_normalized_topic ON processed_videos (normalized_name, topic_name);
            CREATE INDEX IF NOT EXISTS idx_duration ON processed_videos (duration);
            CREATE INDEX IF NOT EXISTS idx_size_mb ON processed_videos (size_mb);
        `);
    }

    loadProcessedMessages(): void {
        // Check if legacy files exist and migrate
        if (fs.existsSync(this.legacyLogFile)) {
            console.log('📦 Migrating legacy message data to SQLite...');
            this.migrateLegacyMessages();
        }
    }

    loadProcessedVideoNames(): void {
        // Check if legacy files exist and migrate
        if (fs.existsSync(this.legacyVideoNamesFile) || fs.existsSync(this.legacyMetadataFile)) {
            console.log('📦 Migrating legacy video data to SQLite...');
            this.migrateLegacyVideos();
        }
    }

    private migrateLegacyMessages(): void {
        const data = fs.readFileSync(this.legacyLogFile, 'utf-8');
        const insert = this.db.prepare('INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)');
        const insertMany = this.db.transaction((messages: string[]) => {
            for (const messageId of messages) {
                insert.run(messageId);
            }
        });

        const messages = data.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        insertMany(messages);

        // Backup and remove legacy file
        fs.renameSync(this.legacyLogFile, `${this.legacyLogFile}.backup`);
        console.log(`   ✅ Migrated ${messages.length} messages (backup created)`);
    }

    private migrateLegacyVideos(): void {
        let videos: VideoMetadata[] = [];

        // Try loading from metadata file first
        if (fs.existsSync(this.legacyMetadataFile)) {
            try {
                videos = JSON.parse(fs.readFileSync(this.legacyMetadataFile, 'utf-8'));
            } catch (error) {
                console.error('   ⚠️  Error loading video metadata:', error);
            }
        } else if (fs.existsSync(this.legacyVideoNamesFile)) {
            // Fallback to video names file
            const data = fs.readFileSync(this.legacyVideoNamesFile, 'utf-8');
            videos = data.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(normalizedName => ({
                    fileName: normalizedName,
                    normalizedName
                }));
        }

        // Migrate legacy videos with "unknown" topic (since we don't have topic info in old format)
        const insert = this.db.prepare(
            'INSERT OR IGNORE INTO processed_videos (file_name, normalized_name, topic_name, duration, size_mb) VALUES (?, ?, ?, ?, ?)'
        );
        const insertMany = this.db.transaction((videos: VideoMetadata[]) => {
            for (const video of videos) {
                // Use "*" as wildcard topic to indicate it's been processed globally (legacy behavior)
                insert.run(video.fileName, video.normalizedName, '*', video.duration ?? null, video.sizeMB ?? null);
            }
        });

        insertMany(videos);

        // Backup and remove legacy files
        if (fs.existsSync(this.legacyMetadataFile)) {
            fs.renameSync(this.legacyMetadataFile, `${this.legacyMetadataFile}.backup`);
        }
        if (fs.existsSync(this.legacyVideoNamesFile)) {
            fs.renameSync(this.legacyVideoNamesFile, `${this.legacyVideoNamesFile}.backup`);
        }
        console.log(`   ✅ Migrated ${videos.length} videos to global scope (backups created)`);
    }

    saveProcessedMessage(messageId: string): void {
        this.stmtSaveMessage.run(messageId);
    }

    hasProcessedMessage(messageId: string): boolean {
        return this.stmtHasMessage.get(messageId) !== undefined;
    }

    saveProcessedVideoName(fileName: string, topicName: string, duration?: number, sizeMB?: number, normalizedName?: string): void {
        const normalized = normalizedName || fileName.toLowerCase();
        this.stmtSaveVideo.run(fileName, normalized, topicName, duration ?? null, sizeMB ?? null);
    }

    isVideoDuplicateInTopic(fileName: string, topicName: string): boolean {
        const normalized = fileName.toLowerCase();
        const stmt = this.db.prepare(
            'SELECT 1 FROM processed_videos WHERE normalized_name = ? AND (topic_name = ? OR topic_name = \'*\') LIMIT 1'
        );
        return stmt.get(normalized, topicName) !== undefined;
    }

    // Keep for backward compatibility but not recommended
    isVideoDuplicate(fileName: string): boolean {
        const stmt = this.db.prepare('SELECT 1 FROM processed_videos WHERE normalized_name = ? LIMIT 1');
        return stmt.get(fileName.toLowerCase()) !== undefined;
    }

    deleteVideosFromTopic(normalizedNames: string[], topicName: string): number {
        if (normalizedNames.length === 0) return 0;
        
        const placeholders = normalizedNames.map(() => '?').join(',');
        const stmt = this.db.prepare(
            `DELETE FROM processed_videos WHERE normalized_name IN (${placeholders}) AND (topic_name = ? OR topic_name = '*')`
        );
        
        const result = stmt.run(...normalizedNames, topicName);
        
        if (result.changes > 0) {
            console.log(`     🗄️  Removed ${result.changes} video record(s) from database for topic "${topicName}"`);
        }
        
        return result.changes;
    }

    private calculateSimilarity(str1: string, str2: string): number {
        // IMPROVED: More sophisticated similarity check for better duplicate detection
        if (str1 === str2) return 1.0;
        
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        // If length difference is too large, unlikely to be the same video
        const lengthRatio = shorter.length / longer.length;
        if (lengthRatio < 0.7) return 0; // Less than 70% length match = different videos
        
        // If one string contains the other entirely (common with truncated names)
        if (longer.includes(shorter)) {
            return shorter.length / longer.length;
        }
        
        // Check how many characters from the start match (prefix matching)
        let prefixMatchingChars = 0;
        const minLength = Math.min(str1.length, str2.length);
        for (let i = 0; i < minLength; i++) {
            if (str1[i] === str2[i]) {
                prefixMatchingChars++;
            } else {
                break;
            }
        }
        
        const prefixScore = prefixMatchingChars / Math.max(str1.length, str2.length);
        
        // Also calculate character-level overlap (Jaccard similarity)
        const set1 = new Set(str1.split(''));
        const set2 = new Set(str2.split(''));
        const intersection = new Set([...set1].filter(x => set2.has(x)));
        const union = new Set([...set1, ...set2]);
        const characterOverlap = intersection.size / union.size;
        
        // Combine both scores: prefix is more important (70%), character overlap (30%)
        return (prefixScore * 0.7) + (characterOverlap * 0.3);
    }

    findAllSimilarVideosInTopic(
        fileName: string,
        normalizedName: string,
        topicName: string,
        duration?: number,
        sizeMB?: number,
        options?: {
            checkDuration?: boolean;
            durationToleranceSeconds?: number;
            checkFileSize?: boolean;
            fileSizeTolerancePercent?: number;
        }
    ): VideoTopicMetadata[] {
        const durationTolerance = options?.durationToleranceSeconds || 30;
        const sizeTolerance = options?.fileSizeTolerancePercent || 5;
        const nameSimilarityThreshold = 0.85;
        const results: VideoTopicMetadata[] = [];
        
        // First, check for exact normalized name matches
        const exactMatches = this.db.prepare(
            'SELECT file_name, normalized_name, topic_name, duration, size_mb FROM processed_videos WHERE normalized_name = ? AND (topic_name = ? OR topic_name = \'*\')'
        ).all(normalizedName, topicName) as any[];

        for (const match of exactMatches) {
            // If no advanced checks enabled, any exact name match is a duplicate
            if (!options?.checkDuration && !options?.checkFileSize) {
                results.push({
                    fileName: match.file_name,
                    normalizedName: match.normalized_name,
                    topicName: match.topic_name,
                    duration: match.duration ?? undefined,
                    sizeMB: match.size_mb ?? undefined
                });
                continue;
            }
            
            // IMPROVED: With advanced checks, BOTH duration AND size must match if both are enabled
            let isDuplicate = true;
            let durationMatches = true;
            let sizeMatches = true;
            
            // Check duration if enabled
            if (options?.checkDuration) {
                if (duration && match.duration) {
                    const durationDiff = Math.abs(duration - match.duration);
                    durationMatches = durationDiff <= durationTolerance;
                } else {
                    // If duration check is enabled but one video lacks duration, it's not a match
                    durationMatches = false;
                }
            }
            
            // Check file size if enabled
            if (options?.checkFileSize) {
                if (sizeMB && match.size_mb) {
                    const sizeDiff = Math.abs(sizeMB - match.size_mb);
                    const sizePercentDiff = (sizeDiff / Math.max(sizeMB, match.size_mb)) * 100;
                    sizeMatches = sizePercentDiff <= sizeTolerance;
                } else {
                    // If size check is enabled but one video lacks size, it's not a match
                    sizeMatches = false;
                }
            }
            
            // CRITICAL: Both checks must pass when both are enabled
            isDuplicate = durationMatches && sizeMatches;
            
            if (isDuplicate) {
                results.push({
                    fileName: match.file_name,
                    normalizedName: match.normalized_name,
                    topicName: match.topic_name,
                    duration: match.duration ?? undefined,
                    sizeMB: match.size_mb ?? undefined
                });
            }
        }
        
        // NEW: Check for similar names (for truncated Telegram filenames)
        if ((options?.checkDuration && duration) || (options?.checkFileSize && sizeMB)) {
            const allInTopic = this.db.prepare(
                'SELECT file_name, normalized_name, topic_name, duration, size_mb FROM processed_videos WHERE (topic_name = ? OR topic_name = \'*\')'
            ).all(topicName) as any[];
            
            for (const candidate of allInTopic) {
                // Skip if already in results
                if (results.some(r => r.fileName === candidate.file_name && r.normalizedName === candidate.normalized_name)) {
                    continue;
                }
                
                const similarity = this.calculateSimilarity(normalizedName, candidate.normalized_name);
                
                if (similarity >= nameSimilarityThreshold) {
                    let isDuplicate = true;
                    
                    if (options?.checkDuration && duration && candidate.duration) {
                        const durationDiff = Math.abs(duration - candidate.duration);
                        if (durationDiff > durationTolerance) {
                            isDuplicate = false;
                        }
                    }
                    
                    if (options?.checkFileSize && sizeMB && candidate.size_mb) {
                        const sizeDiff = Math.abs(sizeMB - candidate.size_mb);
                        const sizePercentDiff = (sizeDiff / Math.max(sizeMB, candidate.size_mb)) * 100;
                        if (sizePercentDiff > sizeTolerance) {
                            isDuplicate = false;
                        }
                    }
                    
                    if (isDuplicate) {
                        results.push({
                            fileName: candidate.file_name,
                            normalizedName: candidate.normalized_name,
                            topicName: candidate.topic_name,
                            duration: candidate.duration ?? undefined,
                            sizeMB: candidate.size_mb ?? undefined
                        });
                    }
                }
            }
            
            // Fallback: Check by metadata match ONLY (for completely different filenames)
            // This is for cases where only duration OR only size is being checked,
            // or when both are checked but names are completely different
            if (!results.length && ((options?.checkDuration && duration) || (options?.checkFileSize && sizeMB))) {
                const allInTopic = this.db.prepare(
                    'SELECT file_name, normalized_name, topic_name, duration, size_mb FROM processed_videos WHERE (topic_name = ? OR topic_name = \'*\')'
                ).all(topicName) as any[];
                
                for (const candidate of allInTopic) {
                    let isDuplicate = true;
                    
                    // Check duration if enabled and both videos have duration
                    if (options?.checkDuration && duration && candidate.duration) {
                        const durationDiff = Math.abs(duration - candidate.duration);
                        if (durationDiff > durationTolerance) {
                            isDuplicate = false;
                        }
                    } else if (options?.checkDuration && (!duration || !candidate.duration)) {
                        // If duration check is enabled but one video lacks duration info, skip
                        isDuplicate = false;
                    }
                    
                    // Check size if enabled and both videos have size
                    if (options?.checkFileSize && sizeMB && candidate.size_mb) {
                        const sizeDiff = Math.abs(sizeMB - candidate.size_mb);
                        const sizePercentDiff = (sizeDiff / Math.max(sizeMB, candidate.size_mb)) * 100;
                        if (sizePercentDiff > sizeTolerance) {
                            isDuplicate = false;
                        }
                    } else if (options?.checkFileSize && (!sizeMB || !candidate.size_mb)) {
                        // If size check is enabled but one video lacks size info, skip
                        isDuplicate = false;
                    }
                    
                    if (isDuplicate) {
                        results.push({
                            fileName: candidate.file_name,
                            normalizedName: candidate.normalized_name,
                            topicName: candidate.topic_name,
                            duration: candidate.duration ?? undefined,
                            sizeMB: candidate.size_mb ?? undefined
                        });
                    }
                }
            }
        }
        
        return results;
    }

    findSimilarVideoInTopic(
        fileName: string,
        normalizedName: string,
        topicName: string,
        duration?: number,
        sizeMB?: number,
        options?: {
            checkDuration?: boolean;
            durationToleranceSeconds?: number;
            checkFileSize?: boolean;
            fileSizeTolerancePercent?: number;
        }
    ): VideoTopicMetadata | null {
        const results = this.findAllSimilarVideosInTopic(fileName, normalizedName, topicName, duration, sizeMB, options);
        return results.length > 0 ? results[0] : null;
    }

    // Legacy method - checks globally (kept for backward compatibility)
    findSimilarVideo(
        fileName: string,
        normalizedName: string,
        duration?: number,
        sizeMB?: number,
        options?: {
            checkDuration?: boolean;
            durationToleranceSeconds?: number;
            checkFileSize?: boolean;
            fileSizeTolerancePercent?: number;
        }
    ): VideoMetadata | null {
        const exactMatch = this.db.prepare(
            'SELECT file_name, normalized_name, duration, size_mb FROM processed_videos WHERE normalized_name = ? LIMIT 1'
        ).get(normalizedName) as any;

        if (exactMatch) {
            return {
                fileName: exactMatch.file_name,
                normalizedName: exactMatch.normalized_name,
                duration: exactMatch.duration ?? undefined,
                sizeMB: exactMatch.size_mb ?? undefined
            };
        }

        return null;
    }

    getProcessedMessagesCount(): number {
        const result = this.db.prepare('SELECT COUNT(*) as count FROM processed_messages').get() as { count: number };
        return result.count;
    }

    getProcessedVideoNamesCount(): number {
        const result = this.db.prepare('SELECT COUNT(*) as count FROM processed_videos').get() as { count: number };
        return result.count;
    }

    getProcessedVideos(): VideoTopicMetadata[] {
        const rows = this.db.prepare(
            'SELECT file_name, normalized_name, topic_name, duration, size_mb FROM processed_videos'
        ).all() as any[];

        return rows.map(row => ({
            fileName: row.file_name,
            normalizedName: row.normalized_name,
            topicName: row.topic_name,
            duration: row.duration ?? undefined,
            sizeMB: row.size_mb ?? undefined
        }));
    }

    getProcessedVideosInTopic(topicName: string): VideoTopicMetadata[] {
        const rows = this.db.prepare(
            'SELECT file_name, normalized_name, topic_name, duration, size_mb FROM processed_videos WHERE topic_name = ?'
        ).all(topicName) as any[];

        return rows.map(row => ({
            fileName: row.file_name,
            normalizedName: row.normalized_name,
            topicName: row.topic_name,
            duration: row.duration ?? undefined,
            sizeMB: row.size_mb ?? undefined
        }));
    }

    close(): void {
        this.db.close();
    }
}

export class ForwardingLogger {
    private logFile: string;

    constructor(logFile: string) {
        this.logFile = logFile;
    }

    logForwardedVideo(entry: ForwardingLogEntry): void {
        let logs: ForwardingLogEntry[] = [];

        if (fs.existsSync(this.logFile)) {
            try {
                logs = JSON.parse(fs.readFileSync(this.logFile, 'utf-8'));
            } catch (error) {
                console.error('Error loading forwarding log:', error);
                logs = [];
            }
        }

        logs.push(entry);
        fs.writeFileSync(this.logFile, JSON.stringify(logs, null, 2));
    }
}
