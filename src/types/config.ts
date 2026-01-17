export interface SortingConfig {
    sortedGroupName: string
    dataDir: string;
    sessionFile: string;
    videoMatches: string[];
    videoExclusions: string[];
    sourceGroups?: (string | number)[];
    minVideoDurationInSeconds: number;
    maxVideoDurationInSeconds?: number;
    minFileSizeMB?: number;
    maxFileSizeMB?: number;
    maxForwards: number;
    dryRun: boolean;
    skipCleanup?: boolean;  // Skip forum cleanup phase for faster runs
    duplicateDetection?: {
        checkDuration?: boolean;
        durationToleranceSeconds?: number;
        checkFileSize?: boolean;
        fileSizeTolerancePercent?: number;
        normalizeFilenames?: boolean;
        checkResolution?: boolean;
        resolutionTolerancePercent?: number;
        checkMimeType?: boolean;
    };
}

export interface DerivedPaths {
    processedLogFile: string;
    forumGroupCache: string;
    forwardingLogFile: string;
}

export interface ForwardingLogEntry {
    timestamp: string;
    fileName: string;
    matchedKeyword: string;
    topicName: string;
    sourceGroup: string | number;
    duration: number;
    sizeMB: number;
}

export interface ForumGroupCache {
    groupId?: number;
    topics: Record<string, number>;
}

export interface VideoDocument {
    attributes?: {
        className: string;
        duration?: number;
        fileName?: string;
        w?: number;  // width
        h?: number;  // height
    }[];
    size?: string;
    mimeType?: string;
}

export interface VideoMessage {
    media?: {
        document?: VideoDocument;
        video?: boolean;
    };
    message?: string;
    id: number;
}
