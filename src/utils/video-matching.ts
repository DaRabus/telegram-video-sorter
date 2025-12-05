import type {VideoMessage} from '../types/config';
import {getFileName, getVideoDuration} from './helpers';

export function matchesVideo(
    message: VideoMessage,
    matches: string[],
    exclusions: string[],
    minDuration: number
): string[] {
    const media = message.media;

    if (!media?.document || !media.video) {
        return [];
    }

    const document = media.document;
    const messageText = (message.message ?? '').toLowerCase();
    const fileName = getFileName(document).toLowerCase();
    const duration = getVideoDuration(document);

    if (!duration || duration < minDuration) {
        return [];
    }

    const combinedText = `${messageText} ${fileName}`;

    // Check exclusions first
    for (const exclusion of exclusions) {
        if (combinedText.includes(exclusion.toLowerCase())) {
            return [];
        }
    }

    // Find ALL matching strings
    const allMatches: string[] = [];
    for (const matchString of matches) {
        if (combinedText.includes(matchString.toLowerCase())) {
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
