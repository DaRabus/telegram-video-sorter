import type {SortingConfig} from '../types/config';
import {formatDuration} from '../utils/helpers';

export class ConsoleLogger {
    static logStartup(sortConfig: SortingConfig, matches: string[], exclusions: string[]): void {
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
    }

    static logStorageStats(messagesCount: number, videosCount: number): void {
        console.log(`📝 Loaded ${messagesCount} previously processed messages`);
        console.log(`📝 Loaded ${videosCount} previously processed video names`);
    }

    static logSummary(
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
