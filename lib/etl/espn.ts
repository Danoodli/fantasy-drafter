// ESPN kona_player_info payload helpers, shared by the board ETL and the
// season backtest. The endpoint is undocumented; the ids and shapes here were
// verified against live payloads for the 2024-2026 seasons.

import { statLineFromEspn } from "../scoring";
import type { Position, StatLine } from "../types";

export const ESPN_POS: Record<number, Position> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
export const ESPN_TEAM: Record<number, string> = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
  17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

export interface EspnStatEntry {
  /** 1 = projection, 0 = actual */
  statSourceId: number;
  /** 0 = season total, 1 = single week (see scoringPeriodId) */
  statSplitTypeId: number;
  seasonId: number;
  scoringPeriodId?: number;
  stats: Record<string, number>;
  appliedTotal?: number;
}

export interface EspnPlayerEntry {
  player?: {
    id: number;
    fullName: string;
    defaultPositionId: number;
    proTeamId: number;
    stats?: EspnStatEntry[];
    ownership?: { averageDraftPosition?: number };
  };
}

/** Regular-season weeks captured in a season snapshot. */
export const SEASON_WEEKS = 18;

/**
 * One player's draft-day projection and what actually happened, from a single
 * historical kona payload. Stat lines are raw so the backtest can score them
 * under any league's settings; applied totals (ESPN default scoring) are kept
 * for K/DST, whose points don't decompose into our StatLine.
 */
export interface SeasonPlayer {
  espnId: string;
  name: string;
  pos: Position;
  team: string;
  adpEspn: number | null;
  proj: StatLine | null;
  projApplied: number;
  actual: StatLine | null;
  actualApplied: number;
  /** index 0 = week 1; null when the player has no line that week (bye, injured, unrostered). */
  weekly: (StatLine | null)[];
  weeklyApplied: (number | null)[];
}

/** Parse a historical kona payload into per-player projection + outcome rows. */
export function parseSeasonPlayers(raw: { players: unknown[] }, season: number): SeasonPlayer[] {
  const out: SeasonPlayer[] = [];
  for (const entry of raw.players as EspnPlayerEntry[]) {
    const p = entry?.player;
    if (!p) continue;
    const pos = ESPN_POS[p.defaultPositionId];
    if (!pos) continue;
    const stats = (p.stats ?? []).filter((s) => s.seasonId === season);
    const proj = stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 0);
    const actual = stats.find((s) => s.statSourceId === 0 && s.statSplitTypeId === 0);
    if (!proj && !actual) continue;

    const weekly: (StatLine | null)[] = Array(SEASON_WEEKS).fill(null);
    const weeklyApplied: (number | null)[] = Array(SEASON_WEEKS).fill(null);
    for (const s of stats) {
      if (s.statSourceId !== 0 || s.statSplitTypeId !== 1 || !s.scoringPeriodId) continue;
      const w = s.scoringPeriodId - 1;
      if (w < 0 || w >= SEASON_WEEKS) continue;
      weekly[w] = statLineFromEspn(s.stats ?? {});
      weeklyApplied[w] = s.appliedTotal ?? 0;
    }

    out.push({
      espnId: String(p.id),
      name: p.fullName,
      pos,
      team: ESPN_TEAM[p.proTeamId] ?? "",
      adpEspn:
        p.ownership?.averageDraftPosition && p.ownership.averageDraftPosition > 0
          ? Math.round(p.ownership.averageDraftPosition * 10) / 10
          : null,
      proj: proj ? statLineFromEspn(proj.stats ?? {}) : null,
      projApplied: proj?.appliedTotal ?? 0,
      actual: actual ? statLineFromEspn(actual.stats ?? {}) : null,
      actualApplied: actual?.appliedTotal ?? 0,
      weekly,
      weeklyApplied,
    });
  }
  return out;
}
