# ElizaOS Plugin — Bluesky Search

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A plugin for [ElizaOS](https://elizaos.ai) agents that provides Bluesky engagement discovery, posting, liking, replying, and follow/unfollow actions via the AT Protocol XRPC API.

## Features

| Action | Description |
|--------|-------------|
| `SEARCH_BLUESKY` | **Three-tier discovery** — keyword search, feed/profile monitoring, and notification polling with scoring |
| `LIKE_BLUESKY` | Batch like posts with daily budget tracking and deduplication |
| `REPLY_BLUESKY` | Reply to Scout-identified posts with proper thread references |
| `FOLLOW_BLUESKY` | Follow profiles from watchlist with daily budget limits |
| `UNFOLLOW_BLUESKY` | Weekly reciprocal unfollow check — unfollows accounts that don't follow back |
| `POST_BLUESKY` | Autonomous text posts, link card embeds, and multi-post threads |

## Installation

```bash
npm install elizaos-plugin-bluesky-search
```

Or add to your `package.json`:

```json
{
  "dependencies": {
    "elizaos-plugin-bluesky-search": "^0.1.0"
  }
}
```

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `BLUESKY_HANDLE` | Your Bluesky handle (e.g., `archon.bsky.social`) |
| `BLUESKY_APP_PASSWORD` | Bluesky app password (generate in Settings → App Passwords) |

### Plugin Registration

```typescript
import { blueskySearchPlugin } from "elizaos-plugin-bluesky-search";

// Register with your ElizaOS agent runtime
runtime.registerPlugin(blueskySearchPlugin);
```

### Optional Configuration

See [`.env.example`](.env.example) for the full list of configuration options.

## Architecture

### Three-Tier Scout (`SEARCH_BLUESKY`)

```
Tier 1: Keyword Search
  └─ searchPosts() across configured keyword corpus
  └─ Scores posts by engagement + keyword match + author authority

Tier 2: Feed/Profile Monitoring
  └─ getTimeline() or getAuthorFeed() for monitored profiles
  └─ Weighted scoring for high-priority sources

Tier 3: Notification Polling
  └─ listNotifications() for inbound engagement (replies, quotes, mentions)
  └─ High-priority scoring for direct interactions
```

Results are merged, deduplicated, ranked by score, and delivered to an Archon agent via the `/ingest` endpoint.

### State Persistence

Each action maintains daily budget tracking via JSON state files in the `data/` directory:
- `data/bluesky_scout_state.json`
- `data/bluesky_post_state.json`
- `data/bluesky_like_state.json`
- `data/bluesky_reply_state.json`
- `data/bluesky_follow_state.json`
- `data/bluesky_unfollow_state.json`

## Development

```bash
# Install dependencies
npm install

# Type-check the codebase
npm run typecheck

# Build
npm run build

# Clean build artifacts
npm run clean
```

### Prerequisites

- Node.js >= 18
- npm >= 9

## License

MIT — see [LICENSE](LICENSE) for details.
