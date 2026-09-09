// Defense-vs-position: mean PPR points a defense has allowed to each position,
// exponentially weighted toward recent weeks. Node-only (reads nflverse CSV
// rows) but the aggregation itself is pure and unit-tested.
//
// This is lib/etl/schedule.ts's season-level idea made weekly-rolling. Scored
// in PPR deliberately: DvP is a property of the defense, not of your league's
// scoring, and the multiplier it feeds is a ratio, so the units cancel.
import type { Position } from "../../types";
import { canonicalTeam, statLineFromNflverse, type Row } from "../nflverse";
import { SCORING_PRESETS, scoreStatLine } from "../../scoring";

export type DvpTable = Record<string, Partial<Record<Position, number>>>;

export interface DvpResult {
  table: DvpTable;
  leagueAvg: Partial<Record<Position, number>>;
  /** Distinct weeks observed per defense — drives the shrinkage in matchMult. */
  gamesByTeam: Record<string, number>;
}

const DVP_POS: Position[] = ["QB", "RB", "WR", "TE"];

/**
 * @param throughWeek predict week N using weeks < N only. Passing the week
 *   being predicted is what keeps the backtest honest — a table built through
 *   week N inclusive leaks the answer.
 */
export function buildDvp(
  rows: Row[],
  opts: { season: number; throughWeek: number; lambda: number }
): DvpResult {
  const { season, throughWeek, lambda } = opts;
  // team → pos → { weightedPts, weight }
  const acc: Record<string, Partial<Record<Position, { pts: number; w: number }>>> = {};
  const weeks: Record<string, Set<number>> = {};

  for (const r of rows) {
    if (r.season !== String(season) || r.season_type !== "REG") continue;
    const week = Number(r.week);
    if (!Number.isFinite(week) || week >= throughWeek) continue;
    const pos = r.position as Position;
    if (!DVP_POS.includes(pos)) continue;
    const def = canonicalTeam(r.opponent_team);
    if (!def) continue;
    const pts = scoreStatLine(statLineFromNflverse(r), SCORING_PRESETS.ppr, pos === "TE");
    // Recency weight: lambda^(weeks ago). lambda = 1 is a flat mean.
    const w = Math.pow(lambda, throughWeek - 1 - week);
    const byPos = (acc[def] ??= {});
    const cell = (byPos[pos] ??= { pts: 0, w: 0 });
    cell.pts += pts * w;
    cell.w += w;
    (weeks[def] ??= new Set()).add(week);
  }

  const table: DvpTable = {};
  const gamesByTeam: Record<string, number> = {};
  for (const [team, byPos] of Object.entries(acc)) {
    const weekCount = weeks[team]?.size ?? 0;
    gamesByTeam[team] = weekCount;
    if (weekCount === 0) continue;
    // Total weighted points allowed, spread over the weeks observed: this is
    // per-GAME points allowed to the position group, not per player.
    const totalW = Array.from(weeks[team]).reduce(
      (s, wk) => s + Math.pow(lambda, throughWeek - 1 - wk),
      0
    );
    const out: Partial<Record<Position, number>> = {};
    for (const pos of DVP_POS) {
      const cell = byPos[pos];
      if (!cell) continue;
      out[pos] = cell.pts / totalW;
    }
    table[team] = out;
  }

  const leagueAvg: Partial<Record<Position, number>> = {};
  for (const pos of DVP_POS) {
    const vals = Object.values(table)
      .map((t) => t[pos])
      .filter((v): v is number => typeof v === "number");
    if (vals.length) leagueAvg[pos] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  return { table, leagueAvg, gamesByTeam };
}
