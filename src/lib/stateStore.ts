// =============================================================================
// stateStore.ts — Shared state persistence utility for all actions
//
// Provides DRY load/save functions so each action file doesn't duplicate
// the fs read/write pattern with CJS require() calls.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { elizaLogger } from "@elizaos/core";

/**
 * Load a persisted state object from a JSON file.
 * Returns `null` if the file doesn't exist or fails to parse.
 * Logs a warning on corruption rather than silently swallowing.
 */
export function loadState<T>(filePath: string): T | null {
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as T;
    }
  } catch (err) {
    elizaLogger.warn(
      `[BLUESKY-PLUGIN] stateStore: failed to load state from ${filePath} — ${err}`
    );
  }
  return null;
}

/**
 * Persist a state object to a JSON file.
 * Creates parent directories if they don't exist.
 */
export function saveState<T>(filePath: string, state: T): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (err) {
    elizaLogger.warn(
      `[BLUESKY-PLUGIN] stateStore: failed to save state to ${filePath} — ${err}`
    );
  }
}

/**
 * Get today's date as YYYY-MM-DD string.
 */
export function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Reset a daily counter if the date has rolled over.
 * Mutates and returns the provided state object for convenience.
 */
export function resetDailyCounter<T extends { todayDate: string; todayCount: number }>(
  state: T
): T {
  const today = getToday();
  if (state.todayDate !== today) {
    state.todayCount = 0;
    state.todayDate = today;
  }
  return state;
}
