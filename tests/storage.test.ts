import * as fs from 'node:fs';
import * as path from 'node:path';
import {MessageStorage} from '../src/services/storage';

describe('MessageStorage with SQLite', () => {
    const testDir = path.join(__dirname, 'test-data');
    const testDbPath = path.join(testDir, 'test-processed.txt');
    let storage: MessageStorage;

    beforeEach(() => {
        // Create test directory
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, {recursive: true});
        }

        // Clean up any existing test files
        const files = [
            testDbPath,
            testDbPath.replace('.txt', '.db'),
            testDbPath.replace('.txt', '-videos.txt'),
            testDbPath.replace('.txt', '-metadata.json'),
            testDbPath + '.backup',
            testDbPath.replace('.txt', '-videos.txt.backup'),
            testDbPath.replace('.txt', '-metadata.json.backup')
        ];

        files.forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        });

        storage = new MessageStorage(testDbPath);
    });

    afterEach(() => {
        storage.close();

        // Clean up test files
        const files = [
            testDbPath,
            testDbPath.replace('.txt', '.db'),
            testDbPath.replace('.txt', '-videos.txt'),
            testDbPath.replace('.txt', '-metadata.json'),
            testDbPath + '.backup',
            testDbPath.replace('.txt', '-videos.txt.backup'),
            testDbPath.replace('.txt', '-metadata.json.backup')
        ];

        files.forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        });

        // Remove test directory if empty
        if (fs.existsSync(testDir) && fs.readdirSync(testDir).length === 0) {
            fs.rmdirSync(testDir);
        }
    });

    describe('Database Initialization', () => {
        it('should create a SQLite database file', () => {
            const dbFile = testDbPath.replace('.txt', '.db');
            expect(fs.existsSync(dbFile)).toBe(true);
        });

        it('should initialize with zero counts', () => {
            expect(storage.getProcessedMessagesCount()).toBe(0);
            expect(storage.getProcessedVideoNamesCount()).toBe(0);
        });
    });

    describe('Message Processing', () => {
        it('should save and retrieve processed message', () => {
            const messageId = '12345_67890';

            storage.saveProcessedMessage(messageId);

            expect(storage.hasProcessedMessage(messageId)).toBe(true);
            expect(storage.getProcessedMessagesCount()).toBe(1);
        });

        it('should handle duplicate message IDs', () => {
            const messageId = '12345_67890';

            storage.saveProcessedMessage(messageId);
            storage.saveProcessedMessage(messageId);

            expect(storage.getProcessedMessagesCount()).toBe(1);
        });

        it('should return false for unprocessed message', () => {
            expect(storage.hasProcessedMessage('99999_88888')).toBe(false);
        });

        it('should handle multiple messages', () => {
            const messageIds = ['111_222', '333_444', '555_666'];

            messageIds.forEach(id => storage.saveProcessedMessage(id));

            expect(storage.getProcessedMessagesCount()).toBe(3);
            messageIds.forEach(id => {
                expect(storage.hasProcessedMessage(id)).toBe(true);
            });
        });
    });

    describe('Video Processing', () => {
        it('should save and check video duplicate in topic', () => {
            const fileName = 'test_video.mp4';
            const topicName = 'topic1';

            storage.saveProcessedVideoName(fileName, topicName, 120, 50.5);

            expect(storage.isVideoDuplicateInTopic(fileName, topicName)).toBe(true);
            expect(storage.getProcessedVideoNamesCount()).toBe(1);
        });

        it('should allow same video in different topics', () => {
            const fileName = 'test_video.mp4';

            storage.saveProcessedVideoName(fileName, 'topic1', 120, 50.5);
            storage.saveProcessedVideoName(fileName, 'topic2', 120, 50.5);

            expect(storage.isVideoDuplicateInTopic(fileName, 'topic1')).toBe(true);
            expect(storage.isVideoDuplicateInTopic(fileName, 'topic2')).toBe(true);
            expect(storage.getProcessedVideoNamesCount()).toBe(2);
        });

        it('should be case-insensitive for video names', () => {
            storage.saveProcessedVideoName('Test_Video.mp4', 'topic1', 120, 50.5);

            expect(storage.isVideoDuplicateInTopic('test_video.mp4', 'topic1')).toBe(true);
            expect(storage.isVideoDuplicateInTopic('TEST_VIDEO.MP4', 'topic1')).toBe(true);
        });

        it('should save video with all metadata including topic', () => {
            storage.saveProcessedVideoName('video.mp4', 'topic1', 150, 75.2, 'video_normalized');

            const videos = storage.getProcessedVideos();
            expect(videos).toHaveLength(1);
            expect(videos[0]).toEqual({
                fileName: 'video.mp4',
                normalizedName: 'video_normalized',
                topicName: 'topic1',
                duration: 150,
                sizeMB: 75.2
            });
        });

        it('should save video without optional metadata', () => {
            storage.saveProcessedVideoName('video.mp4', 'topic1');

            const videos = storage.getProcessedVideos();
            expect(videos).toHaveLength(1);
            expect(videos[0].fileName).toBe('video.mp4');
            expect(videos[0].topicName).toBe('topic1');
            expect(videos[0].duration).toBeUndefined();
            expect(videos[0].sizeMB).toBeUndefined();
        });

        it('should handle multiple videos in different topics', () => {
            storage.saveProcessedVideoName('video1.mp4', 'topic1', 100, 50);
            storage.saveProcessedVideoName('video2.mp4', 'topic1', 200, 100);
            storage.saveProcessedVideoName('video3.mp4', 'topic2', 300, 150);

            expect(storage.getProcessedVideoNamesCount()).toBe(3);
        });

        it('should get videos filtered by topic', () => {
            storage.saveProcessedVideoName('video1.mp4', 'topic1', 100, 50);
            storage.saveProcessedVideoName('video2.mp4', 'topic1', 200, 100);
            storage.saveProcessedVideoName('video3.mp4', 'topic2', 300, 150);

            const topic1Videos = storage.getProcessedVideosInTopic('topic1');
            expect(topic1Videos).toHaveLength(2);
            expect(topic1Videos.every(v => v.topicName === 'topic1')).toBe(true);

            const topic2Videos = storage.getProcessedVideosInTopic('topic2');
            expect(topic2Videos).toHaveLength(1);
            expect(topic2Videos[0].topicName).toBe('topic2');
        });
    });

    describe('Similar Video Detection (Per-Topic)', () => {
        beforeEach(() => {
            storage.saveProcessedVideoName('existing_video.mp4', 'topic1', 120, 50.5, 'existing_video');
        });

        it('should find exact match by normalized name in same topic', () => {
            const similar = storage.findSimilarVideoInTopic(
                'existing_video.mp4',
                'existing_video',
                'topic1',
                120,
                50.5
            );

            expect(similar).not.toBeNull();
            expect(similar?.fileName).toBe('existing_video.mp4');
            expect(similar?.topicName).toBe('topic1');
        });

        it('should return null for video in different topic', () => {
            const similar = storage.findSimilarVideoInTopic(
                'existing_video.mp4',
                'existing_video',
                'topic2',
                120,
                50.5
            );

            expect(similar).toBeNull();
        });

        it('should return null for non-existent video', () => {
            const similar = storage.findSimilarVideoInTopic(
                'new_video.mp4',
                'new_video',
                'topic1',
                120,
                50.5
            );

            expect(similar).toBeNull();
        });

        it('should find similar video by duration tolerance in same topic', () => {
            const similar = storage.findSimilarVideoInTopic(
                'different_name.mp4',
                'different_name',
                'topic1',
                140, // 20 seconds difference
                60,
                {
                    checkDuration: true,
                    durationToleranceSeconds: 30
                }
            );

            expect(similar).not.toBeNull();
            expect(similar?.fileName).toBe('existing_video.mp4');
            expect(similar?.topicName).toBe('topic1');
        });

        it('should find similar video by file size tolerance in same topic', () => {
            const similar = storage.findSimilarVideoInTopic(
                'different_name.mp4',
                'different_name',
                'topic1',
                150,
                52, // ~3% difference from 50.5
                {
                    checkFileSize: true,
                    fileSizeTolerancePercent: 5
                }
            );

            expect(similar).not.toBeNull();
            expect(similar?.fileName).toBe('existing_video.mp4');
        });

        it('should find similar video with both checks enabled', () => {
            const similar = storage.findSimilarVideoInTopic(
                'different_name.mp4',
                'different_name',
                'topic1',
                130, // 10 seconds difference
                52, // ~3% difference
                {
                    checkDuration: true,
                    durationToleranceSeconds: 30,
                    checkFileSize: true,
                    fileSizeTolerancePercent: 5
                }
            );

            expect(similar).not.toBeNull();
        });

        it('should respect legacy wildcard topic "*"', () => {
            storage.saveProcessedVideoName('legacy_video.mp4', '*', 100, 45, 'legacy_video');

            const similar = storage.findSimilarVideoInTopic(
                'legacy_video.mp4',
                'legacy_video',
                'any_topic',
                100,
                45
            );

            expect(similar).not.toBeNull();
            expect(similar?.topicName).toBe('*');
        });
    });

    describe('Legacy Data Migration', () => {
        it('should migrate from legacy message log file', () => {
            storage.close();

            // Create legacy file
            const legacyMessages = ['111_222', '333_444', '555_666'];
            fs.writeFileSync(testDbPath, legacyMessages.join('\n'));

            // Initialize new storage (should trigger migration)
            storage = new MessageStorage(testDbPath);
            storage.loadProcessedMessages();

            expect(storage.getProcessedMessagesCount()).toBe(3);
            legacyMessages.forEach(id => {
                expect(storage.hasProcessedMessage(id)).toBe(true);
            });

            // Check backup was created
            expect(fs.existsSync(testDbPath + '.backup')).toBe(true);
        });


        it('should migrate from legacy video names text file', () => {
            storage.close();

            // Create legacy video names file
            const legacyVideoNames = ['video1', 'video2', 'video3'];
            const videoNamesPath = testDbPath.replace('.txt', '-videos.txt');
            fs.writeFileSync(videoNamesPath, legacyVideoNames.join('\n'));

            // Initialize new storage (should trigger migration)
            storage = new MessageStorage(testDbPath);
            storage.loadProcessedVideoNames();

            expect(storage.getProcessedVideoNamesCount()).toBe(3);

            // Check backup was created
            expect(fs.existsSync(videoNamesPath + '.backup')).toBe(true);
        });

        it('should handle empty legacy files', () => {
            storage.close();

            // Create empty legacy file
            fs.writeFileSync(testDbPath, '');

            storage = new MessageStorage(testDbPath);
            storage.loadProcessedMessages();

            expect(storage.getProcessedMessagesCount()).toBe(0);
        });

        it('should not migrate if no legacy files exist', () => {
            storage.loadProcessedMessages();
            storage.loadProcessedVideoNames();

            expect(storage.getProcessedMessagesCount()).toBe(0);
            expect(storage.getProcessedVideoNamesCount()).toBe(0);
            expect(fs.existsSync(testDbPath + '.backup')).toBe(false);
        });
    });

    describe('Performance', () => {
        it('should handle large number of messages efficiently', () => {
            const startTime = Date.now();

            // Insert 1000 messages
            for (let i = 0; i < 1000; i++) {
                storage.saveProcessedMessage(`source_${i}_msg_${i}`);
            }

            const insertTime = Date.now() - startTime;

            // Check a few random messages
            const checkStart = Date.now();
            expect(storage.hasProcessedMessage('source_500_msg_500')).toBe(true);
            expect(storage.hasProcessedMessage('source_999_msg_999')).toBe(true);
            const checkTime = Date.now() - checkStart;

            expect(storage.getProcessedMessagesCount()).toBe(1000);

            // These are reasonable performance expectations
            expect(insertTime).toBeLessThan(5000); // 5 seconds for 1000 inserts
            expect(checkTime).toBeLessThan(100); // 100ms for 2 lookups
        });

    });

});
