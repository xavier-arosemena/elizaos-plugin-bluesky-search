// =============================================================================
// elizaos-plugin-bluesky-search — ElizaOS plugin entry point
//
// Registers five actions:
//   SEARCH_BLUESKY    — Topic discovery and opportunity scoring (3 tiers)
//   LIKE_BLUESKY      — Batch like with daily budget, rate limiting, dedup
//   REPLY_BLUESKY     — Reply on Scout-identified posts
//   FOLLOW_BLUESKY    — Follow profiles from Scout watchlist
//   UNFOLLOW_BLUESKY  — Weekly reciprocal unfollow check
//   POST_BLUESKY      — Create autonomous posts (text, link cards, threads)
// =============================================================================

import type { Plugin } from "@elizaos/core";
import { searchBlueskyAction } from "./actions/searchBluesky.js";
import { likeBlueskyAction } from "./actions/likeBluesky.js";
import { replyBlueskyAction } from "./actions/replyBluesky.js";
import { followBlueskyAction } from "./actions/followBluesky.js";
import { unfollowBlueskyAction } from "./actions/unfollowBluesky.js";
import { postBlueskyAction } from "./actions/postBluesky.js";

export const blueskySearchPlugin: Plugin = {
  name: "elizaos-plugin-bluesky-search",
  description:
    "Bluesky engagement discovery, post, like, reply, and follow/unfollow actions " +
    "via AT Protocol XRPC API. Provides SEARCH_BLUESKY (3-tier scout/topic discovery), " +
    "LIKE_BLUESKY (batch like with daily budget), REPLY_BLUESKY " +
    "(public replies on Scout-identified posts), FOLLOW_BLUESKY " +
    "(follow profiles from Scout watchlist), UNFOLLOW_BLUESKY " +
    "(weekly reciprocal unfollow check), and POST_BLUESKY " +
    "(autonomous text posts, link cards, and thread creation).",
  actions: [
    searchBlueskyAction,
    likeBlueskyAction,
    replyBlueskyAction,
    followBlueskyAction,
    unfollowBlueskyAction,
    postBlueskyAction,
  ],
  evaluators: [],
  providers: [],
};

export default blueskySearchPlugin;

// Named re-exports for convenience
export { searchBlueskyAction } from "./actions/searchBluesky.js";
export { likeBlueskyAction } from "./actions/likeBluesky.js";
export { replyBlueskyAction } from "./actions/replyBluesky.js";
export { followBlueskyAction } from "./actions/followBluesky.js";
export { unfollowBlueskyAction } from "./actions/unfollowBluesky.js";
export { postBlueskyAction } from "./actions/postBluesky.js";
export { createPluginConfig } from "./actions/searchBluesky.js";
export {
  createSession,
  refreshSession,
  ensureSession,
  searchPosts,
  getTimeline,
  getAuthorFeed,
  getPostThread,
  listNotifications,
  getProfile,
  getFollowers,
  getFollows,
  searchActors,
  createPost,
  replyToPost,
  likePost,
  repostPost,
  followUser,
  unfollowUser,
  batchLikePosts,
  batchFollowUsers,
  buildPostUrl,
  listFollowRecords,
} from "./lib/blueskyClient.js";
export type {
  BlueskyPost,
  BlueskyAuthor,
  BlueskyNotification,
  BlueskyFacet,
  BlueskySearchResponse,
  BlueskyNotificationsResponse,
  BlueskyFeedResponse,
  BlueskyThreadResponse,
  BlueskyCreateRecordResponse,
  BlueskySessionResponse,
  ScoredBlueskyPost,
  PluginConfig,
  ScoutCycleState,
  MonitoredProfile,
  PostConfig,
  PostState,
  LikeConfig,
  LikeState,
  LikeCycleResult,
  ReplyConfig,
  ReplyTarget,
  ReplyState,
  ReplyCycleResult,
  FollowConfig,
  FollowState,
  FollowCycleResult,
} from "./types.js";
