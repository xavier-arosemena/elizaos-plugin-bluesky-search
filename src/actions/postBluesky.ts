// =============================================================================
// postBluesky.ts — POST_BLUESKY ElizaOS Action
//
// Create new Bluesky posts autonomously. Supports text-only posts,
// link card embeds, and multi-post threads.
//
// Flow:
//   1. Build PostConfig from runtime settings
//   2. Load PostState from disk, check daily budget
//   3. Get post content from message context or action queue
//   4. If thread content (multiple segments), create post chain
//   5. If link embed, format external embed
//   6. Post via createPost
//   7. Update and persist PostState
//   8. Return formatted results via callback
//
// Logging: [BLUESKY-PLUGIN] postBluesky: ...
// =============================================================================

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { createPost, ensureSession } from "../lib/blueskyClient.js";
import type { PostConfig, PostState } from "../types.js";
import fs from "fs";
import path from "path";
import { popQueuedPost } from "./actionQueue.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DAILY = 5;
const DEFAULT_MIN_INTERVAL_MIN = 60;
const DEFAULT_MAX_THREAD_POSTS = 5;
const STATE_FILE = "data/bluesky_post_state.json";

// Shared action queue — scripts write pre-formatted content here
// to bypass the LLM content-generation chain (see bluesky_post_cycle.sh)
const ACTION_QUEUE_FILE = "data/bluesky_action_queue.json";

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function loadPostState(): PostState | null {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function savePostState(state: PostState): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    elizaLogger.warn(`[BLUESKY-PLUGIN] postBluesky: failed to save state — ${err}`);
  }
}

function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Action queue read is imported from ./actionQueue.js (popQueuedPost)
// Config Builder
// ---------------------------------------------------------------------------

function buildConfig(runtime: IAgentRuntime): PostConfig {
  return {
    enabled: runtime.getSetting("BLUESKY_POST_ENABLED") !== "false",
    maxPerDay: parseInt(runtime.getSetting("BLUESKY_POST_MAX_DAY") || String(DEFAULT_MAX_DAILY)),
    minIntervalMinutes: parseInt(
      runtime.getSetting("BLUESKY_POST_MIN_INTERVAL") || String(DEFAULT_MIN_INTERVAL_MIN)
    ),
    maxThreadPosts: parseInt(
      runtime.getSetting("BLUESKY_POST_MAX_THREAD") || String(DEFAULT_MAX_THREAD_POSTS)
    ),
  };
}

/**
 * Create an external link embed for a Bluesky post.
 */
function createLinkEmbed(url: string, title: string, description: string): any {
  return {
    $type: "app.bsky.embed.external",
    external: {
      uri: url,
      title: title.substring(0, 200),
      description: description.substring(0, 300),
    },
  };
}

// ==========================================================================
// Action Definition
// ==========================================================================

export const postBlueskyAction: Action = {
  name: "POST_BLUESKY",
  similes: ["POST_BLUESKY", "CREATE_POST_BLUESKY", "THREAD_BLUESKY"],
  description: "Create Bluesky posts (text, link cards, threads) autonomously.",
  examples: [],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const config = buildConfig(runtime);
    if (!config.enabled) {
      elizaLogger.info(`[BLUESKY-PLUGIN] postBluesky: disabled by config`);
      return false;
    }
    const handle = runtime.getSetting("BLUESKY_HANDLE");
    const appPassword = runtime.getSetting("BLUESKY_APP_PASSWORD");
    return !!(handle && appPassword);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: any,
    callback?: HandlerCallback
  ): Promise<void> => {
    const startTime = Date.now();
    elizaLogger.info(`[BLUESKY-PLUGIN] postBluesky: START`);

    try {
      const config = buildConfig(runtime);

      // Authenticate
      const handle = runtime.getSetting("BLUESKY_HANDLE")!;
      const appPassword = runtime.getSetting("BLUESKY_APP_PASSWORD")!;
      await ensureSession(handle, appPassword);

      // Load state and check budget
      const postState = loadPostState() || {
        lastPostAt: "",
        todayCount: 0,
        todayDate: getToday(),
      };

      if (postState.todayDate !== getToday()) {
        postState.todayCount = 0;
        postState.todayDate = getToday();
      }

      if (postState.todayCount >= config.maxPerDay) {
        elizaLogger.info(
          `[BLUESKY-PLUGIN] postBluesky: daily budget exhausted — ${postState.todayCount}/${config.maxPerDay}`
        );
        if (callback) {
          callback({
            text: `Post cycle skipped: daily budget exhausted (${postState.todayCount}/${config.maxPerDay})`,
            content: { posted: 0, threadPostCount: 0 },
          });
        }
        return;
      }

      // Check minimum interval
      if (postState.lastPostAt) {
        const elapsedMinutes =
          (Date.now() - new Date(postState.lastPostAt).getTime()) / 60000;
        if (elapsedMinutes < config.minIntervalMinutes) {
          elizaLogger.info(
            `[BLUESKY-PLUGIN] postBluesky: interval not met — ${elapsedMinutes.toFixed(1)}min < ${config.minIntervalMinutes}min`
          );
          if (callback) {
            callback({
              text: `Post cycle skipped: minimum interval not met`,
              content: { posted: 0, threadPostCount: 0 },
            });
          }
          return;
        }
      }

      // ---------------------------------------------------------------
      // STEP 1: Get post content
      // Priority: 1. Action queue (script-written) > 2. Message text (LLM)
      // ---------------------------------------------------------------
      let content = "";
      let isThread = false;

      const queuedPost = popQueuedPost();
      if (queuedPost) {
        // Content came from action queue — script prepared it directly
        content = queuedPost.content;
        isThread = queuedPost.type === "thread";
        elizaLogger.info(
          `[BLUESKY-PLUGIN] postBluesky: using queued post content (${content.length} chars)`
        );
      } else {
        // Fallback: Parse content from message text (LLM response)
        // Note: ElizaOS processActions() with Fix 5 forwards the LLM's
        // response content to the action handler. The LLM response text
        // SHOULD be the actual post content (see character.json prompt).
        let rawContent = message?.content?.text || "";
        // Sanitize: strip instruction prefixes that may leak from dispatch flow
        rawContent = rawContent.replace(/^\[(SCOUT|ANALYST|INVESTIGATOR)\s+DELIVERY\].*?\n/, "");
        rawContent = rawContent.replace(/^Execute the POST_BLUESKY action\..*/i, "");
        rawContent = rawContent.replace(/^(Create|Make|Write|Generate|Compose)\s+a\s+Bluesky\s+post\b.*/i, "");
        rawContent = rawContent.replace(/^(Post|Publish|Send)\s+(a\s+|to\s+)?Bluesky\b.*/i, "");
        content = rawContent.trim() || message?.content?.text || "";
        if (!content) {
          elizaLogger.warn(`[BLUESKY-PLUGIN] postBluesky: no content to post`);
          if (callback) {
            callback({
              text: `Post cycle: no content provided`,
              content: { posted: 0, threadPostCount: 0 },
            });
          }
          return;
        }

        // Check if this is thread content
        const THREAD_SEPARATOR = "---THREAD_SEPARATOR---";
        const segments = content.split(THREAD_SEPARATOR).map((s) => s.trim()).filter(Boolean);
        isThread = segments.length > 1;
      }

      // Check if this is a link card
      let isLinkCard = false;
      let linkEmbed: any = undefined;
      try {
        const parsed = JSON.parse(content);
        if (parsed.embedUrl && parsed.text) {
          isLinkCard = true;
          linkEmbed = createLinkEmbed(parsed.embedUrl, parsed.embedTitle || "", parsed.embedDescription || "");
        }
      } catch {
        // Not JSON — treat as plain text
      }

      // Determine how many posts to create
      const remaining = config.maxPerDay - postState.todayCount;
      const THREAD_SEPARATOR = "---THREAD_SEPARATOR---";
      const segments = content.split(THREAD_SEPARATOR).map((s) => s.trim()).filter(Boolean);
      const postsToCreate = isThread
        ? Math.min(segments.length, config.maxThreadPosts, remaining)
        : Math.min(1, remaining);

      if (postsToCreate === 0) {
        elizaLogger.info(
          `[BLUESKY-PLUGIN] postBluesky: no budget for posting — ${remaining} remaining`
        );
        if (callback) {
          callback({
            text: `Post cycle skipped: no remaining budget`,
            content: { posted: 0, threadPostCount: 0 },
          });
        }
        return;
      }

      // Create posts
      let posted = 0;
      let lastPostResult: { uri: string; cid: string } | null = null;

      if (isThread) {
        // Thread: first post is standalone, subsequent posts reply to previous
        for (let i = 0; i < postsToCreate; i++) {
          const text = segments[i].substring(0, 300); // Enforce 300-char limit

          if (i === 0) {
            // First post in thread
            const result = await createPost(text, linkEmbed ? { embed: linkEmbed } : undefined);
            if (result) {
              lastPostResult = result;
              posted++;
              elizaLogger.info(
                `[BLUESKY-PLUGIN] postBluesky: thread post ${i + 1}/${postsToCreate} — ${result.uri}`
              );
            }
          } else if (lastPostResult) {
            // Subsequent posts reply to the first post (thread root)
            const result = await createPost(text, {
              replyTo: {
                root: { uri: lastPostResult.uri, cid: lastPostResult.cid },
                parent: { uri: lastPostResult.uri, cid: lastPostResult.cid },
              },
            });
            if (result) {
              posted++;
              elizaLogger.info(
                `[BLUESKY-PLUGIN] postBluesky: thread post ${i + 1}/${postsToCreate} — ${result.uri}`
              );
            }
          }

          // Small delay between thread posts
          await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
        }
      } else if (isLinkCard) {
        // Link card post
        const linkCardContent: any = JSON.parse(content);
        const text = linkCardContent.text.substring(0, 300);
        const result = await createPost(text, { embed: linkEmbed });
        if (result) {
          posted++;
          elizaLogger.info(
            `[BLUESKY-PLUGIN] postBluesky: link card post — ${result.uri}`
          );
        }
      } else {
        // Simple text post
        const text = content.substring(0, 300);
        const result = await createPost(text);
        if (result) {
          posted++;
          elizaLogger.info(
            `[BLUESKY-PLUGIN] postBluesky: text post — ${result.uri}`
          );
        }
      }

      // Update state
      postState.todayCount += posted;
      postState.lastPostAt = new Date().toISOString();
      savePostState(postState);

      const duration = Date.now() - startTime;
      elizaLogger.info(
        `[BLUESKY-PLUGIN] postBluesky: COMPLETE — posted=${posted}, daily=${postState.todayCount}/${config.maxPerDay}, ${duration}ms`
      );

      if (callback) {
        callback({
          text: `Posted ${posted} item(s) to Bluesky. Daily: ${postState.todayCount}/${config.maxPerDay}.`,
          content: {
            posted,
            threadPostCount: isThread ? postsToCreate : 0,
            dailyCount: postState.todayCount,
            dailyLimit: config.maxPerDay,
          },
        });
      }
    } catch (err) {
      elizaLogger.error(`[BLUESKY-PLUGIN] postBluesky: ERROR — ${err}`);
      if (callback) {
        callback({
          text: `Post cycle failed: ${err}`,
          content: { error: String(err) },
        });
      }
    }
  },
};
