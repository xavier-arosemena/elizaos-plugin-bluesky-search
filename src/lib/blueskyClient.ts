// =============================================================================
// blueskyClient.ts — AT Protocol XRPC API wrappers (raw fetch, no SDK)
//
// Read operations: searchPosts, getTimeline, getAuthorFeed, getPostThread,
//                  listNotifications, getProfile, getFollowers, getFollows,
//                  searchActors
// Write operations: createPost, likePost, repostPost, followUser,
//                   unfollowUser, deleteRecord
//
// AT Protocol base: https://bsky.social/xrpc/
// Docs: https://docs.bsky.app/
// =============================================================================

import { elizaLogger } from "@elizaos/core";
import type {
  BlueskyPost,
  BlueskyAuthor,
  BlueskyNotification,
  BlueskySearchResponse,
  BlueskyNotificationsResponse,
  BlueskyFeedResponse,
  BlueskyThreadResponse,
  BlueskyCreateRecordResponse,
  BlueskySessionResponse,
} from "../types.js";

const BSKY_BASE = "https://bsky.social";
const BSKY_XRPC = `${BSKY_BASE}/xrpc`;

// Simple delay utility for rate-limit backoff
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ==========================================================================
// Session Management
// ==========================================================================

let _session: { accessJwt: string; refreshJwt: string; did: string; handle: string } | null = null;

/**
 * Create an AT Protocol session (login).
 * POST /com.atproto.server.createSession
 */
export async function createSession(
  handle: string,
  appPassword: string
): Promise<BlueskySessionResponse> {
  const startTime = Date.now();
  try {
    const res = await fetch(`${BSKY_XRPC}/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: handle, password: appPassword }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      elizaLogger.error(
        `[BLUESKY-PLUGIN] blueskyClient: createSession FAILED — ${res.status}: ${text} after ${Date.now() - startTime}ms`
      );
      throw new Error(`Bluesky auth failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as BlueskySessionResponse;
    _session = {
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
      did: data.did,
      handle: data.handle,
    };
    elizaLogger.info(
      `[BLUESKY-PLUGIN] blueskyClient: session created — did=${data.did}, handle=${data.handle}`
    );
    return data;
  } catch (err) {
    elizaLogger.error(
      `[BLUESKY-PLUGIN] blueskyClient: createSession ERROR — ${err} after ${Date.now() - startTime}ms`
    );
    throw err;
  }
}

/**
 * Refresh an AT Protocol session token.
 * POST /com.atproto.server.refreshSession
 */
export async function refreshSession(): Promise<void> {
  if (!_session?.refreshJwt) {
    throw new Error("No refresh token available");
  }
  const startTime = Date.now();
  try {
    const res = await fetch(`${BSKY_XRPC}/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_session.refreshJwt}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      elizaLogger.error(
        `[BLUESKY-PLUGIN] blueskyClient: refreshSession FAILED — ${res.status} after ${Date.now() - startTime}ms`
      );
      _session = null;
      return;
    }

    const data = (await res.json()) as BlueskySessionResponse;
    _session.accessJwt = data.accessJwt;
    _session.refreshJwt = data.refreshJwt;
    elizaLogger.info(
      `[BLUESKY-PLUGIN] blueskyClient: session refreshed — did=${data.did}`
    );
  } catch (err) {
    elizaLogger.error(
      `[BLUESKY-PLUGIN] blueskyClient: refreshSession ERROR — ${err}`
    );
    _session = null;
  }
}

/**
 * Ensure we have a valid session, refreshing if needed.
 */
export async function ensureSession(handle: string, appPassword: string): Promise<void> {
  if (!_session?.accessJwt) {
    await createSession(handle, appPassword);
  }
}

/**
 * Get the current session DID.
 */
export function getSessionDid(): string | null {
  return _session?.did ?? null;
}

/**
 * Get the current session access token.
 */
export function getSessionToken(): string | null {
  return _session?.accessJwt ?? null;
}

/**
 * Clear the session (useful for testing or forced re-auth).
 */
export function clearSession(): void {
  _session = null;
}

// ==========================================================================
// Internal helpers
// ==========================================================================

/**
 * Build common XRPC request headers with auth.
 */
function xrpcHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${_session?.accessJwt ?? ""}`,
  };
}

interface XrpcFetchOptions {
  method: "GET" | "POST";
  nsid: string;
  /** Query params (GET only) */
  params?: Record<string, any>;
  /** Request body (POST only) */
  body?: unknown;
}

/**
 * Core XRPC fetch with automatic 401 refresh and 429 rate-limit retry.
 * Shared by both xrpcGet and xrpcPost to eliminate code duplication.
 */
async function xrpcFetch<T>(options: XrpcFetchOptions): Promise<T | null> {
  const { method, nsid, params, body } = options;

  if (!_session?.accessJwt) {
    elizaLogger.warn(`[BLUESKY-PLUGIN] blueskyClient: no session — call ensureSession first`);
    return null;
  }

  // Build URL (query params for GET)
  const url = method === "GET"
    ? (() => {
        const u = new URL(`${BSKY_XRPC}/${nsid}`);
        if (params) {
          Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
          });
        }
        return u.toString();
      })()
    : `${BSKY_XRPC}/${nsid}`;

  // Build fetch init
  const init: RequestInit & { signal: AbortSignal } = {
    method,
    headers: xrpcHeaders(),
    signal: AbortSignal.timeout(15_000),
  };
  if (body && method === "POST") {
    init.body = JSON.stringify(body);
  }

  const startTime = Date.now();
  const methodLabel = method;

  try {
    let res = await fetch(url, init);

    // Auto-refresh on 401 and retry once
    if (res.status === 401) {
      elizaLogger.warn(`[BLUESKY-PLUGIN] blueskyClient: 401 on ${nsid} — refreshing session`);
      await refreshSession();
      if (!_session?.accessJwt) return null;
      init.headers = xrpcHeaders();
      res = await fetch(url, init);
      if (!res.ok) {
        elizaLogger.warn(
          `[BLUESKY-PLUGIN] blueskyClient: ${methodLabel} ${nsid} retry FAILED — ${res.status}`
        );
        return null;
      }
      const data = (await res.json()) as T;
      elizaLogger.info(
        `[BLUESKY-PLUGIN] blueskyClient: ${methodLabel} ${nsid} — ${Date.now() - startTime}ms (retry after refresh)`
      );
      return data;
    }

    // Rate-limit retry
    if (res.status === 429) {
      elizaLogger.warn(
        `[BLUESKY-PLUGIN] blueskyClient: ${methodLabel} ${nsid} rate-limited — backing off 2s`
      );
      await sleep(2000);
      res = await fetch(url, init);
      if (!res.ok) {
        elizaLogger.warn(
          `[BLUESKY-PLUGIN] blueskyClient: ${methodLabel} ${nsid} rate-limit retry FAILED — ${res.status}`
        );
        return null;
      }
      const data = (await res.json()) as T;
      elizaLogger.info(
        `[BLUESKY-PLUGIN] blueskyClient: ${methodLabel} ${nsid} — ${Date.now() - startTime}ms (rate-limit retry)`
      );
      return data;
    }

    // Other errors
    if (!res.ok) {
      elizaLogger.warn(
        `[BLUESKY-PLUGIN] blueskyClient: ${methodLabel} ${nsid} FAILED — ${res.status} after ${Date.now() - startTime}ms`
      );
      return null;
    }

    // Success
    const data = (await res.json()) as T;
    elizaLogger.info(
      `[BLUESKY-PLUGIN] blueskyClient: ${methodLabel} ${nsid} — ${Date.now() - startTime}ms`
    );
    return data;
  } catch (err) {
    elizaLogger.warn(
      `[BLUESKY-PLUGIN] blueskyClient: ${methodLabel} ${nsid} ERROR — ${err} after ${Date.now() - startTime}ms`
    );
    return null;
  }
}

/**
 * Generic XRPC GET request (delegates to xrpcFetch for retry logic).
 */
async function xrpcGet<T>(nsid: string, params?: Record<string, any>): Promise<T | null> {
  return xrpcFetch<T>({ method: "GET", nsid, params });
}

/**
 * Generic XRPC POST request (delegates to xrpcFetch for retry logic).
 */
async function xrpcPost<T>(nsid: string, body?: unknown): Promise<T | null> {
  return xrpcFetch<T>({ method: "POST", nsid, body });
}

// ==========================================================================
// Read Operations
// ==========================================================================

/**
 * Search Bluesky posts matching `query`.
 * GET /app.bsky.feed.searchPosts?q=QUERY&limit=LIMIT
 */
export async function searchPosts(query: string, limit = 25): Promise<BlueskyPost[]> {
  const data = await xrpcGet<BlueskySearchResponse>("app.bsky.feed.searchPosts", { q: query, limit });
  return data?.posts ?? [];
}

/**
 * Get the authenticated user's timeline (home feed).
 * GET /app.bsky.feed.getTimeline?limit=LIMIT
 */
export async function getTimeline(limit = 30): Promise<BlueskyPost[]> {
  const data = await xrpcGet<BlueskyFeedResponse>("app.bsky.feed.getTimeline", { limit });
  return data?.feed?.map((f) => f.post) ?? [];
}

/**
 * Get posts from a specific author.
 * GET /app.bsky.feed.getAuthorFeed?actor=DID&limit=LIMIT
 */
export async function getAuthorFeed(actor: string, limit = 30): Promise<BlueskyPost[]> {
  const data = await xrpcGet<BlueskyFeedResponse>("app.bsky.feed.getAuthorFeed", { actor, limit });
  return data?.feed?.map((f) => f.post) ?? [];
}

/**
 * Get a post thread (post + replies).
 * GET /app.bsky.feed.getPostThread?uri=URI&depth=DEPTH
 */
export async function getPostThread(uri: string, depth = 1): Promise<BlueskyThreadResponse | null> {
  return xrpcGet<BlueskyThreadResponse>("app.bsky.feed.getPostThread", { uri, depth });
}

/**
 * Get Bluesky notifications.
 * GET /app.bsky.notification.listNotifications?limit=LIMIT
 */
export async function listNotifications(limit = 50): Promise<BlueskyNotification[]> {
  const data = await xrpcGet<BlueskyNotificationsResponse>(
    "app.bsky.notification.listNotifications",
    { limit }
  );
  return data?.notifications ?? [];
}

/**
 * Get an actor's profile.
 * GET /app.bsky.actor.getProfile?actor=DID
 */
export async function getProfile(actor: string): Promise<BlueskyAuthor | null> {
  const data = await xrpcGet<any>("app.bsky.actor.getProfile", { actor });
  if (!data) return null;
  return {
    did: data.did,
    handle: data.handle,
    displayName: data.displayName,
    avatar: data.avatar,
    description: data.description,
    followerCount: data.followersCount,
    followsCount: data.followsCount,
    postsCount: data.postsCount,
  };
}

/**
 * Get an actor's followers.
 * GET /app.bsky.graph.getFollowers?actor=DID&limit=LIMIT
 */
export async function getFollowers(
  actor: string,
  limit = 50
): Promise<BlueskyAuthor[]> {
  const data = await xrpcGet<any>("app.bsky.graph.getFollowers", { actor, limit });
  return data?.followers?.map((f: any) => ({
    did: f.did,
    handle: f.handle,
    displayName: f.displayName,
    avatar: f.avatar,
    followerCount: f.followersCount ?? f.labels?.followerCount,
  })) ?? [];
}

/**
 * Get actors a user follows.
 * GET /app.bsky.graph.getFollows?actor=DID&limit=LIMIT
 */
export async function getFollows(
  actor: string,
  limit = 50
): Promise<BlueskyAuthor[]> {
  const data = await xrpcGet<any>("app.bsky.graph.getFollows", { actor, limit });
  return data?.follows?.map((f: any) => ({
    did: f.did,
    handle: f.handle,
    displayName: f.displayName,
    avatar: f.avatar,
    followerCount: f.followersCount,
  })) ?? [];
}

/**
 * Search for actors by name/keyword.
 * GET /app.bsky.actor.searchActors?q=QUERY&limit=LIMIT
 */
export async function searchActors(query: string, limit = 25): Promise<BlueskyAuthor[]> {
  const data = await xrpcGet<any>("app.bsky.actor.searchActors", { q: query, limit });
  return data?.actors?.map((a: any) => ({
    did: a.did,
    handle: a.handle,
    displayName: a.displayName,
    avatar: a.avatar,
    description: a.description,
    followerCount: a.followersCount,
  })) ?? [];
}

// ==========================================================================
// Write Operations
// ==========================================================================

/**
 * Create a new Bluesky post (text, reply, or with embed).
 * POST /com.atproto.repo.createRecord
 * Collection: app.bsky.feed.post
 */
export async function createPost(
  text: string,
  options?: {
    replyTo?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } };
    embed?: any;
    facets?: any[];
  }
): Promise<BlueskyCreateRecordResponse | null> {
  if (!_session?.did) {
    elizaLogger.warn(`[BLUESKY-PLUGIN] blueskyClient: createPost — no session DID`);
    return null;
  }

  const record: any = {
    text,
    createdAt: new Date().toISOString(),
  };

  if (options?.replyTo) record.reply = options.replyTo;
  if (options?.embed) record.embed = options.embed;
  if (options?.facets) record.facets = options.facets;

  return xrpcPost<BlueskyCreateRecordResponse>("com.atproto.repo.createRecord", {
    repo: _session.did,
    collection: "app.bsky.feed.post",
    record,
  });
}

/**
 * Create a reply to an existing post.
 */
export async function replyToPost(
  text: string,
  root: { uri: string; cid: string },
  parent: { uri: string; cid: string }
): Promise<BlueskyCreateRecordResponse | null> {
  return createPost(text, {
    replyTo: { root, parent },
  });
}

/**
 * Like a Bluesky post.
 * POST /com.atproto.repo.createRecord
 * Collection: app.bsky.feed.like
 *
 * Subject is the post's URI and CID.
 */
export async function likePost(
  subjectUri: string,
  subjectCid: string
): Promise<BlueskyCreateRecordResponse | null> {
  if (!_session?.did) return null;

  return xrpcPost<BlueskyCreateRecordResponse>("com.atproto.repo.createRecord", {
    repo: _session.did,
    collection: "app.bsky.feed.like",
    record: {
      subject: { uri: subjectUri, cid: subjectCid },
      createdAt: new Date().toISOString(),
    },
  });
}

/**
 * Repost a Bluesky post.
 * POST /com.atproto.repo.createRecord
 * Collection: app.bsky.feed.repost
 */
export async function repostPost(
  subjectUri: string,
  subjectCid: string
): Promise<BlueskyCreateRecordResponse | null> {
  if (!_session?.did) return null;

  return xrpcPost<BlueskyCreateRecordResponse>("com.atproto.repo.createRecord", {
    repo: _session.did,
    collection: "app.bsky.feed.repost",
    record: {
      subject: { uri: subjectUri, cid: subjectCid },
      createdAt: new Date().toISOString(),
    },
  });
}

/**
 * Follow a Bluesky user.
 * POST /com.atproto.repo.createRecord
 * Collection: app.bsky.graph.follow
 */
export async function followUser(
  subjectDid: string
): Promise<BlueskyCreateRecordResponse | null> {
  if (!_session?.did) return null;

  return xrpcPost<BlueskyCreateRecordResponse>("com.atproto.repo.createRecord", {
    repo: _session.did,
    collection: "app.bsky.graph.follow",
    record: {
      subject: subjectDid,
      createdAt: new Date().toISOString(),
    },
  });
}

/**
 * Unfollow a Bluesky user (delete follow record).
 * POST /com.atproto.repo.deleteRecord
 */
export async function unfollowUser(
  followRecordUri: string
): Promise<boolean> {
  if (!_session?.did) return false;

  const result = await xrpcPost<any>("com.atproto.repo.deleteRecord", {
    repo: _session.did,
    collection: "app.bsky.graph.follow",
    rkey: followRecordUri.split("/").pop(),
  });

  return result !== null;
}

/**
 * Delete any record by URI.
 * POST /com.atproto.repo.deleteRecord
 */
export async function deleteRecord(
  collection: string,
  rkey: string
): Promise<boolean> {
  if (!_session?.did) return false;

  const result = await xrpcPost<any>("com.atproto.repo.deleteRecord", {
    repo: _session.did,
    collection,
    rkey,
  });

  return result !== null;
}

// ==========================================================================
// Batch Operations
// ==========================================================================

/**
 * Batch like multiple posts.
 * Returns count of successful likes.
 */
export async function batchLikePosts(
  targets: Array<{ uri: string; cid: string }>
): Promise<number> {
  let successCount = 0;
  for (const target of targets) {
    const result = await likePost(target.uri, target.cid);
    if (result) successCount++;
    // Small delay between likes to avoid rate limits
    await sleep(500 + Math.random() * 1000);
  }
  return successCount;
}

/**
 * Batch follow multiple users.
 * Returns count of successful follows.
 */
export async function batchFollowUsers(dids: string[]): Promise<number> {
  let successCount = 0;
  for (const did of dids) {
    const result = await followUser(did);
    if (result) successCount++;
    await sleep(500 + Math.random() * 1000);
  }
  return successCount;
}

// ==========================================================================
// Record Listing (for unfollow support)
// ==========================================================================

/**
 * List follow records created by the authenticated user.
 * GET /com.atproto.repo.listRecords?repo=DID&collection=app.bsky.graph.follow&limit=LIMIT
 *
 * Returns an array of { uri, cid, subject } where subject is the DID being followed.
 */
export async function listFollowRecords(
  limit = 100
): Promise<Array<{ uri: string; cid: string; subject: string }>> {
  if (!_session?.did) return [];

  const data = await xrpcGet<any>("com.atproto.repo.listRecords", {
    repo: _session.did,
    collection: "app.bsky.graph.follow",
    limit,
  });

  if (!data?.records) return [];
  return data.records.map((r: any) => ({
    uri: r.uri,
    cid: r.cid,
    subject: r.value?.subject ?? "",
  }));
}

// ==========================================================================
// Utility
// ==========================================================================

/**
 * Extract the post URI (rkey) from a Bluesky AT URI.
 * at://did:plc:abc123/app.bsky.feed.post/rkey123
 */
export function extractRkey(uri: string): string {
  return uri.split("/").pop() ?? "";
}

/**
 * Build a bluesky.app URL from a post URI.
 * at://did:plc:abc123/app.bsky.feed.post/rkey123
 * → https://bsky.app/profile/did:plc:abc123/post/rkey123
 */
export function buildPostUrl(didOrHandle: string, postUri: string): string {
  const rkey = extractRkey(postUri);
  return `https://bsky.app/profile/${didOrHandle}/post/${rkey}`;
}
