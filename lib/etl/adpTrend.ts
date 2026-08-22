// ADP movement: the refresh workflow runs 3×/day, so successive builds form
// a time series. We keep a small rolling snapshot file per format (committed
// like the other fixtures) and stamp each player with how far he's moved —
// market intel nobody else in the room has.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** date (YYYY-MM-DD) → playerId → adp */
export type AdpHistory = Record<string, Record<string, number>>;

const KEEP_DAYS = 10;

/**
 * Pure: record today's snapshot into the history (last write per day wins)
 * and trim old days. Exported for tests.
 */
export function recordSnapshot(
  history: AdpHistory,
  today: string,
  adps: Record<string, number>
): AdpHistory {
  const next: AdpHistory = { ...history, [today]: adps };
  const days = Object.keys(next).sort();
  for (const day of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) {
    delete next[day];
  }
  return next;
}

/**
 * Pure: picks the comparison snapshot (oldest within the window, preferring
 * ~3+ days back) and returns playerId → picks moved. POSITIVE = RISING
 * (being drafted earlier than before).
 */
export function computeTrends(
  history: AdpHistory,
  today: string,
  adps: Record<string, number>,
  minDelta = 3
): Record<string, number> {
  const days = Object.keys(history)
    .filter((d) => d < today)
    .sort(); // ascending
  if (days.length === 0) return {};
  // Prefer the oldest snapshot at least 3 days back; else the oldest we have.
  const target = new Date(new Date(today + "T00:00:00Z").getTime() - 3 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const base = days.find((d) => d <= target) ? days.filter((d) => d <= target).pop()! : days[0];
  const baseline = history[base];
  const out: Record<string, number> = {};
  for (const [id, adp] of Object.entries(adps)) {
    const prev = baseline[id];
    if (prev == null) continue;
    const delta = Math.round((prev - adp) * 10) / 10; // + = rising
    if (Math.abs(delta) >= minDelta) out[id] = delta;
  }
  return out;
}

/** Node-side: load, update, persist, and return trends for a format. */
export function updateAdpTrends(
  format: string,
  adps: Record<string, number>
): Record<string, number> {
  const dir = join(process.cwd(), "data", "raw");
  const path = join(dir, `adp-history-${format}.json`);
  let history: AdpHistory = {};
  try {
    if (existsSync(path)) history = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    history = {};
  }
  const today = new Date().toISOString().slice(0, 10);
  const trends = computeTrends(history, today, adps);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(recordSnapshot(history, today, adps)));
  return trends;
}
