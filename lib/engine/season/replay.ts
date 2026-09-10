// Adapters from the historical fit set (lib/etl/weekly/history.ts HistRow) to
// the in-season engine's inputs, so scripts/backtest-lineup.ts can replay
// start/sit and waiver decisions against realized points. Pure.
import type { BoardPlayer, Position, ScoringSettings } from "../../types";
import type { HistRow } from "../../etl/weekly/history";
import type { WeekOutlook } from "../weekly/outlook";
import type { WeeklyModelParams } from "../weekly/model";
import { scoreStatLine } from "../../scoring";
import { lognormalQuantile, projectedVolume, weeklySigma } from "../weekly/spread";

/**
 * pPlay is 1 on purpose: HistRow.stNow is the status at FETCH time, not the
 * week's (see its docstring), so it carries no information about that week.
 * A player who did not play realizes 0 through `realizedPoints`, which is the
 * honest way to let DNPs cost both strategies equally.
 */
export function histRowToOutlook(row: HistRow, params: WeeklyModelParams, scoring: ScoringSettings): WeekOutlook {
  const mean = Math.max(0, scoreStatLine(row.proj, scoring, row.pos === "TE"));
  const sigma = weeklySigma(row.pos, projectedVolume(row.pos, row.proj), params);
  const q = (p: number) => (mean > 0 ? lognormalQuantile(mean, sigma, p) : 0);
  return {
    playerId: row.id,
    week: row.wk,
    opp: row.opp,
    meanIfPlays: mean,
    mean,
    sigma,
    p10: q(0.1),
    p50: q(0.5),
    p90: q(0.9),
    pPlay: 1,
    projected: true,
    stats: row.proj,
    drivers: { baseMarket: mean, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: null },
  };
}

export function realizedPoints(row: HistRow, scoring: ScoringSettings): number {
  return row.act ? scoreStatLine(row.act, scoring, row.pos === "TE") : 0;
}

/** Seeded draw without replacement, per position. Takes what is there when short. */
export function sampleRoster(
  rows: HistRow[],
  counts: Partial<Record<Position, number>>,
  rng: () => number,
  exclude: Set<string> = new Set()
): HistRow[] {
  const out: HistRow[] = [];
  for (const [pos, n] of Object.entries(counts) as [Position, number][]) {
    const pool = rows.filter((r) => r.pos === pos && !exclude.has(r.id) && !out.some((o) => o.id === r.id));
    for (let k = 0; k < n && pool.length > 0; k++) {
      const i = Math.floor(rng() * pool.length);
      out.push(pool[i]);
      pool.splice(i, 1);
    }
  }
  return out;
}

const GAMES = 16;

/** Season-rate proxy so rosValue (which prices BoardPlayers) can value a historical player. */
export function histRowToBoardPlayer(row: HistRow, scoring: ScoringSettings): BoardPlayer {
  const weekly = Math.max(0, scoreStatLine(row.proj, scoring, row.pos === "TE"));
  return {
    id: row.id, name: row.id, pos: row.pos, team: row.team, bye: null, projPoints: weekly * GAMES, projImputed: false,
    adp: 999, adpStdev: 0, adpHigh: 999, adpLow: 999, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
    injury: null, depthOrder: null, sosSeason: null, sosPlayoff: null, ids: {},
  };
}
