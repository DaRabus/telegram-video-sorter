import * as fs from 'node:fs';
import * as path from 'node:path';
import {config as loadEnv} from 'dotenv';
import type {DerivedPaths, SortingConfig} from '@/types/config';

export class ConfigLoader {
    private sortConfig!: SortingConfig;
    private derivedPaths!: DerivedPaths;
    private matches: string[] = [];
    private exclusions: string[] = [];

    constructor() {
        this.loadEnvironment();
        this.loadConfiguration();
        this.validateConfiguration();
    }

    private loadEnvironment(): void {
        const envPath = path.join(process.cwd(), '.env');
        loadEnv({path: envPath});
    }

    private loadConfiguration(): void {
        const configPath = path.join(process.cwd(), 'telegram-sorter-config.json');

        try {
            this.sortConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

            this.derivedPaths = {
                processedLogFile: path.join(this.sortConfig.dataDir, 'processed-messages.txt'),
                forumGroupCache: path.join(this.sortConfig.dataDir, 'forum-group-cache.json'),
                forwardingLogFile: path.join(this.sortConfig.dataDir, 'forwarding-log.json')
            };

            if (!fs.existsSync(this.sortConfig.dataDir)) {
                fs.mkdirSync(this.sortConfig.dataDir, {recursive: true});
            }
        } catch (error) {
            console.error('Error loading config file:', error);
            throw new Error('Please create telegram-sorter-config.json in the project root');
        }
    }

    private validateConfiguration(): void {
        this.matches = this.sortConfig.videoMatches
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        if (this.matches.length === 0) {
            console.error('❌ ERROR: videoMatches in config file is not set or empty!');
            console.error('Please set videoMatches with an array of keywords to search for.');
            console.error('Example: "videoMatches": ["keyword1", "keyword2", "keyword3"]');
            process.exit(1);
        }

        this.exclusions = this.sortConfig.videoExclusions
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        if (this.exclusions.length === 0) {
            console.warn('⚠️  WARNING: videoExclusions in config file is not set or empty!');
            console.warn('No exclusion filters will be applied.');
        }
    }

    getConfig(): SortingConfig {
        return this.sortConfig;
    }

    getPaths(): DerivedPaths {
        return this.derivedPaths;
    }

    getMatches(): string[] {
        return this.matches;
    }

    getExclusions(): string[] {
        return this.exclusions;
    }
}
