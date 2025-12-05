import {
    formatDuration,
    getFileName,
    getVideoDuration
} from '../src/utils/helpers';
import {shouldExcludeVideo, matchesVideo} from '../src/utils/video-matching';

describe('Telegram Video Sorter', () => {
    describe('formatDuration', () => {
        it('should format seconds to minutes and seconds', () => {
            expect(formatDuration(65)).toBe('1m 5s');
            expect(formatDuration(300)).toBe('5m 0s');
            expect(formatDuration(0)).toBe('0m 0s');
        });
    });

    describe('shouldExcludeVideo', () => {
        const exclusions = ['exclude', 'bad'];

        it('should return true if video matches exclusion', () => {
            expect(shouldExcludeVideo('some text', 'video_exclude.mp4', exclusions)).toBe(true);
            expect(shouldExcludeVideo('bad video', 'video.mp4', exclusions)).toBe(true);
        });

        it('should return false if video does not match exclusion', () => {
            expect(shouldExcludeVideo('good video', 'video.mp4', exclusions)).toBe(false);
        });
    });

    describe('getFileName', () => {
        it('should return filename from document attributes', () => {
            const doc = {
                attributes: [
                    {className: 'DocumentAttributeFilename', fileName: 'test.mp4'}
                ]
            };
            // @ts-ignore
            expect(getFileName(doc)).toBe('test.mp4');
        });

        it('should return empty string if no filename attribute', () => {
            const doc = {
                attributes: [
                    {className: 'DocumentAttributeVideo', duration: 100}
                ]
            };
            // @ts-ignore
            expect(getFileName(doc)).toBe('');
        });
    });

    describe('getVideoDuration', () => {
        it('should return duration from document attributes', () => {
            const doc = {
                attributes: [
                    {className: 'DocumentAttributeVideo', duration: 120}
                ]
            };
            // @ts-ignore
            expect(getVideoDuration(doc)).toBe(120);
        });

        it('should return null if no video attribute', () => {
            const doc = {
                attributes: [
                    {className: 'DocumentAttributeFilename', fileName: 'test.mp4'}
                ]
            };
            // @ts-ignore
            expect(getVideoDuration(doc)).toBeNull();
        });
    });

    describe('matchesVideo', () => {
        const matches = ['keyword'];
        const exclusions = ['exclude'];
        const minDuration = 60;

        it('should return match string if video matches and meets criteria', () => {
            const message = {
                media: {
                    video: true,
                    document: {
                        attributes: [
                            {className: 'DocumentAttributeVideo', duration: 100},
                            {className: 'DocumentAttributeFilename', fileName: 'keyword_video.mp4'}
                        ]
                    }
                },
                message: 'some text',
                id: 1
            };
            // @ts-ignore
            expect(matchesVideo(message, matches, exclusions, minDuration)).toEqual(['keyword']);
        });

        it('should return null if video is too short', () => {
            const message = {
                media: {
                    video: true,
                    document: {
                        attributes: [
                            {className: 'DocumentAttributeVideo', duration: 30},
                            {className: 'DocumentAttributeFilename', fileName: 'keyword_video.mp4'}
                        ]
                    }
                },
                message: 'some text',
                id: 1
            };
            // @ts-ignore
            expect(matchesVideo(message, matches, exclusions, minDuration).length).toBe(0);
        });

        it('should return null if video matches exclusion', () => {
            const message = {
                media: {
                    video: true,
                    document: {
                        attributes: [
                            {className: 'DocumentAttributeVideo', duration: 100},
                            {className: 'DocumentAttributeFilename', fileName: 'keyword_exclude.mp4'}
                        ]
                    }
                },
                message: 'some text',
                id: 1
            };
            // @ts-ignore
            expect(matchesVideo(message, matches, exclusions, minDuration).length).toBe(0);
        });
    });
});
