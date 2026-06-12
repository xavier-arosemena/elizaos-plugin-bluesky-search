// =============================================================================
// searchBluesky.ts — SEARCH_BLUESKY ElizaOS Action
//
// Three-tier discovery system (matching Farcaster's SEARCH_FARCASTER pattern):
//   Tier 1 — Keyword-based search (searchPosts) with extracted topics
//   Tier 2 — Monitored feed/profile scan (getTimeline, getAuthorFeed)
//   Tier 3 — Notification polling (listNotifications)
//
// Flow:
//   1. Build PluginConfig from runtime settings
//   2. Extract keywords from agent knowledge (RAG)
//   3. Run Tier 1 search across all keywords
//   4. (If enabled) Run Tier 2 — check monitored feeds
//   5. (If enabled) Run Tier 3 — check notifications for inbound engagement
//   6. Merge, deduplicate, score, and rank results
//   7. Deliver top results to Archon via /ingest endpoint
//   8. Return summary via callback
//
// Logging: All logs use [BLUESKY-PLUGIN] and [SEARCH] prefixes.
// =============================================================================

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import {
  searchPosts,
  getAuthorFeed,
  getTimeline,
  listNotifications,
  buildPostUrl,
  ensureSession,
  getSessionDid,
  createSession,
} from "../lib/blueskyClient.js";
import type { PluginConfig, BlueskyPost, ScoredBlueskyPost, ScoutCycleState, MonitoredProfile } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_KEYWORDS = [
  "European Union regulation",
  "AI policy Europe",
  "digital sovereignty",
  "EU tech",
  "European innovation",
  "GDPR",
  "Digital Services Act",
  "European competitiveness",
  "tech policy Brussels",
  "open source Europe",
  "European data strategy",
  "EU AI Act",
  "cybersecurity EU",
  "European digital identity",
  "green tech Europe",
  "European startups",
  "quantum computing Europe",
  "semiconductor Europe",
  "European cloud",
  "euro integration",
];

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MIN_SCORE = 6;
const STATE_FILE = "data/bluesky_scout_state.json";

// ---------------------------------------------------------------------------
// State persistence (simple JSON files)
// ---------------------------------------------------------------------------

function loadScoutState(): ScoutCycleState | null {
  try {
    const fs = require("fs");
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // File not found or parse error — start fresh
  }
  return null;
}

function saveScoutState(state: ScoutCycleState): void {
  try {
    const fs = require("fs");
    const dir = require("path").dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    elizaLogger.warn(`[BLUESKY-PLUGIN] searchBluesky: failed to save state — ${err}`);
  }
}

function loadMonitoredProfiles(config: PluginConfig): MonitoredProfile[] {
  try {
    const fs = require("fs");
    if (fs.existsSync(config.targetListJsonPath)) {
      return JSON.parse(fs.readFileSync(config.targetListJsonPath, "utf-8")).profiles ?? [];
    }
  } catch {
    // File not found — no monitored profiles
  }
  return [];
}

// ---------------------------------------------------------------------------
// Plugin Config Builder
// ---------------------------------------------------------------------------

export function createPluginConfig(runtime: IAgentRuntime): PluginConfig {
  const handle = runtime.getSetting("BLUESKY_HANDLE") || "";
  const appPassword = runtime.getSetting("BLUESKY_APP_PASSWORD") || "";
  const archonUrl = runtime.getSetting("ARCHON_URL") || "http://archon_euro_container:3000";
  const archonAgentId = runtime.getSetting("ARCHON_AGENT_ID") || "";
  const archonBlueskyDid = runtime.getSetting("BLUESKY_ARCHON_DID") || "";
  const targetListPath = runtime.getSetting("BLUESKY_TARGET_LIST_PATH") || "data/bluesky_target_list.json";

  const maxResults = parseInt(runtime.getSetting("BLUESKY_SEARCH_MAX_RESULTS") || String(DEFAULT_MAX_RESULTS));
  const minScore = parseInt(runtime.getSetting("BLUESKY_SEARCH_MIN_SCORE") || String(DEFAULT_MIN_SCORE));
  const disableTier2 = runtime.getSetting("BLUESKY_DISABLE_TIER2") === "true";
  const disableTier3 = runtime.getSetting("BLUESKY_DISABLE_TIER3") === "true";
  const keywordLimit = runtime.getSetting("BLUESKY_KEYWORD_LIMIT")
    ? parseInt(runtime.getSetting("BLUESKY_KEYWORD_LIMIT")!)
    : undefined;

  return {
    handle,
    appPassword,
    archonUrl,
    archonAgentId,
    archonBlueskyDid,
    targetListJsonPath: targetListPath,
    defaultKeywords: DEFAULT_KEYWORDS,
    maxResults,
    minScore,
    disableTier2,
    disableTier3,
    keywordLimit,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function calculateScore(post: BlueskyPost, matchedKeywords: string[]): number {
  let score = 5.0; // Base score

  // Engagement bonus
  const totalEngagement = post.likeCount + post.repostCount + post.replyCount;
  if (totalEngagement > 100) score += 2.0;
  else if (totalEngagement > 50) score += 1.5;
  else if (totalEngagement > 10) score += 0.5;

  // Keyword match bonus
  const keywordBonus = Math.min(matchedKeywords.length * 0.5, 2.0);
  score += keywordBonus;

  // Author authority bonus (accounts with significant following)
  if (post.author.followerCount && post.author.followerCount > 1000) score += 0.5;
  if (post.author.followerCount && post.author.followerCount > 10000) score += 1.0;

  // Clamp to 1.0–10.0
  return Math.round(Math.max(1.0, Math.min(10.0, score)) * 10) / 10;
}

function extractMatchedKeywords(post: BlueskyPost, keywords: string[]): string[] {
  const text = post.record.text.toLowerCase();
  return keywords.filter((kw) => text.includes(kw.toLowerCase()));
}

function generateSuggestedAngle(post: BlueskyPost, keywords: string[]): string {
  const matched = extractMatchedKeywords(post, keywords);
  if (matched.length > 0) {
    const topic = matched[0];
    return `Engage with data on ${topic} — add European tech/policy perspective`;
  }
  return "Engage with relevant content — share data-backed perspective";
}

// ---------------------------------------------------------------------------
// Tier 1 — Keyword Search
// ---------------------------------------------------------------------------

async function runTier1(
  keywords: string[],
  config: PluginConfig
): Promise<ScoredBlueskyPost[]> {
  const results: ScoredBlueskyPost[] = [];
  const searched = new Set<string>();

  for (const keyword of keywords) {
    if (searched.has(keyword.toLowerCase())) continue;
    searched.add(keyword.toLowerCase());

    elizaLogger.info(
      `[BLUESKY-PLUGIN] searchBluesky: Tier 1 — searching "${keyword}"`
    );

    const posts = await searchPosts(keyword, 10);
    if (!posts || posts.length === 0) continue;

    for (const post of posts) {
      const matchedKeywords = extractMatchedKeywords(post, keywords);
      if (matchedKeywords.length === 0) continue;

      const score = calculateScore(post, matchedKeywords);
      const suggestedAngle = generateSuggestedAngle(post, keywords);
      const postUrl = buildPostUrl(post.author.handle, post.uri);

      results.push({
        ...post,
        score,
        suggestedAngle,
        postUrl,
        matchedKeywords,
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Tier 2 — Feed/Profile Monitoring
// ---------------------------------------------------------------------------

async function runTier2(
  config: PluginConfig,
  keywords: string[]
): Promise<ScoredBlueskyPost[]> {
  const results: ScoredBlueskyPost[] = [];
  const seenUris = new Set<string>();
  const profiles = loadMonitoredProfiles(config);

  if (profiles.length === 0) {
    // No configured profiles — use timeline as general feed scan
    const posts = await getTimeline(15);
    if (!posts) return [];

    for (const post of posts) {
      if (seenUris.has(post.uri)) continue;
      seenUris.add(post.uri);

      const matchedKeywords = extractMatchedKeywords(post, keywords);
      if (matchedKeywords.length === 0) continue;

      const score = calculateScore(post, matchedKeywords);
      results.push({
        ...post,
        score,
        suggestedAngle: generateSuggestedAngle(post, keywords),
        postUrl: buildPostUrl(post.author.handle, post.uri),
        matchedKeywords,
      });
    }
  } else {
    // Scan monitored profiles
    for (const profile of profiles) {
      elizaLogger.info(
        `[BLUESKY-PLUGIN] searchBluesky: Tier 2 — checking @${profile.handle}`
      );

      const posts = await getAuthorFeed(profile.did, 10);
      if (!posts) continue;

      for (const post of posts) {
        if (seenUris.has(post.uri)) continue;
        seenUris.add(post.uri);

        const matchedKeywords = extractMatchedKeywords(post, keywords);
        if (matchedKeywords.length === 0) continue;

        const score = calculateScore(post, matchedKeywords) + profile.weight;
        results.push({
          ...post,
          score,
          suggestedAngle: `Monitored profile @${profile.handle}: ${generateSuggestedAngle(post, keywords)}`,
          postUrl: buildPostUrl(post.author.handle, post.uri),
          matchedKeywords,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Tier 3 — Notification Polling
// ---------------------------------------------------------------------------

async function runTier3(
  config: PluginConfig
): Promise<ScoredBlueskyPost[]> {
  const results: ScoredBlueskyPost[] = [];

  if (!config.archonBlueskyDid) {
    elizaLogger.warn(
      `[BLUESKY-PLUGIN] searchBluesky: Tier 3 — no archon DID configured, skipping`
    );
    return [];
  }

  elizaLogger.info(
    `[BLUESKY-PLUGIN] searchBluesky: Tier 3 — polling notifications`
  );

  const notifications = await listNotifications(20);
  if (!notifications || notifications.length === 0) return [];

  // Filter for notifications directed at the archon agent
  const relevantNotifs = notifications.filter((n) => {
    return n.reason === "reply" || n.reason === "quote" || n.reason === "mention";
  });

  for (const notif of relevantNotifs) {
    // Get the full post thread to understand context
    const thread = await (await import("../lib/blueskyClient.js")).getPostThread(notif.uri);
    if (!thread?.thread?.post) continue;

    const post = thread.thread.post;
    const postUrl = buildPostUrl(post.author.handle, post.uri);

    results.push({
      ...post,
      score: 7.5, // Direct engagement with Archon — high priority
      suggestedAngle: `Direct engagement: @${notif.author.handle} — reply with data-backed perspective`,
      postUrl,
      matchedKeywords: ["inbound-engagement"],
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Merge and Deduplicate
// ---------------------------------------------------------------------------

function mergeAndDedupe(tierResults: ScoredBlueskyPost[][]): ScoredBlueskyPost[] {
  const seen = new Set<string>();
  const merged: ScoredBlueskyPost[] = [];

  for (const tier of tierResults) {
    for (const post of tier) {
      if (seen.has(post.uri)) continue;
      seen.add(post.uri);
      merged.push(post);
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged;
}

// ---------------------------------------------------------------------------
// Deliver to Archon
// ---------------------------------------------------------------------------

async function deliverToArchon(
  queueText: string,
  config: PluginConfig
): Promise<void> {
  try {
    const res = await fetch(
      `${config.archonUrl}/${config.archonAgentId}/ingest`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: queueText,
          source: "bluesky_scout",
          priority: "high",
        }),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (res.ok) {
      elizaLogger.info(
        `[BLUESKY-PLUGIN] searchBluesky: delivered queue to Archon — ${res.status}`
      );
    } else {
      elizaLogger.warn(
        `[BLUESKY-PLUGIN] searchBluesky: delivery to Archon FAILED — ${res.status}`
      );
    }
  } catch (err) {
    elizaLogger.warn(
      `[BLUESKY-PLUGIN] searchBluesky: delivery to Archon ERROR — ${err}`
    );
  }
}

// ---------------------------------------------------------------------------
// Format Queue
// ---------------------------------------------------------------------------

function formatQueue(scored: ScoredBlueskyPost[]): string {
  if (scored.length === 0) return "No relevant Bluesky content found this cycle.";

  let output = `🌐 **Bluesky Scout Report** — ${scored.length} opportunities\n\n`;

  for (const post of scored) {
    const platform = "Bluesky";
    output += `**${post.author.displayName || post.author.handle}** (@${post.author.handle})\n`;
    output += `Score: ${post.score}/10 | ♥ ${post.likeCount} | ♺ ${post.repostCount} | 💬 ${post.replyCount}\n`;
    output += `🔗 ${post.postUrl}\n`;

    if (post.matchedKeywords.length > 0) {
      output += `Topics: ${post.matchedKeywords.slice(0, 5).join(", ")}\n`;
    }
    output += `Angle: ${post.suggestedAngle}\n\n`;
  }

  return output;
}

// ==========================================================================
// Action Definition
// ==========================================================================

export const searchBlueskyAction: Action = {
  name: "SEARCH_BLUESKY",
  similes: ["SEARCH_BLUESKY", "SCOUT_BLUESKY", "DISCOVER_BLUESKY"],
  description:
    "Three-tier discovery for Bluesky: keyword search, feed/profile monitoring, " +
    "and notification polling. Scores and prioritizes engagement opportunities " +
    "for Archon Europae.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const handle = runtime.getSetting("BLUESKY_HANDLE");
    const appPassword = runtime.getSetting("BLUESKY_APP_PASSWORD");
    if (!handle || !appPassword) {
      elizaLogger.warn(
        `[BLUESKY-PLUGIN] searchBluesky: missing credentials — BLUESKY_HANDLE and BLUESKY_APP_PASSWORD required`
      );
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: any,
    callback?: HandlerCallback
  ): Promise<void> => {
    const startTime = Date.now();
    elizaLogger.info(`[BLUESKY-PLUGIN] searchBluesky: START — cycle triggered`);

    try {
      const config = createPluginConfig(runtime);

      // Authenticate with Bluesky
      await ensureSession(config.handle, config.appPassword);

      // Determine keywords for Tier 1
      // Load from cache or use defaults
      let keywords = config.defaultKeywords;
      const cachedState = loadScoutState();

      // If keyword limit is configured, trim
      if (config.keywordLimit && keywords.length > config.keywordLimit) {
        keywords = keywords.slice(0, config.keywordLimit);
      }

      elizaLogger.info(
        `[BLUESKY-PLUGIN] searchBluesky: keywords=${keywords.length}, ` +
        `tier2=${!config.disableTier2}, tier3=${!config.disableTier3}`
      );

      // Run tiers
      const tierResults: ScoredBlueskyPost[][] = [];

      // Tier 1: Keyword search
      const tier1 = await runTier1(keywords, config);
      tierResults.push(tier1);
      elizaLogger.info(
        `[BLUESKY-PLUGIN] searchBluesky: Tier 1 — ${tier1.length} results`
      );

      // Tier 2: Feed/profile monitoring
      if (!config.disableTier2) {
        const tier2 = await runTier2(config, keywords);
        tierResults.push(tier2);
        elizaLogger.info(
          `[BLUESKY-PLUGIN] searchBluesky: Tier 2 — ${tier2.length} results`
        );
      }

      // Tier 3: Notification polling
      if (!config.disableTier3) {
        const tier3 = await runTier3(config);
        tierResults.push(tier3);
        elizaLogger.info(
          `[BLUESKY-PLUGIN] searchBluesky: Tier 3 — ${tier3.length} results`
        );
      }

      // Merge, deduplicate, and rank
      const merged = mergeAndDedupe(tierResults);

      // Score filter
      const qualified = merged.filter((p) => p.score >= config.minScore);
      const topResults = qualified.slice(0, config.maxResults);

      elizaLogger.info(
        `[BLUESKY-PLUGIN] searchBluesky: merged=${merged.length}, ` +
        `qualified=${qualified.length}, delivering=${topResults.length}`
      );

      // Format and deliver to Archon
      const queueText = formatQueue(topResults);
      await deliverToArchon(queueText, config);

      // Save cycle state
      saveScoutState({
        cycleNumber: (cachedState?.cycleNumber ?? 0) + 1,
        lastCycleAt: new Date().toISOString(),
        lastKeywords: keywords,
      });

      const duration = Date.now() - startTime;
      elizaLogger.info(
        `[BLUESKY-PLUGIN] searchBluesky: COMPLETE — ${topResults.length} delivered, ${duration}ms`
      );

      if (callback) {
        callback({
          text: `Bluesky scout cycle complete: ${topResults.length} opportunities found and delivered to Archon.`,
          content: {
            source: "bluesky_scout",
            cycleDuration: duration,
            resultsCount: topResults.length,
            totalFound: merged.length,
            qualifiedCount: qualified.length,
          },
        });
      }
    } catch (err) {
      elizaLogger.error(
        `[BLUESKY-PLUGIN] searchBluesky: ERROR — ${err}`
      );
      if (callback) {
        callback({
          text: `Bluesky scout cycle failed: ${err}`,
          content: { error: String(err), source: "bluesky_scout" },
        });
      }
    }
  },
};
