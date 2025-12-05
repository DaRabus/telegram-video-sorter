import * as fs from 'node:fs';
import {TelegramClient} from 'telegram';
import {StringSession} from 'telegram/sessions';

export class TelegramClientFactory {
    static createClient(sessionFile: string): TelegramClient {
        const apiId = Number.parseInt(process.env.TELEGRAM_APP_ID ?? '', 10);
        const apiHash = process.env.TELEGRAM_APP_API_HASH ?? '';

        if (!apiId || !apiHash) {
            console.error('Missing Telegram credentials in .env');
            console.error('Required: TELEGRAM_APP_ID, TELEGRAM_APP_API_HASH');
            console.error('\nGet your credentials from: https://my.telegram.org/apps');
            process.exit(1);
        }

        let sessionString = '';

        try {
            sessionString = fs.readFileSync(sessionFile, 'utf-8').trim();
        } catch {
            console.error(`❌ Error loading session file from: ${sessionFile}`);
            console.error('Please generate a session first with: npm run generate-session');
            process.exit(1);
        }

        const stringSession = new StringSession(sessionString);
        return new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 3
        });
    }
}
