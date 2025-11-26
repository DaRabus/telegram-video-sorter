# Telegram Video Sorter

[![Node.js CI](https://github.com/DaRabus/telegram-video-sorter/actions/workflows/ci.yml/badge.svg)](https://github.com/DaRabus/telegram-video-sorter/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](https://polyformproject.org/licenses/noncommercial/1.0.0/)
[![Docker](https://img.shields.io/badge/Docker-Supported-blue?logo=docker)](https://hub.docker.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue?logo=typescript)](https://www.typescriptlang.org/)

**Automate your Telegram video organization.**

This tool scans your Telegram groups and channels for videos matching specific keywords and automatically organizes them into a dedicated forum group with topic-based sorting. It's perfect for archiving, content curation, and managing large collections of videos.

**Key Keywords:** Telegram Bot, Video Sorter, Automation, GramJS, TypeScript, Docker, Content Curation, Forum Groups.

## Features

- 🔍 **Smart Scanning**: Scans Telegram groups/channels for videos matching your keywords
- 📁 **Auto-Organization**: Automatically creates forum groups and topics for each category
- 🚫 **Content Filtering**: Filters out unwanted content using exclusion keywords
- ⏱️ **Duration Filtering**: Configurable minimum video duration to skip short clips
- 🔄 **Duplicate Removal**: Intelligent duplicate detection and removal
- 📊 **Statistics**: Detailed logging and statistics of processed videos
- 🐳 **Docker Ready**: Easy deployment with Docker and Docker Compose

## Prerequisites

- Node.js 22+ (for local setup preferably with [NVM](https://github.com/nvm-sh/nvm))
- Docker and Docker Compose (for Docker setup)
- Telegram account
- Telegram API credentials (from https://my.telegram.org/apps)

## Setup

### Step 1: Get Telegram API Credentials

1. Visit https://my.telegram.org/apps
2. Log in with your phone number
3. Create a new application
4. Note down your `api_id` and `api_hash`

### Step 2: Configure Environment Variables

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and fill in your API credentials:
   ```env
   TELEGRAM_APP_ID=your_app_id_here
   TELEGRAM_APP_API_HASH=your_api_hash_here
   ```

### Step 3: Configure Sorter Settings

Create `telegram-sorter-config.json` from the example:

```bash
cp telegram-sorter-config.json.example telegram-sorter-config.json
```

Edit the configuration:

```json
{
  "dataDir": "data",
  "sessionFile": "data/telegram_session.session",
  "videoMatches": [
    "keyword1",
    "keyword2",
    "keyword3"
  ],
  "videoExclusions": [
    "compilation",
    "preview"
  ],
  "minVideoDurationInSeconds": 300,
  "maxForwards": 50,
  "dryRun": false,
  "sourceGroups": []
}
```

**Configuration options:**
- `dataDir`: Directory where all data files will be stored
- `sessionFile`: Path to the Telegram session file
- `videoMatches`: Array of keywords to match in video filenames/descriptions (required)
- `videoExclusions`: Array of keywords to exclude videos (optional)
- `minVideoDurationInSeconds`: Minimum video duration in seconds (default: 300 = 5 minutes)
- `maxForwards`: Maximum videos to forward per run
- `dryRun`: Set to `true` to test without forwarding messages
- `sourceGroups`: Optional array of specific group IDs to monitor (empty = all groups)

### Step 4: Generate Telegram Session

**This step must be done manually before running the sorter!**

#### Local Setup:

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Generate session (you'll need to enter your phone number and verification code)
npm run generate-session
```

#### Docker Setup:

```bash
# Build the image
docker compose build

# Generate session interactively
docker compose run --rm telegram-sorter npm run generate-session
```

This will create a session file (location defined in `telegram-sorter-config.json`) that the sorter uses to authenticate.

## Running the Sorter

### Option 1: Local Setup

```bash
# Install dependencies (if not already done)
npm install

# Build the project
npm run build

# Run the sorter
npm start

# Or run directly with ts-node (for development)
npm run debug-sort-videos
```

### Option 2: Docker Setup

```bash
# Start the sorter (runs in background)
docker compose up -d

# View logs
docker compose logs -f

# Stop the sorter
docker compose down
```

## How It Works

1. **Connection**: Connects to Telegram using your session
2. **Scanning**: Scans all accessible groups/channels (or specified ones)
3. **Matching**: Checks videos against `VIDEO_MATCHES` keywords
4. **Filtering**: Excludes videos containing `VIDEO_EXCLUSIONS` keywords
5. **Duration Check**: Skips videos shorter than `minVideoDurationInSeconds`
6. **Duplicate Detection**: Prevents forwarding duplicate videos
7. **Organization**: Creates topics in a forum group for each keyword
8. **Forwarding**: Forwards matched videos to appropriate topics
9. **Cleanup**: Removes duplicate and excluded videos from forum group

## Environment Variables

All environment variables are for **secrets only** - configuration is in `telegram-sorter-config.json`.

### Required

- `TELEGRAM_APP_ID`: Your Telegram API ID
- `TELEGRAM_APP_API_HASH`: Your Telegram API hash

## File Structure

```
telegram-video-sorter/
├── src/
│   ├── types/                  # TypeScript interfaces
│   ├── utils/                  # Utility functions
│   ├── services/               # Business logic services
│   ├── telegram-sorter.ts      # Main sorter script
│   └── generate-session.ts     # Session generation script
├── dist/                       # Compiled JavaScript files
├── telegram-sorter-config.json # Configuration file
├── package.json                # Node.js dependencies
├── tsconfig.json               # TypeScript configuration
├── Dockerfile                  # Docker image definition
├── docker compose.yml          # Docker Compose configuration
├── .env                        # Environment variables (create from .env.example)
├── .env.example                # Example environment file
├── session/                    # Session storage directory
│   └── telegram_session.session
└── data/                       # Data persistence directory
    ├── processed-messages.txt
    ├── processed-messages-videos.txt
    ├── forum-group-cache.json
    └── forwarding-log.json
```

## Logs and Tracking

The sorter maintains several files for tracking:

- **processed-messages.txt**: IDs of all processed messages
- **processed-messages-videos.txt**: Filenames of processed videos
- **forum-group-cache.json**: Forum group and topic mappings
- **forwarding-log.json**: Detailed log of all forwarded videos

## Troubleshooting

### Session file not found

```
❌ Error loading session file from: ...
```

**Solution**: Run the session generation script first (see Step 4).

### Missing video matches

```
❌ ERROR: videoMatches in config file is not set or empty!
```

**Solution**: Make sure your `telegram-sorter-config.json` file exists and contains a `videoMatches` array with keywords.

### Rate limiting

The sorter includes automatic rate limiting protection. If you encounter issues:
- Reduce `maxForwards` in the config
- Increase delays in the code
- Wait a few hours before running again

### No videos being forwarded

1. Check your `videoMatches` keywords in the config file are correct
2. Verify `minVideoDurationInSeconds` isn't too high
3. Enable `dryRun: true` to see what would be matched
4. Check the console output for matching statistics


## Security Notes

- ⚠️ **Never commit your `.env` file or session files to version control**
- Keep your `TELEGRAM_APP_ID` and `TELEGRAM_APP_API_HASH` secret
- The session file grants full access to your Telegram account
- Use environment-specific `.env` files for different deployments

## Development

### Running Tests

```bash
npm test
```

## License

This project is licensed under the **PolyForm Noncommercial License 1.0.0**.

### Commercial Use
This software is free for non-commercial use. For commercial use, please contact the author to obtain a commercial license.

