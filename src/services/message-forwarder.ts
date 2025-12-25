import {Api, TelegramClient} from 'telegram';
import {ForwardingLogger, MessageStorage} from './storage';
import {handleRateLimit} from '../utils/helpers';

export class MessageForwarder {
    constructor(
        private client: TelegramClient,
        private storage: MessageStorage,
        private logger: ForwardingLogger,
    ) {
    }

    async forwardMessage(
        sourceId: number,
        messageId: number,
        forumGroupId: number,
        targetTopicId: number,
        fileName: string,
        topicName: string,
        duration: number,
        sizeMB: number,
        normalizedName: string
    ): Promise<boolean> {
        let retryCount = 0;
        let success = false;

        while (!success && retryCount <= 3) {
            try {
                const channelPeer = new Api.PeerChannel({
                    channelId: BigInt(Math.abs(forumGroupId)) as any
                });

                await this.client.invoke(
                    new Api.messages.ForwardMessages({
                        fromPeer: sourceId,
                        id: [messageId],
                        toPeer: channelPeer,
                        topMsgId: targetTopicId,
                        randomId: [Math.floor(Math.random() * 1e16) as any]
                    })
                );

                console.log(`     ✅ Forwarded to "${topicName}"`);

                this.logger.logForwardedVideo({
                    timestamp: new Date().toISOString(),
                    fileName,
                    matchedKeyword: topicName,
                    topicName: topicName,
                    sourceGroup: sourceId,
                    duration,
                    sizeMB: Number(sizeMB.toFixed(2))
                });

                // Note: Video is already saved to storage before forwarding (in video-processor.ts)
                // to prevent race conditions with duplicate detection
                success = true;
            } catch (error) {
                const shouldRetry = await handleRateLimit(error, retryCount);
                if (shouldRetry) {
                    retryCount++;
                } else {
                    console.error(`     ❌ Error forwarding message:`, error);
                    break;
                }
            }
        }

        return success;
    }
}
