#!/usr/bin/env ts-node

import {TelegramClient} from 'telegram';
import {StringSession} from 'telegram/sessions';
import * as path from 'path';
import * as fs from 'fs';
import {config as loadEnv} from 'dotenv';
import {createReadlineInterface, question} from './utils/readline';

// Load environment variables
loadEnv({path: path.join(process.cwd(), '.env')});

const apiId = Number.parseInt(process.env.TELEGRAM_APP_ID ?? '', 10);
const apiHash = process.env.TELEGRAM_APP_API_HASH ?? '';

if (!apiId || !apiHash) {
    console.error('❌ Missing Telegram credentials in .env');
    console.error('Required: TELEGRAM_APP_ID, TELEGRAM_APP_API_HASH');
    console.error('\nGet your credentials from: https://my.telegram.org/apps');
    process.exit(1);
}

const stringSession = new StringSession('');
const dataDir = path.join(process.cwd(), 'session');
const sessionFile = path.join(dataDir, 'telegram_session.session');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, {recursive: true});
}

(async () => {
    console.log('🚀 Telegram Session Generator');
    console.log('=============================\n');
    console.log('Starting Telegram client...\n');

    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5
    });

    const rl = createReadlineInterface();

    await client.start({
        phoneNumber: async () => {
            return await question(
                rl,
                '📱 Please enter your phone number (international format, e.g., +1234567890): '
            );
        },
        password: async () => {
            return await question(rl, '🔐 Please enter your 2FA password (if enabled): ');
        },
        phoneCode: async () => {
            return await question(rl, '💬 Please enter the verification code you received: ');
        },
        onError: (err: Error) => console.error('❌ Error:', err)
    });

    rl.close();

    const sessionString = client.session.save() as unknown as string;

    // Save to file
    fs.writeFileSync(sessionFile, sessionString, 'utf-8');

    console.log('\n✅ You are now connected!');
    console.log(`✅ Session saved to: ${sessionFile}`);
    console.log('\n📝 Next steps:');
    console.log('  1. Update telegram-sorter-config.json with your settings');
    console.log('  2. Run: npm run sort-videos');
    console.log(
        '\n⚠️  Keep your session file secure and never commit it to git!\n'
    );

    await client.disconnect();
    process.exit(0);
})();
