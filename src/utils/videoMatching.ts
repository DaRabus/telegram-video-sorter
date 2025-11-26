import type {VideoMessage} from '@/types/config';
import {getFileName, getVideoDuration} from './helpers';

export function matchesVideo(
    message: VideoMessage,
    matches: string[],
    exclusions: string[],
    minDuration: number
): string | null {
    const media = message.media;

    if (!media?.document || !media.video) {
        return null;
    }

    const document = media.document;
    const messageText = (message.message ?? '').toLowerCase();
    const fileName = getFileName(document).toLowerCase();
    const duration = getVideoDuration(document);

    if (!duration || duration < minDuration) {
        return null;
    }

    const combinedText = `${messageText} ${fileName}`;

    for (const exclusion of exclusions) {
        if (combinedText.includes(exclusion.toLowerCase())) {
            return null;
        }
    }

    for (const matchString of matches) {
        if (combinedText.includes(matchString.toLowerCase())) {
            return matchString;
        }
    }

    return null;
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
