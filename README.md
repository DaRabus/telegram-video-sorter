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
- ⏱️ **Duration & Size Filtering**: Configurable min/max video duration and file size limits
- 🔄 **Advanced Duplicate Detection**: 
  - Fuzzy filename matching (85% similarity threshold)
  - Normalized comparison (ignores quality markers, codecs, part numbers)
  - Multi-criteria validation (filename + duration + file size)
  - Automatic duplicate replacement (keeps newest version)
- 🚀 **Rate Limit Optimization**: 
  - Intelligent caching reduces API calls by 90%+
  - Automatic retry with exponential backoff
  - FLOOD_WAIT error handling
- 🧹 **Cleanup Utilities**: Manual duplicate removal tools with dry-run support
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
  "sortedGroupName": "sorted_videos",
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
  "maxVideoDurationInSeconds": 36000,
  "minFileSizeMB": 10,
  "maxFileSizeMB": 2000,
  "maxForwards": 50,
  "dryRun": false,
  "skipCleanup": false,
  "sourceGroups": [],
  "duplicateDetection": {
    "checkDuration": true,
    "durationToleranceSeconds": 30,
    "checkFileSize": true,
    "fileSizeTolerancePercent": 5,
    "normalizeFilenames": true
  }
}
```

**Configuration options:**
- `sortedGroupName`: Name of the forum group to create/use for sorted videos (required)
- `dataDir`: Directory where all data files will be stored
- `sessionFile`: Path to the Telegram session file (relative to dataDir or absolute)
- `videoMatches`: Array of keywords to match in video filenames/descriptions (required)
- `videoExclusions`: Array of keywords to exclude videos (optional)
- `minVideoDurationInSeconds`: Minimum video duration in seconds (default: 300 = 5 minutes)
- `maxVideoDurationInSeconds`: Maximum video duration in seconds (optional, default: unlimited)
- `minFileSizeMB`: Minimum file size in megabytes (optional, default: no minimum)
- `maxFileSizeMB`: Maximum file size in megabytes (optional, default: no maximum)
- `maxForwards`: Maximum videos to forward per run
- `dryRun`: Set to `true` to test without forwarding messages
- `skipCleanup`: Set to `true` to skip forum cleanup phase for faster runs (default: false)
- `sourceGroups`: Optional array of specific group IDs to monitor (empty = all groups)
- `duplicateDetection`: Advanced duplicate detection settings:
  - `checkDuration`: Compare video duration (default: true)
  - `durationToleranceSeconds`: Duration match tolerance in seconds (default: 30)
  - `checkFileSize`: Compare file size (default: true)
  - `fileSizeTolerancePercent`: File size match tolerance as percentage (default: 5)
  - `normalizeFilenames`: Use enhanced filename normalization (default: true)

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

### Option 2: Docker Setup (Building from Source)

```bash
# Start the sorter (runs in background)
docker compose up -d

# View logs
docker compose logs -f

# Stop the sorter
docker compose down
```

### Option 3: Docker Setup (Using Pre-built Release)

If you downloaded a pre-built Docker image from the releases:

1. **Download the Docker image archive:**
   ```bash
   # Download telegram-video-sorter-docker-release-v-X.X.X.X-TIMESTAMP.tar.gz from GitHub releases
   ```

2. **Load the Docker image:**
   ```bash
   gunzip -c telegram-video-sorter-docker-release-v-X.X.X.X-TIMESTAMP.tar.gz | docker load
   ```

3. **Create your environment file:**
   ```bash
   # Create .env file with your credentials
   cat > .env << 'EOF'
   TELEGRAM_APP_ID=your_app_id_here
   TELEGRAM_APP_API_HASH=your_api_hash_here
   EOF
   ```

4. **Prepare the session file:**
   ```bash
   # Create session directory
   mkdir -p session

   # Copy your existing telegram_session.session file into the session/ folder
   # OR generate a new session (see Step 4: Generate Telegram Session above)
   ```

5. **Ensure docker-compose.yml and telegram-sorter-config.json exist:**
   ```bash
   # Download docker-compose.yml and telegram-sorter-config.json.example from the repository
   # Configure telegram-sorter-config.json according to your needs
   ```

6. **Start the container:**
   ```bash
   docker compose up -d

   # View logs
   docker logs --follow telegram-video-sorter
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
│   ├── generate-session.ts     # Session generation script
│   └── cleanup-duplicates.ts   # Duplicate cleanup utility
├── dist/                       # Compiled JavaScript files
├── telegram-sorter-config.json # Configuration file
├── package.json                # Node.js dependencies
├── tsconfig.json               # TypeScript configuration
├── Dockerfile                  # Docker image definition
├── docker-compose.yml          # Docker Compose configuration
├── .env                        # Environment variables (create from .env.example)
├── .env.example                # Example environment file
├── clear-database.sh           # Database reset utility
├── CLEANUP.md                  # Cleanup utility documentation
├── DUPLICATE_DETECTION.md      # Duplicate detection guide
├── RATE_LIMIT_OPTIMIZATION.md  # Rate limiting documentation
├── session/                    # Session storage directory
│   └── telegram_session.session
└── data/                       # Data persistence directory
    ├── processed-messages.db   # SQLite database (processed messages & videos)
    ├── forum-group-cache.json  # Forum group and topic mappings
    └── forwarding-log.json     # Detailed forwarding log
```

## Logs and Tracking

The sorter maintains several files for tracking:

- **processed-messages.db**: SQLite database storing processed message IDs and video metadata
- **forum-group-cache.json**: Forum group and topic mappings
- **forwarding-log.json**: Detailed log of all forwarded videos

## Utilities

### Cleanup Duplicates

Manually scan and remove duplicate videos from your forum topics:

```bash
# Dry run (preview what would be deleted)
npm run cleanup

# Actually delete duplicates
npm run cleanup-delete
```

The cleanup utility:
- Scans all forum topics for duplicate videos
- Uses the same fuzzy matching as the main sorter (85% similarity)
- Keeps the **oldest** message in each duplicate group
- Supports dry-run mode for safe testing

See [CLEANUP.md](CLEANUP.md) for detailed documentation.

### Clear Database

Reset your database to reprocess all videos with improved duplicate detection:

```bash
./clear-database.sh
```

This script:
- Creates a timestamped backup of your database
- Clears processed messages and videos
- Keeps your forum group cache (topic mappings)
- Allows videos to be reprocessed with the latest normalization algorithm

**Note**: After clearing, run `npm start` to reprocess videos.

## Advanced Features

### Intelligent Duplicate Detection

The sorter uses a sophisticated multi-stage duplicate detection system:

**1. Enhanced Filename Normalization**

Removes quality markers and metadata before comparison:
- Resolution: `1080p`, `720p`, `4k`, `UHD`, etc.
- Codecs: `x264`, `x265`, `HEVC`, `H.264`, etc.
- Audio: `AAC`, `AC3`, `DTS`, etc.
- Metadata: `.XXX`, `.PRT`, `.COM`, etc.
- Part numbers: `part001`, `pt1`, etc.

**Example**: These filenames are detected as duplicates:
```
MyVideo.1080p.HEVC.x265.XXX.part001.mp4
myvideo.720p.x264.mp4
MyVideo.4k.HEVC.part002.mp4
```

**2. Fuzzy String Matching**

Handles truncated Telegram filenames with 85% similarity threshold:
```
Video - Long Title with Description Charge.mp4  → 89% similar
Video - Long Title with Description Char.mp4    → Detected as duplicate
```

**3. Multi-Criteria Validation**

Videos must match:
- Filename similarity ≥ 85%
- Duration within ±30 seconds (configurable)
- File size within ±5% (configurable)

**4. Automatic Duplicate Replacement**

When forwarding a video:
1. Checks for duplicates in each target topic
2. Deletes all existing duplicates from Telegram
3. Forwards the new version
4. Result: Each topic always has only the **newest** version

See [DUPLICATE_DETECTION.md](DUPLICATE_DETECTION.md) for more details.

### Rate Limit Optimization

The sorter includes intelligent API usage optimization:

**Topic Message Caching**
- Caches messages from each topic on first access
- Subsequent duplicate checks use cached data
- Reduces API calls by **90%+**
- Example: 100 videos in 10 topics = only 10 API calls instead of 1,000+

**Retry Logic**
- Automatic retry with exponential backoff (5s, 10s, 20s)
- Handles FLOOD_WAIT errors gracefully
- Respects Telegram's rate limit responses

**Configurable Delays**
- 500ms delays between API batches
- Prevents hitting rate limits
- Maintains stable processing speed

See [RATE_LIMIT_OPTIMIZATION.md](RATE_LIMIT_OPTIMIZATION.md) for technical details.

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

