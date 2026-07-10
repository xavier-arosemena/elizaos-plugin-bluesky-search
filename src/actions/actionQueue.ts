// =============================================================================
// actionQueue.ts — Shared action queue utilities for Bluesky actions
//
// Scripts write pending actions here so handlers can read actual content/targets
// instead of relying on LLM response text (which is broken by design).
//
// Queue file: data/bluesky_action_queue.json
// =============================================================================

import fs from "fs";
import path from "path";
import { elizaLogger } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTION_QUEUE_FILE = "data/bluesky_action_queue.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionQueue {
  posts?: Array<{
    content: string;
    type: "text" | "thread";
    dedupKey?: string;
  }>;
  likes?: Array<{ uri: string; cid: string }>;
  replies?: Array<{
    rootUri: string;
    rootCid: string;
    parentUri: string;
    parentCid: string;
    text: string;
  }>;
  follows?: string[];
}

// ---------------------------------------------------------------------------
// Queue persistence
// ---------------------------------------------------------------------------

function loadActionQueue(): ActionQueue {
  try {
    if (fs.existsSync(ACTION_QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(ACTION_QUEUE_FILE, "utf-8"));
    }
  } catch (err) {
    elizaLogger.warn(`[BLUESKY-PLUGIN] actionQueue: failed to load — ${err}`);
  }
  return {};
}

function saveActionQueue(queue: ActionQueue): void {
  try {
    const dir = path.dirname(ACTION_QUEUE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ACTION_QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (err) {
    elizaLogger.warn(`[BLUESKY-PLUGIN] actionQueue: failed to save — ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Pop functions — each returns data and removes it from the queue
// ---------------------------------------------------------------------------

/**
 * Pop the first pending post from the action queue.
 */
export function popQueuedPost(): { content: string; type: "text" | "thread" } | null {
  const queue = loadActionQueue();
  if (!queue.posts || queue.posts.length === 0) return null;
  const post = queue.posts.shift()!;
  saveActionQueue(queue);
  elizaLogger.info(
    `[BLUESKY-PLUGIN] actionQueue: popped queued post (${post.type}, ${post.content.length} chars)`
  );
  return { content: post.content, type: post.type };
}

/**
 * Pop pending like targets from the action queue. Returns all and clears the queue.
 */
export function popQueuedLikes(): Array<{ uri: string; cid: string }> | null {
  const queue = loadActionQueue();
  if (!queue.likes || queue.likes.length === 0) return null;
  const likes = [...queue.likes];
  queue.likes = [];
  saveActionQueue(queue);
  elizaLogger.info(`[BLUESKY-PLUGIN] actionQueue: popped ${likes.length} queued likes`);
  return likes;
}

/**
 * Pop the first pending reply target from the action queue.
 */
export function popQueuedReply(): {
  rootUri: string;
  rootCid: string;
  parentUri: string;
  parentCid: string;
  text: string;
} | null {
  const queue = loadActionQueue();
  if (!queue.replies || queue.replies.length === 0) return null;
  const reply = queue.replies.shift()!;
  saveActionQueue(queue);
  elizaLogger.info(`[BLUESKY-PLUGIN] actionQueue: popped queued reply for ${reply.parentUri}`);
  return reply;
}

/**
 * Pop pending follow DIDs from the action queue. Returns all and clears the queue.
 */
export function popQueuedFollows(): string[] | null {
  const queue = loadActionQueue();
  if (!queue.follows || queue.follows.length === 0) return null;
  const follows = [...queue.follows];
  queue.follows = [];
  saveActionQueue(queue);
  elizaLogger.info(`[BLUESKY-PLUGIN] actionQueue: popped ${follows.length} queued follows`);
  return follows;
}
