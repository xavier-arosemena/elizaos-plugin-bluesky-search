// =============================================================================
// likeBluesky.ts — LIKE_BLUESKY ElizaOS Action
//
// Batch like posts on Bluesky with daily budget tracking.
//
// Flow:
//   1. Build LikeConfig from runtime settings
//   2. Load LikeState from disk, check rolling 24h window
//   3. Check daily budget; if exhausted, return early
//   4. Get target posts from Scout deliveries (via Archon memories)
//   5. Filter already-liked URIs
//   6. Batch like remaining posts
//   7. Update and persist LikeState
//   8. Return formatted cycle results via callback
//
// Logging: [BLUESKY-PLUGIN] likeBluesky: ...
// =============================================================================

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { batchLikePosts, ensureSession } from "../lib/blueskyClient.js";
import type { LikeConfig, LikeState, LikeCycleResult } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DAILY = 50;
const DEFAULT_BATCH_SIZE = 10;
const STATE_FILE = "data/bluesky_like_state.json";

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function loadLikeState(): LikeState | null {
  try {
    const fs = require("fs");
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function saveLikeState(state: LikeState): void {
  try {
    const fs = require("fs");
    const dir = require("path").dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    elizaLogger.warn(`[BLUESKY-PLUGIN] likeBluesky: failed to save state — ${err}`);
  }
}

function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Config Builder
// ---------------------------------------------------------------------------

function buildConfig(runtime: IAgentRuntime): LikeConfig {
  return {
    enabled: runtime.getSetting("BLUESKY_LIKE_ENABLED") !== "false",
    maxPerDay: parseInt(runtime.getSetting("BLUESKY_LIKE_MAX_DAY") || String(DEFAULT_MAX_DAILY)),
    batchSize: parseInt(runtime.getSetting("BLUESKY_LIKE_BATCH_SIZE") || String(DEFAULT_BATCH_SIZE)),
  };
}

// ==========================================================================
// Action Definition
// ==========================================================================

export const likeBlueskyAction: Action = {
  name: "LIKE_BLUESKY",
  similes: ["LIKE_BLUESKY", "BATCH_LIKE_BLUESKY"],
  description: "Batch like Bluesky posts with daily budget tracking and dedup.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const config = buildConfig(runtime);
    if (!config.enabled) {
      elizaLogger.info(`[BLUESKY-PLUGIN] likeBluesky: disabled by config`);
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
    elizaLogger.info(`[BLUESKY-PLUGIN] likeBluesky: START`);

    try {
      const config = buildConfig(runtime);

      // Authenticate
      const handle = runtime.getSetting("BLUESKY_HANDLE")!;
      const appPassword = runtime.getSetting("BLUESKY_APP_PASSWORD")!;
      await ensureSession(handle, appPassword);

      // Load state and check budget
      const state = loadLikeState() || {
        lastLikeAt: "",
        todayCount: 0,
        todayDate: getToday(),
        likedUris: [],
      };

      // Reset daily counter if new day
      if (state.todayDate !== getToday()) {
        state.todayCount = 0;
        state.todayDate = getToday();
      }

      // Check budget
      if (state.todayCount >= config.maxPerDay) {
        elizaLogger.info(
          `[BLUESKY-PLUGIN] likeBluesky: daily budget exhausted — ${state.todayCount}/${config.maxPerDay}`
        );
        if (callback) {
          callback({
            text: `Like cycle skipped: daily budget exhausted (${state.todayCount}/${config.maxPerDay})`,
            content: { liked: 0, skipped: 0, remainingBudget: 0 },
          });
        }
        return;
      }

      const remaining = config.maxPerDay - state.todayCount;
      const batchSize = Math.min(config.batchSize, remaining);

      // Get target URIs from Scout deliveries (via message context)
      // In practice, these come from the Scout's search results
      // For now, we process based on whatever targets are provided
      const targets: Array<{ uri: string; cid: string }> = [];

      // Parse targets from message text if provided
      if (message?.content?.text) {
        const lines = message.content.text.split("\n");
        for (const line of lines) {
          // Expected format: URI|CID or just URI
          const parts = line.trim().split("|");
          if (parts.length >= 2) {
            targets.push({ uri: parts[0], cid: parts[1] });
          }
        }
      }

      elizaLogger.info(
        `[BLUESKY-PLUGIN] likeBluesky: targets=${targets.length}, budget=${config.maxPerDay}, remaining=${remaining}, batch=${batchSize}`
      );

      // Filter already-liked
      const newTargets = targets.filter((t) => !state.likedUris.includes(t.uri));
      const toLike = newTargets.slice(0, batchSize);

      if (toLike.length === 0) {
        elizaLogger.info(`[BLUESKY-PLUGIN] likeBluesky: no new targets to like`);
        if (callback) {
          callback({
            text: `Like cycle: no new targets to like`,
            content: { liked: 0, skipped: targets.length, remainingBudget: remaining },
          });
        }
        return;
      }

      // Execute likes
      const liked = await batchLikePosts(toLike);

      // Update state
      state.todayCount += liked;
      state.lastLikeAt = new Date().toISOString();
      state.likedUris.push(...toLike.map((t) => t.uri));
      saveLikeState(state);

      const result: LikeCycleResult = {
        liked,
        skipped: toLike.length - liked,
        remainingBudget: config.maxPerDay - state.todayCount,
        errors: [],
      };

      const duration = Date.now() - startTime;
      elizaLogger.info(
        `[BLUESKY-PLUGIN] likeBluesky: COMPLETE — liked=${liked}, remaining=${result.remainingBudget}, ${duration}ms`
      );

      if (callback) {
        callback({
          text: `Liked ${liked} Bluesky posts. Daily: ${state.todayCount}/${config.maxPerDay}. Remaining budget: ${result.remainingBudget}.`,
          content: result,
        });
      }
    } catch (err) {
      elizaLogger.error(`[BLUESKY-PLUGIN] likeBluesky: ERROR — ${err}`);
      if (callback) {
        callback({
          text: `Like cycle failed: ${err}`,
          content: { error: String(err) },
        });
      }
    }
  },
};
