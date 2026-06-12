// =============================================================================
// followBluesky.ts — FOLLOW_BLUESKY ElizaOS Action
//
// Follow/unfollow Bluesky users with daily budget tracking.
//
// Flow:
//   1. Build FollowConfig from runtime settings
//   2. Load FollowState from disk, check daily budget
//   3. Get target DIDs from message context (Scout watchlist)
//   4. Batch follow new users
//   5. Optionally unfollow users (weekly cycle)
//   6. Update and persist FollowState
//   7. Return formatted cycle results via callback
//
// Logging: [BLUESKY-PLUGIN] followBluesky: ...
// =============================================================================

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { batchFollowUsers, ensureSession } from "../lib/blueskyClient.js";
import { loadState, saveState, getToday, resetDailyCounter } from "../lib/stateStore.js";
import type { FollowConfig, FollowState, FollowCycleResult } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DAILY = 30;
const STATE_FILE = "data/bluesky_follow_state.json";

// ---------------------------------------------------------------------------
// Config Builder
// ---------------------------------------------------------------------------

function buildConfig(runtime: IAgentRuntime): FollowConfig {
  return {
    enabled: runtime.getSetting("BLUESKY_FOLLOW_ENABLED") !== "false",
    maxPerDay: parseInt(runtime.getSetting("BLUESKY_FOLLOW_MAX_DAY") || String(DEFAULT_MAX_DAILY)),
  };
}

// ==========================================================================
// Action Definition
// ==========================================================================

export const followBlueskyAction: Action = {
  name: "FOLLOW_BLUESKY",
  similes: ["FOLLOW_BLUESKY", "FOLLOW_USER_BLUESKY"],
  description: "Follow Bluesky users from Scout watchlist with daily budget tracking.",
  examples: [],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const config = buildConfig(runtime);
    if (!config.enabled) {
      elizaLogger.info(`[BLUESKY-PLUGIN] followBluesky: disabled by config`);
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
    elizaLogger.info(`[BLUESKY-PLUGIN] followBluesky: START`);

    try {
      const config = buildConfig(runtime);

      // Authenticate
      const handle = runtime.getSetting("BLUESKY_HANDLE")!;
      const appPassword = runtime.getSetting("BLUESKY_APP_PASSWORD")!;
      await ensureSession(handle, appPassword);

      // Load state and check budget
      const followState = resetDailyCounter(
        loadState<FollowState>(STATE_FILE) || {
          lastFollowAt: "",
          todayCount: 0,
          todayDate: getToday(),
          followedDids: [],
        }
      );

      if (followState.todayCount >= config.maxPerDay) {
        elizaLogger.info(
          `[BLUESKY-PLUGIN] followBluesky: daily budget exhausted — ${followState.todayCount}/${config.maxPerDay}`
        );
        if (callback) {
          callback({
            text: `Follow cycle skipped: daily budget exhausted`,
            content: { followed: 0, unfollowed: 0, errors: [] },
          });
        }
        return;
      }

      // Get target DIDs from message context
      const targetDids: string[] = [];
      if (message?.content?.text) {
        const lines = message.content.text.split("\n");
        for (const line of lines) {
          const did = line.trim();
          if (did.startsWith("did:")) {
            targetDids.push(did);
          }
        }
      }

      if (targetDids.length === 0) {
        elizaLogger.info(`[BLUESKY-PLUGIN] followBluesky: no follow targets provided`);
        if (callback) {
          callback({
            text: `Follow cycle: no targets provided`,
            content: { followed: 0, unfollowed: 0, errors: [] },
          });
        }
        return;
      }

      // Filter already-followed
      const newDids = targetDids.filter((d) => !followState.followedDids.includes(d));
      const remaining = config.maxPerDay - followState.todayCount;
      const toFollow = newDids.slice(0, remaining);

      // Execute follows
      const followed = await batchFollowUsers(toFollow);

      // Update state
      followState.todayCount += followed;
      followState.lastFollowAt = new Date().toISOString();
      followState.followedDids.push(...toFollow.slice(0, followed));
      saveState(STATE_FILE, followState);

      const result: FollowCycleResult = {
        followed,
        unfollowed: 0,
        errors: [],
      };

      const duration = Date.now() - startTime;
      elizaLogger.info(
        `[BLUESKY-PLUGIN] followBluesky: COMPLETE — followed=${followed}/${toFollow.length}, ${duration}ms`
      );

      if (callback) {
        callback({
          text: `Followed ${followed} Bluesky users. Daily: ${followState.todayCount}/${config.maxPerDay}.`,
          content: result,
        });
      }
    } catch (err) {
      elizaLogger.error(`[BLUESKY-PLUGIN] followBluesky: ERROR — ${err}`);
      if (callback) {
        callback({
          text: `Follow cycle failed: ${err}`,
          content: { error: String(err) },
        });
      }
    }
  },
};
