// =============================================================================
// types.ts — Core data shapes for elizaos-plugin-bluesky-search
// =============================================================================

/** Raw Bluesky post object returned by feed endpoints */
export interface BlueskyPost {
  uri: string;
  cid: string;
  author: BlueskyAuthor;
  record: {
    text: string;
    createdAt: string;
    reply?: {
      root: { uri: string; cid: string };
      parent: { uri: string; cid: string };
    };
    embed?: any;
    facets?: BlueskyFacet[];
  };
  likeCount: number;
  repostCount: number;
  replyCount: number;
  indexedAt: string;
  /** Present from getPostThread */
  parent?: any;
  /** Present from getPostThread */
  replies?: any[];
}

/** Bluesky actor/author representation */
export interface BlueskyAuthor {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  description?: string;
  followerCount?: number;
  followsCount?: number;
  postsCount?: number;
}

/** Rich text facet (mentions, links, hashtags) */
export interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{
    $type: string;
    [key: string]: any;
  }>;
}

/** Notification from app.bsky.notification.listNotifications */
export interface BlueskyNotification {
  uri: string;
  cid: string;
  author: BlueskyAuthor;
  reason: string;          // "like" | "repost" | "follow" | "reply" | "quote"
  reasonSubject?: string;  // URI of the subject post
  record: any;
  isRead: boolean;
  indexedAt: string;
}

/** Response envelope for app.bsky.feed.searchPosts */
export interface BlueskySearchResponse {
  posts: BlueskyPost[];
  cursor?: string;
}

/** Response envelope for app.bsky.notification.listNotifications */
export interface BlueskyNotificationsResponse {
  notifications: BlueskyNotification[];
  cursor?: string;
}

/** Response envelope for app.bsky.feed.getTimeline / getAuthorFeed */
export interface BlueskyFeedResponse {
  feed: Array<{ post: BlueskyPost; reply?: any }>;
  cursor?: string;
}

/** Response envelope for app.bsky.feed.getPostThread */
export interface BlueskyThreadResponse {
  thread: {
    post: BlueskyPost;
    parent?: any;
    replies?: Array<{ post: BlueskyPost }>;
  };
}

/** Response envelope for com.atproto.repo.createRecord */
export interface BlueskyCreateRecordResponse {
  uri: string;
  cid: string;
}

/** Response envelope for com.atproto.server.createSession */
export interface BlueskySessionResponse {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
  email?: string;
}

/** A post enriched with a score and suggested angle (Scout delivery format) */
export interface ScoredBlueskyPost extends BlueskyPost {
  score: number;             // 1.0–10.0, one decimal place
  suggestedAngle: string;    // one sentence, data-first
  postUrl: string;           // https://bsky.app/profile/HANDLE/post/RKEY
  matchedKeywords: string[];
}

/** Runtime configuration built inside the action handler */
export interface PluginConfig {
  /** Bluesky handle (e.g., archon.bsky.social) */
  handle: string;
  /** Bluesky app password (generated in Settings) */
  appPassword: string;
  /** Base URL of the target agent's DirectClient, e.g. http://archon_euro_container:3000 */
  archonUrl: string;
  /** Agent ID of the target agent receiving the scout queue */
  archonAgentId: string;
  /** Bluesky DID of the target agent for inbound engagement detection (Tier 3) */
  archonBlueskyDid: string;
  /** Path to the generated target list JSON (Tier 2 profile monitoring) */
  targetListJsonPath: string;
  /** Default keyword corpus for Tier 1 topic discovery when RAG knowledge is unavailable */
  defaultKeywords: string[];
  /** Maximum number of results in the ranked queue (default: 5) */
  maxResults: number;
  /** Minimum score threshold; casts below this are discarded unless fallback triggers (default: 6) */
  minScore: number;
  /** If true, skip Tier 2 (profile/feed monitoring) */
  disableTier2?: boolean;
  /** If true, skip Tier 3 (inbound engagement/notification detection) */
  disableTier3?: boolean;
  /** Maximum number of keywords to use in Tier 1 search */
  keywordLimit?: number;
}

/**
 * Runtime state for the three-tier discovery coordinator.
 * Persisted to a JSON file between cycles.
 */
export interface ScoutCycleState {
  cycleNumber: number;
  lastCycleAt: string;
  lastKeywords: string[];
}

/** Monitored profile for Tier 2 discovery */
export interface MonitoredProfile {
  did: string;
  handle: string;
  name?: string;
  category: string;
  weight: number;
}

/** Configuration for post creation action */
export interface PostConfig {
  enabled: boolean;
  maxPerDay: number;
  minIntervalMinutes: number;
  maxThreadPosts: number;
}

/** Post state tracking */
export interface PostState {
  lastPostAt: string;
  todayCount: number;
  todayDate: string;
}

/** Configuration for like action */
export interface LikeConfig {
  enabled: boolean;
  maxPerDay: number;
  batchSize: number;
}

/** Like state tracking */
export interface LikeState {
  lastLikeAt: string;
  todayCount: number;
  todayDate: string;
  likedUris: string[];  // Permanent dedup set
}

/** Like cycle result */
export interface LikeCycleResult {
  liked: number;
  skipped: number;
  remainingBudget: number;
  errors: string[];
}

/** Configuration for reply action */
export interface ReplyConfig {
  enabled: boolean;
  maxPerDay: number;
}

/** Reply target */
export interface ReplyTarget {
  uri: string;
  cid: string;
  text: string;
  authorHandle: string;
  authorDid: string;
  suggestedAngle?: string;
}

/** Reply state tracking */
export interface ReplyState {
  lastReplyAt: string;
  todayCount: number;
  todayDate: string;
}

/** Reply cycle result */
export interface ReplyCycleResult {
  replied: number;
  errors: string[];
}

/** Configuration for follow action */
export interface FollowConfig {
  enabled: boolean;
  maxPerDay: number;
}

/** Follow state tracking */
export interface FollowState {
  lastFollowAt: string;
  todayCount: number;
  todayDate: string;
  followedDids: string[];
}

/** Follow cycle result */
export interface FollowCycleResult {
  followed: number;
  unfollowed: number;
  errors: string[];
}

/** State for unfollow (reciprocal check) actions */
export interface UnfollowState {
  lastUnfollowCycle: string;
  unfollowCount: number;
  unfollowedDids: string[];
}
