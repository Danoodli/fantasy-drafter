// Client-side board re-scoring: when the real Sleeper league scoring differs
// from the preset the board was built with, recompute projPoints / VORP /
// VOLS / tiers in the browser from the raw stat lines. Pure; no I/O.

import type { Board, BoardPlayer, LeagueConfig, Position, ScoringSettings } from "../types";
import { scoreStatLine } from "../scoring";
import { baselines } from "../engine/baselines";
import { assignTiers } from "../engine/tiers";
import { POSITIONS } from "../types";
import type { SourcePrefs } from "./sources";

/** Projected points under the chosen projection source(s), or null if none apply. */
function projectFor(p: BoardPlayer, scoring: ScoringSettings, prefs?: SourcePrefs): number | null {
  if (p.pos === "K" || p.pos === "DST") return null; // applied totals stand
  const isTE = p.pos === "TE";
  // First downs exist only in Sleeper's stat lines — score them separately
  // so blending with ESPN (which has none) doesn't halve the PPFD bonus.
  const baseScoring: ScoringSettings = { ...scoring, rush_fd: 0, rec_fd: 0, pass_fd: 0 };
  const fdOnly: ScoringSettings = {
    ...scoring,
    pass_yd: 0, pass_td: 0, pass_int: 0, pass_2pt: 0,
    rush_yd: 0, rush_td: 0, rush_2pt: 0,
    rec: 0, rec_yd: 0, rec_td: 0, rec_2pt: 0, fum_lost: 0, bonus_rec_te: 0,
  };
  const fdPts = p.statsSleeper ? scoreStatLine(p.statsSleeper, fdOnly, isTE) : 0;
  const espn = p.stats ? scoreStatLine(p.stats, baseScoring, isTE) : null;
  const sleeper = p.statsSleeper ? scoreStatLine(p.statsSleeper, baseScoring, isTE) : null;
  const fp = p.statsFp ? scoreStatLine(p.statsFp, baseScoring, isTE) : null;
  const want = prefs?.projections ?? "espn";
  let base: number | null;
  if (want === "espn") base = espn ?? sleeper ?? fp;
  else if (want === "sleeper") base = sleeper ?? espn ?? fp;
  else if (want === "fp") base = fp ?? espn ?? sleeper;
  else {
    const avail = [espn, sleeper, fp].filter((v): v is number => v != null);
    base = avail.length ? avail.reduce((a, b) => a + b, 0) / avail.length : null;
  }
  return base != null ? base + fdPts : null;
}

/** ADP under the chosen source, always falling back to FFC (never null). */
function adpFor(p: BoardPlayer, prefs?: SourcePrefs): number {
  const src = p.adpSources;
  if (!src) return p.adp;
  const want = prefs?.adp ?? "ffc";
  // Deep-pool players have no FFC opinion, so every branch falls back to p.adp.
  if (want === "espn") return src.espn ?? src.ffc ?? p.adp;
  if (want === "sleeper") return src.sleeper ?? src.ffc ?? p.adp;
  if (want === "blend") {
    const vals = [src.ffc, src.espn, src.sleeper].filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : p.adp;
  }
  return src.ffc ?? p.adp;
}

export function rescoreBoard(
  board: Board,
  scoring: ScoringSettings,
  config: LeagueConfig,
  prefs?: SourcePrefs
): Board {
  const players = board.players.map((p) => {
    const pts = projectFor(p, scoring, prefs);
    const adp = Math.round(adpFor(p, prefs) * 10) / 10;
    return {
      ...p,
      adp,
      projPoints: pts != null ? Math.round(pts * 10) / 10 : p.projPoints,
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

  players.sort((a, b) => a.adp - b.adp); // a new ADP source reorders the board

  return { meta: { ...board.meta, scoring }, players };
}

/** True when two scoring settings differ enough to matter (≥0.01 on any key). */
export function scoringDiffers(a: ScoringSettings, b: ScoringSettings): boolean {
  const keys = Object.keys({ ...a, ...b }) as (keyof ScoringSettings)[];
  return keys.some((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) >= 0.01);
}
