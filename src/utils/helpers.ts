import {VideoDocument} from "../types/config";

export function getVideoDuration(document: VideoDocument | undefined): number | null {
    if (!document?.attributes) {
        return null;
    }

    const videoAttr = document.attributes.find(
        (attr) => attr.className === 'DocumentAttributeVideo'
    );

    return videoAttr?.duration ?? null;
}

export function getFileName(document: VideoDocument | undefined): string {
    if (!document?.attributes) {
        return '';
    }

    const fileAttr = document.attributes.find(
        (attr) => attr.className === 'DocumentAttributeFilename'
    );

    return fileAttr?.fileName ?? '';
}

export function normalizeFileName(fileName: string): string {
    // IMPROVED: More selective normalization that preserves key identifying information
    let normalized = fileName.toLowerCase();
    
    // Remove file extension
    normalized = normalized.replace(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/gi, '');
    
    // Remove common quality/resolution indicators (but keep unique parts of filename)
    normalized = normalized.replace(/[\[\(]?\d{3,4}p[\]\)]?/gi, ''); // 1080p, 720p, [1080p]
    normalized = normalized.replace(/[\[\(]?\d{1}k[\]\)]?/gi, ''); // 4k, 8k
    normalized = normalized.replace(/[\[\(]?(uhd|fhd|hd|sd)[\]\)]?/gi, ''); // UHD, FHD
    
    // Remove codec and encoding info (in brackets or standalone)
    normalized = normalized.replace(/[\[\(]?(x264|x265|hevc|h264|h265|avc|av1)[\]\)]?/gi, '');
    normalized = normalized.replace(/[\[\(]?(aac|ac3|dts|mp3|flac)[\]\)]?/gi, '');
    
    // Remove common domain suffixes and metadata
    normalized = normalized.replace(/\.(xxx|com|net|org)($|[\s\-_\.])/gi, '');
    
    // Remove release group brackets/parentheses but keep their content if meaningful
    // This is more selective - only removes common tags
    normalized = normalized.replace(/\[(rss|web-?dl|hdtv|bluray|brrip|webrip)\]/gi, '');
    
    // Normalize separators to single space for consistent comparison
    normalized = normalized.replace(/[\s_\-\.]+/g, ' ');
    
    // Remove duplicate spaces
    normalized = normalized.replace(/\s+/g, ' ').trim();
    
    // Final cleanup: remove special chars but keep letters, numbers, and spaces
    normalized = normalized.replace(/[^a-z0-9\s]/g, '');
    
    // Final space cleanup
    normalized = normalized.replace(/\s+/g, '').trim();
    
    return normalized;
}

export function getFileSize(document: VideoDocument | undefined): number {
    if (!document?.size) {
        return 0;
    }
    return Number.parseInt(document.size, 10);
}

export function getFileSizeMB(document: VideoDocument | undefined): number {
    return getFileSize(document) / 1024 / 1024;
}

export function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleRateLimit(
    error: any,
    retryCount = 0
): Promise<boolean> {
    const maxRetries = 3;

    if (error?.errorMessage === 'FLOOD_WAIT' || error?.code === 420) {
        const waitTime = error.seconds
            ? error.seconds * 1000
            : Math.pow(2, retryCount) * 5000;
        console.log(
            `  ⏳ Rate limit hit, waiting ${waitTime / 1000}s before retry...`
        );
        await sleep(waitTime);
        return retryCount < maxRetries;
    }

    return false;
}
