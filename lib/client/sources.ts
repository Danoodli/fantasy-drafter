"use client";

import { DEFAULT_WIRE_HANDLES, DEFAULT_WIRE_LISTS } from "./bskyNews";

// Data-source preferences: which projection and ADP opinions the board runs
// on, globally, persisted on-device. Every source is free and anonymous;
// switching is instant because the board carries all raw inputs.

export interface SourcePrefs {
  /**
   * ESPN, Sleeper, and (with an API key configured at build time)
   * FantasyPros consensus all publish full projected stat lines.
   * Blend averages whichever are present.
   */
  projections: "espn" | "sleeper" | "fp" | "blend";
  /**
   * FFC is the default: it's the only source with per-player stdev, which
   * powers the survival model. Choosing Sleeper/ESPN swaps the ADP mean but
   * keeps FFC's spread as the uncertainty estimate.
   */
  adp: "ffc" | "sleeper" | "espn" | "blend";
  /** Show 🔥 on players the Sleeper community is adding fastest (24h). */
  trending: boolean;
  /** Poll the Bluesky insider wire for breaking reporter posts. */
  wire: boolean;
  /** Bluesky handles to follow — editable; defaults to top NFL insiders. */
  wireHandles: string[];
  /** Curated Bluesky lists (AT-URIs or bsky.app list URLs) whose members join the wire. Empty = none. */
  wireLists: string[];
  /** Handles to ignore everywhere on the wire (e.g. a noisy list member). */
  wireBlock: string[];
}

export const DEFAULT_SOURCES: SourcePrefs = {
  projections: "blend",
  adp: "ffc",
  trending: true,
  wire: true,
  wireHandles: [], // empty = use DEFAULT_WIRE_HANDLES
  wireLists: DEFAULT_WIRE_LISTS, // two curated NFL reporter lists; clear to follow handles only
  wireBlock: [],
};

const KEY = "draft-cockpit-sources-v1";

/** The wire defaults before 2026-09-07. The handles box used to save what it displayed, so a stored copy of these is a snapshot, not a choice. */
export const LEGACY_WIRE_DEFAULTS = [
  "rapsheet.bsky.social",
  "tompelissero.bsky.social",
  "profootballtalk.bsky.social",
  "matthewberry.bsky.social",
  "rotoworld-fb.bsky.social",
  "nflnewsreposterbot.bsky.social",
];

/**
 * Merge saved prefs over the defaults and repair stale handle lists: a list
 * made only of (old or new) defaults becomes "use defaults"; a list from
 * before the expansion that added custom handles keeps the customs on top of
 * the current defaults.
 */
export function migrateSources(saved: Partial<SourcePrefs>): SourcePrefs {
  const prefs: SourcePrefs = { ...DEFAULT_SOURCES, ...saved };
  const handles = Array.isArray(prefs.wireHandles) ? prefs.wireHandles : [];
  if (handles.length) {
    const defaults = new Set([...LEGACY_WIRE_DEFAULTS, ...DEFAULT_WIRE_HANDLES]);
    const custom = handles.filter((h) => !defaults.has(h));
    const newOnly = DEFAULT_WIRE_HANDLES.filter((h) => !LEGACY_WIRE_DEFAULTS.includes(h));
    const predatesExpansion = !handles.some((h) => newOnly.includes(h));
    if (custom.length === 0) prefs.wireHandles = [];
    else if (predatesExpansion) prefs.wireHandles = [...DEFAULT_WIRE_HANDLES, ...custom];
  }
  return prefs;
}

export function loadSources(): SourcePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? migrateSources(JSON.parse(raw)) : DEFAULT_SOURCES;
  } catch {
    return DEFAULT_SOURCES;
  }
}

export function saveSources(prefs: SourcePrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

/** Live "most added" player ids from Sleeper (24h window). Free, documented. */
export async function fetchTrendingIds(limit = 40): Promise<Set<string>> {
  const res = await fetch(
    `https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=${limit}`
  );
  if (!res.ok) throw new Error(`trending: HTTP ${res.status}`);
  const rows = (await res.json()) as { player_id: string; count: number }[];
  return new Set(rows.map((r) => r.player_id));
}
