import * as fs from 'node:fs';
import type {ForwardingLogEntry} from '../types/config';

interface VideoMetadata {
    fileName: string;
    normalizedName: string;
    duration?: number;
    sizeMB?: number;
}

export class MessageStorage {
    private processedMessages = new Set<string>();
    private processedVideoNames = new Set<string>();
    private processedVideos: VideoMetadata[] = [];
    private readonly processedLogFile: string;
    private readonly videoNamesFile: string;
    private readonly videoMetadataFile: string;

    constructor(processedLogFile: string) {
        this.processedLogFile = processedLogFile;
        this.videoNamesFile = processedLogFile.replace('.txt', '-videos.txt');
        this.videoMetadataFile = processedLogFile.replace('.txt', '-metadata.json');
    }

    loadProcessedMessages(): void {
        if (fs.existsSync(this.processedLogFile)) {
            const data = fs.readFileSync(this.processedLogFile, 'utf-8');
            for (const line of data.split('\n')) {
                if (line.trim()) {
                    this.processedMessages.add(line.trim());
                }
            }
        }
    }

    saveProcessedMessage(messageId: string): void {
        this.processedMessages.add(messageId);
        fs.appendFileSync(this.processedLogFile, `${messageId}\n`);
    }

    hasProcessedMessage(messageId: string): boolean {
        return this.processedMessages.has(messageId);
    }

    loadProcessedVideoNames(): void {
        if (fs.existsSync(this.videoNamesFile)) {
            const data = fs.readFileSync(this.videoNamesFile, 'utf-8');
            for (const line of data.split('\n')) {
                if (line.trim()) {
                    this.processedVideoNames.add(line.trim().toLowerCase());
                }
            }
        }
        
        // Load metadata
        if (fs.existsSync(this.videoMetadataFile)) {
            try {
                this.processedVideos = JSON.parse(fs.readFileSync(this.videoMetadataFile, 'utf-8'));
            } catch (error) {
                console.error('Error loading video metadata:', error);
                this.processedVideos = [];
            }
        }
    }

    saveProcessedVideoName(fileName: string, duration?: number, sizeMB?: number, normalizedName?: string): void {
        const normalized = normalizedName || fileName.toLowerCase();
        this.processedVideoNames.add(normalized);
        fs.appendFileSync(this.videoNamesFile, `${normalized}\n`);
        
        // Save metadata
        this.processedVideos.push({
            fileName,
            normalizedName: normalized,
            duration,
            sizeMB
        });
        fs.writeFileSync(this.videoMetadataFile, JSON.stringify(this.processedVideos, null, 2));
    }

    isVideoDuplicate(fileName: string): boolean {
        return this.processedVideoNames.has(fileName.toLowerCase());
    }
    
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
        // Quick check: exact normalized name match
        if (this.processedVideoNames.has(normalizedName)) {
            return this.processedVideos.find(v => v.normalizedName === normalizedName) || null;
        }
        
        // If advanced checks are enabled, search for similar videos
        if (options?.checkDuration || options?.checkFileSize) {
            for (const video of this.processedVideos) {
                let matches = video.normalizedName === normalizedName;
                
                // Check duration similarity
                if (options.checkDuration && duration && video.duration) {
                    const tolerance = options.durationToleranceSeconds || 30;
                    const durationDiff = Math.abs(duration - video.duration);
                    if (durationDiff <= tolerance) {
                        matches = true;
                    }
                }
                
                // Check file size similarity
                if (options.checkFileSize && sizeMB && video.sizeMB) {
                    const tolerance = options.fileSizeTolerancePercent || 5;
                    const sizeDiff = Math.abs(sizeMB - video.sizeMB);
                    const sizePercent = (sizeDiff / video.sizeMB) * 100;
                    if (sizePercent <= tolerance) {
                        matches = true;
                    }
                }
                
                if (matches) {
                    return video;
                }
            }
        }
        
        return null;
    }

    getProcessedMessagesCount(): number {
        return this.processedMessages.size;
    }

    getProcessedVideoNamesCount(): number {
        return this.processedVideoNames.size;
    }
    
    getProcessedVideos(): VideoMetadata[] {
        return this.processedVideos;
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
