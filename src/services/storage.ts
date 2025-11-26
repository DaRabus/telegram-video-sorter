import * as fs from 'node:fs';
import type {ForwardingLogEntry} from '@/types/config';

export class MessageStorage {
    private processedMessages = new Set<string>();
    private processedVideoNames = new Set<string>();
    private readonly processedLogFile: string;
    private readonly videoNamesFile: string;

    constructor(processedLogFile: string) {
        this.processedLogFile = processedLogFile;
        this.videoNamesFile = processedLogFile.replace('.txt', '-videos.txt');
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
    }

    saveProcessedVideoName(fileName: string): void {
        const normalizedName = fileName.toLowerCase();
        this.processedVideoNames.add(normalizedName);
        fs.appendFileSync(this.videoNamesFile, `${normalizedName}\n`);
    }

    isVideoDuplicate(fileName: string): boolean {
        return this.processedVideoNames.has(fileName.toLowerCase());
    }

    getProcessedMessagesCount(): number {
        return this.processedMessages.size;
    }

    getProcessedVideoNamesCount(): number {
        return this.processedVideoNames.size;
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
