export interface SortingConfig {
    sortedGroupName: string
    dataDir: string;
    sessionFile: string;
    videoMatches: string[];
    videoExclusions: string[];
    sourceGroups?: (string | number)[];
    minVideoDurationInSeconds: number;
    maxForwards: number;
    dryRun: boolean;
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
    }[];
    size?: string;
}

export interface VideoMessage {
    media?: {
        document?: VideoDocument;
        video?: boolean;
    };
    message?: string;
    id: number;
}
