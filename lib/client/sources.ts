"use client";

// Data-source preferences: which projection and ADP opinions the board runs
// on, globally, persisted on-device. Every source is free and anonymous;
// switching is instant because the board carries all raw inputs.

export interface SourcePrefs {
  /** ESPN and Sleeper both publish full projected stat lines. Blend averages them. */
  projections: "espn" | "sleeper" | "blend";
  /**
   * FFC is the default: it's the only source with per-player stdev, which
   * powers the survival model. Choosing Sleeper/ESPN swaps the ADP mean but
   * keeps FFC's spread as the uncertainty estimate.
   */
  adp: "ffc" | "sleeper" | "espn" | "blend";
  /** Show 🔥 on players the Sleeper community is adding fastest (24h). */
  trending: boolean;
}

export const DEFAULT_SOURCES: SourcePrefs = {
  projections: "blend",
  adp: "ffc",
  trending: true,
};

const KEY = "draft-cockpit-sources-v1";

export function loadSources(): SourcePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SOURCES, ...JSON.parse(raw) } : DEFAULT_SOURCES;
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
