// =============================================================================
// replyBluesky.ts — REPLY_BLUESKY ElizaOS Action
//
// Reply to Bluesky posts identified by the Scout or from notifications.
//
// Flow:
//   1. Build ReplyConfig from runtime settings
//   2. Load ReplyState from disk, check daily budget
//   3. Get reply targets from message context (Scout deliveries)
//   4. For each target, verify the post still exists
//   5. Post reply with proper root/parent refs
//   6. Update and persist ReplyState
//   7. Return formatted cycle results via callback
//
// Logging: [BLUESKY-PLUGIN] replyBluesky: ...
// =============================================================================

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { replyToPost, getPostThread, ensureSession } from "../lib/blueskyClient.js";
import type { ReplyConfig, ReplyState, ReplyCycleResult, ReplyTarget } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DAILY = 10;
const STATE_FILE = "data/bluesky_reply_state.json";

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function loadReplyState(): ReplyState | null {
  try {
    const fs = require("fs");
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function saveReplyState(state: ReplyState): void {
  try {
    const fs = require("fs");
    const dir = require("path").dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    elizaLogger.warn(`[BLUESKY-PLUGIN] replyBluesky: failed to save state — ${err}`);
  }
}

function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Config Builder
// ---------------------------------------------------------------------------

function buildConfig(runtime: IAgentRuntime): ReplyConfig {
  return {
    enabled: runtime.getSetting("BLUESKY_REPLY_ENABLED") !== "false",
    maxPerDay: parseInt(runtime.getSetting("BLUESKY_REPLY_MAX_DAY") || String(DEFAULT_MAX_DAILY)),
  };
}

// ==========================================================================
// Action Definition
// ==========================================================================

export const replyBlueskyAction: Action = {
  name: "REPLY_BLUESKY",
  similes: ["REPLY_BLUESKY", "REPLY_POST_BLUESKY"],
  description: "Reply to Bluesky posts identified by the Scout with data-backed commentary.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const config = buildConfig(runtime);
    if (!config.enabled) {
      elizaLogger.info(`[BLUESKY-PLUGIN] replyBluesky: disabled by config`);
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
    elizaLogger.info(`[BLUESKY-PLUGIN] replyBluesky: START`);

    try {
      const config = buildConfig(runtime);

      // Authenticate
      const handle = runtime.getSetting("BLUESKY_HANDLE")!;
      const appPassword = runtime.getSetting("BLUESKY_APP_PASSWORD")!;
      await ensureSession(handle, appPassword);

      // Load state and check budget
      const replyState = loadReplyState() || {
        lastReplyAt: "",
        todayCount: 0,
        todayDate: getToday(),
      };

      if (replyState.todayDate !== getToday()) {
        replyState.todayCount = 0;
        replyState.todayDate = getToday();
      }

      if (replyState.todayCount >= config.maxPerDay) {
        elizaLogger.info(
          `[BLUESKY-PLUGIN] replyBluesky: daily budget exhausted — ${replyState.todayCount}/${config.maxPerDay}`
        );
        if (callback) {
          callback({
            text: `Reply cycle skipped: daily budget exhausted`,
            content: { replied: 0, errors: [] },
          });
        }
        return;
      }

      // Parse reply targets from message
      const targets: ReplyTarget[] = [];
      if (message?.content?.text) {
        // Expected format: ROOT_URI|ROOT_CID|PARENT_URI|PARENT_CID|TEXT
        const lines = message.content.text.split("\n");
        for (const line of lines) {
          const parts = line.split("|");
          if (parts.length >= 5) {
            targets.push({
              uri: parts[0],
              cid: parts[1],
              text: parts[4],
              authorHandle: parts[2] || "",
              authorDid: parts[3] || "",
            });
          }
        }
      }

      if (targets.length === 0) {
        elizaLogger.info(`[BLUESKY-PLUGIN] replyBluesky: no reply targets provided`);
        if (callback) {
          callback({
            text: `Reply cycle: no targets provided`,
            content: { replied: 0, errors: [] },
          });
        }
        return;
      }

      const remaining = config.maxPerDay - replyState.todayCount;
      const toReply = targets.slice(0, remaining);

      // Since we need LLM-generated reply text, we check if the message
      // already contains generated content from the handler context
      // If not, we use a template approach for now
      let replied = 0;
      const errors: string[] = [];

      for (const target of toReply) {
        // Verify the post thread exists
        const thread = await getPostThread(target.uri, 1);
        if (!thread?.thread?.post) {
          elizaLogger.warn(
            `[BLUESKY-PLUGIN] replyBluesky: target post not found — ${target.uri}`
          );
          errors.push(`Post not found: ${target.uri}`);
          continue;
        }

        // Get root and parent references for reply structure
        const post = thread.thread.post;
        const root = post.record.reply?.root || { uri: target.uri, cid: target.cid };
        const parent = { uri: target.uri, cid: target.cid };

        // The reply text should come from LLM generation in the handler template
        // For now, we use the suggested text from the target
        const replyText = target.text.substring(0, 300); // Bluesky 300-char limit

        const result = await replyToPost(replyText, root, parent);
        if (result) {
          replied++;
          elizaLogger.info(
            `[BLUESKY-PLUGIN] replyBluesky: replied to @${target.authorHandle} — ${result.uri}`
          );
        } else {
          errors.push(`Failed to reply: ${target.uri}`);
        }

        // Small delay between replies
        await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
      }

      // Update state
      replyState.todayCount += replied;
      replyState.lastReplyAt = new Date().toISOString();
      saveReplyState(replyState);

      const result: ReplyCycleResult = { replied, errors };

      const duration = Date.now() - startTime;
      elizaLogger.info(
        `[BLUESKY-PLUGIN] replyBluesky: COMPLETE — replied=${replied}, errors=${errors.length}, ${duration}ms`
      );

      if (callback) {
        callback({
          text: `Replied to ${replied} Bluesky posts. Daily: ${replyState.todayCount}/${config.maxPerDay}.`,
          content: result,
        });
      }
    } catch (err) {
      elizaLogger.error(`[BLUESKY-PLUGIN] replyBluesky: ERROR — ${err}`);
      if (callback) {
        callback({
          text: `Reply cycle failed: ${err}`,
          content: { error: String(err) },
        });
      }
    }
  },
};
