# Changelog

## [0.1.0] - 2025-01-01

### Added
- Initial release with 6 ElizaOS actions:
  - `SEARCH_BLUESKY` — Three-tier topic discovery and opportunity scoring
  - `LIKE_BLUESKY` — Batch like with daily budget and dedup
  - `REPLY_BLUESKY` — Public replies on Scout-identified posts
  - `FOLLOW_BLUESKY` — Follow profiles from Scout watchlist
  - `UNFOLLOW_BLUESKY` — Reciprocal unfollow check
  - `POST_BLUESKY` — Autonomous posts (text, link cards, threads)
- AT Protocol XRPC API client (raw fetch, no SDK)
- State persistence for daily budget tracking

### Fixed
- `UNFOLLOW_BLUESKY` now properly calls the API to unfollow users via record lookup
- Replaced CJS `require("fs")` calls with ESM imports across all action files
- Removed redundant dynamic `import()` in searchBluesky Tier 3 handler
- Extracted duplicated state persistence logic into shared `stateStore.ts` utility
- Consolidated duplicate `getToday()` and daily reset logic into shared utilities

### Changed
- Enabled strict TypeScript mode (`strict: true`, `noImplicitAny: true`)
- Added `listFollowRecords` to Bluesky client for unfollow support
- Updated `package.json` with `files`, `engines`, `homepage`, `bugs`, `publishConfig`
- Added proper build pipeline with `outDir: dist` and `types` declaration
- Added `@types/node` to devDependencies
