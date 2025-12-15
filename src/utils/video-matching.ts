import type {VideoMessage} from '../types/config';
import {getFileName, getVideoDuration} from './helpers';

export function matchesVideo(
    message: VideoMessage,
    matches: string[],
    exclusions: string[],
    minDuration: number
): string[] {
    const media = message.media;

    // Check if document exists
    if (!media?.document) {
        return [];
    }

    const document = media.document;
    
    // Check if it's a video by looking for DocumentAttributeVideo or video flag
    const hasVideoAttribute = document.attributes?.some(
        attr => attr.className === 'DocumentAttributeVideo'
    );
    const isVideo = media.video || hasVideoAttribute;
    
    if (!isVideo) {
        return [];
    }

    const messageText = (message.message ?? '').toLowerCase();
    const fileName = getFileName(document).toLowerCase();
    const duration = getVideoDuration(document);

    if (!duration || duration < minDuration) {
        return [];
    }

    const combinedText = `${messageText} ${fileName}`;

    // Check exclusions first
    for (const exclusion of exclusions) {
        const exclusionLower = exclusion.toLowerCase().trim();
        if (exclusionLower && combinedText.includes(exclusionLower)) {
            return [];
        }
    }

    // Find ALL matching strings (case-insensitive word matching)
    const allMatches: string[] = [];
    for (const matchString of matches) {
        const matchLower = matchString.toLowerCase().trim();
        if (matchLower && combinedText.includes(matchLower)) {
            allMatches.push(matchString);
        }
    }

    return allMatches;
}

export function shouldExcludeVideo(
    messageText: string,
    fileName: string,
    exclusions: string[]
): boolean {
    const combinedText = `${messageText.toLowerCase()} ${fileName.toLowerCase()}`;

    for (const exclusion of exclusions) {
        if (combinedText.includes(exclusion.toLowerCase())) {
            return true;
        }
    }

    return false;
}
