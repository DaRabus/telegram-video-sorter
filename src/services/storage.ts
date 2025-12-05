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

    constructor(processedLogFile: string) {
        this.legacyLogFile = processedLogFile;
        this.legacyVideoNamesFile = processedLogFile.replace('.txt', '-videos.txt');
        this.legacyMetadataFile = processedLogFile.replace('.txt', '-metadata.json');
        this.dbPath = processedLogFile.replace('.txt', '.db');

        // Initialize database
        this.db = new Database(this.dbPath);
        this.initializeDatabase();
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
        const stmt = this.db.prepare('INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)');
        stmt.run(messageId);
    }

    hasProcessedMessage(messageId: string): boolean {
        const stmt = this.db.prepare('SELECT 1 FROM processed_messages WHERE message_id = ? LIMIT 1');
        return stmt.get(messageId) !== undefined;
    }

    saveProcessedVideoName(fileName: string, topicName: string, duration?: number, sizeMB?: number, normalizedName?: string): void {
        const normalized = normalizedName || fileName.toLowerCase();
        const stmt = this.db.prepare(
            'INSERT OR IGNORE INTO processed_videos (file_name, normalized_name, topic_name, duration, size_mb) VALUES (?, ?, ?, ?, ?)'
        );
        stmt.run(fileName, normalized, topicName, duration ?? null, sizeMB ?? null);
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
        // Quick check: exact normalized name match in this specific topic or global wildcard
        const exactMatch = this.db.prepare(
            'SELECT file_name, normalized_name, topic_name, duration, size_mb FROM processed_videos WHERE normalized_name = ? AND (topic_name = ? OR topic_name = \'*\') LIMIT 1'
        ).get(normalizedName, topicName) as any;

        if (exactMatch) {
            return {
                fileName: exactMatch.file_name,
                normalizedName: exactMatch.normalized_name,
                topicName: exactMatch.topic_name,
                duration: exactMatch.duration ?? undefined,
                sizeMB: exactMatch.size_mb ?? undefined
            };
        }

        // If advanced checks are enabled, search for similar videos in this topic
        if (options?.checkDuration || options?.checkFileSize) {
            const durationTolerance = options.durationToleranceSeconds || 30;
            const sizeTolerance = options.fileSizeTolerancePercent || 5;

            let query = 'SELECT file_name, normalized_name, topic_name, duration, size_mb FROM processed_videos WHERE (topic_name = ? OR topic_name = \'*\')';
            const params: any[] = [topicName];

            if (options.checkDuration && duration) {
                query += ' AND duration IS NOT NULL AND ABS(duration - ?) <= ?';
                params.push(duration, durationTolerance);
            }

            if (options.checkFileSize && sizeMB) {
                query += ' AND size_mb IS NOT NULL AND (ABS(size_mb - ?) / size_mb * 100) <= ?';
                params.push(sizeMB, sizeTolerance);
            }

            query += ' LIMIT 1';

            const similarMatch = this.db.prepare(query).get(...params) as any;

            if (similarMatch) {
                return {
                    fileName: similarMatch.file_name,
                    normalizedName: similarMatch.normalized_name,
                    topicName: similarMatch.topic_name,
                    duration: similarMatch.duration ?? undefined,
                    sizeMB: similarMatch.size_mb ?? undefined
                };
            }
        }

        return null;
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
