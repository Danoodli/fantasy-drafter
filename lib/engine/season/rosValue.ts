// Rest-of-season value of a roster: the expected points its optimal lineup
// scores over the remaining weeks. Pure. Shared by waivers and trades so the
// two agree on what a player is worth TO THIS ROSTER.
//
// This week comes from the weekly board (availability and matchup already
// folded in); later weeks from the season outcome model, the same fitted rate
// the draft engine uses. A bye is zero; a season-long designation is zero
// everywhere — the shared SEASON_LONG set, never a local copy.
import type { BoardPlayer, LeagueConfig, Position } from "../../types";
import type { WeekOutlook } from "../weekly/outlook";
import type { OutcomeParams } from "../outcomeModel";
import { expectedWeekly } from "../outcome";
import { optimalLineupTotal } from "../season";
import { SEASON_LONG } from "../injuryFeed";
import outcomeJson from "../../../config/outcome-model.json";

export const DEFAULT_OUTCOME = outcomeJson as OutcomeParams;

export interface RosContext {
  /** Remaining regular-season weeks, ascending. */
  weeks: number[];
  config: LeagueConfig;
  params?: OutcomeParams;
  /** This week's outlooks, used for `currentWeek` when present and projected. */
  outlooks?: Map<string, WeekOutlook>;
  currentWeek?: number;
}

export function weeklyMeans(p: BoardPlayer, ctx: RosContext): Float64Array {
  const out = new Float64Array(ctx.weeks.length);
  if (p.injury && SEASON_LONG.has(p.injury)) return out;
  const params = ctx.params ?? DEFAULT_OUTCOME;
  const rate = expectedWeekly(p, params);
  ctx.weeks.forEach((w, i) => {
    if (p.bye === w) return;
    const o = w === ctx.currentWeek ? ctx.outlooks?.get(p.id) : undefined;
    out[i] = o && o.projected ? o.mean : rate;
  });
  return out;
}

export function meansFor(players: BoardPlayer[], ctx: RosContext): Map<string, Float64Array> {
  return new Map(players.map((p) => [p.id, weeklyMeans(p, ctx)] as const));
}

/** Sum over weeks of the optimal lineup's expected points. `means` must cover every roster player. */
export function rosLineupValue(roster: BoardPlayer[], ctx: RosContext, means: Map<string, Float64Array>): number {
  let total = 0;
  for (let i = 0; i < ctx.weeks.length; i++) {
    total += optimalLineupTotal(
      roster.map((p) => ({ pos: p.pos, score: means.get(p.id)?.[i] ?? 0 })),
      ctx.config
    );
  }
  return total;
}

const DEDICATED: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

/**
 * Dedicated slot-weeks the roster cannot fill: for each week and position,
 * max(0, slots - bodies), where a body is a player at that position who is
 * neither on his bye nor on a season-long designation. FLEX is ignored, as
 * in lib/engine/coverage.ts: it is filled by three positions and would let a
 * sixth RB claim credit for a WR hole.
 */
export function emptySlotWeeks(roster: BoardPlayer[], ctx: RosContext): number {
  let empty = 0;
  for (const w of ctx.weeks) {
    for (const pos of DEDICATED) {
      const slots = ctx.config.rosterSlots[pos] ?? 0;
      if (slots <= 0) continue;
      const bodies = roster.filter((p) => p.pos === pos && p.bye !== w && !(p.injury && SEASON_LONG.has(p.injury))).length;
      empty += Math.max(0, slots - bodies);
    }
  }
  return empty;
}
