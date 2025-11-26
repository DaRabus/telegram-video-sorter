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
