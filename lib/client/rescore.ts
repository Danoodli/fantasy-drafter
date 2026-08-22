// Client-side board re-scoring: when the real Sleeper league scoring differs
// from the preset the board was built with, recompute projPoints / VORP /
// VOLS / tiers in the browser from the raw stat lines. Pure; no I/O.

import type { Board, LeagueConfig, Position, ScoringSettings } from "../types";
import { scoreStatLine } from "../scoring";
import { baselines } from "../engine/baselines";
import { assignTiers } from "../engine/tiers";
import { POSITIONS } from "../types";

export function rescoreBoard(
  board: Board,
  scoring: ScoringSettings,
  config: LeagueConfig
): Board {
  const players = board.players.map((p) => {
    if (!p.stats || p.pos === "K" || p.pos === "DST") return { ...p };
    return {
      ...p,
      projPoints: Math.round(scoreStatLine(p.stats, scoring, p.pos === "TE") * 10) / 10,
    };
  });

  const byPos = new Map<Position, number[]>();
  for (const pos of POSITIONS) {
    byPos.set(
      pos,
      players.filter((p) => p.pos === pos).map((p) => p.projPoints).sort((a, b) => b - a)
    );
  }
  const base = baselines(byPos, config);
  for (const p of players) {
    const b = base.get(p.pos)!;
    p.vorp = Math.round((p.projPoints - b.vorp) * 10) / 10;
    p.vols = Math.round((p.projPoints - b.vols) * 10) / 10;
  }
  for (const pos of POSITIONS) {
    const group = players.filter((p) => p.pos === pos).sort((a, b) => b.projPoints - a.projPoints);
    const tiers = assignTiers(group.map((p) => p.projPoints));
    group.forEach((p, i) => (p.tier = tiers[i]));
  }

  return { meta: { ...board.meta, scoring }, players };
}

/** True when two scoring settings differ enough to matter (≥0.01 on any key). */
export function scoringDiffers(a: ScoringSettings, b: ScoringSettings): boolean {
  const keys = Object.keys({ ...a, ...b }) as (keyof ScoringSettings)[];
  return keys.some((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) >= 0.01);
}
