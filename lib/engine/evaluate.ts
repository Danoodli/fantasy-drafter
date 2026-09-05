// Projection + decision quality metrics for the season backtest.
//
// Pure: arrays in, numbers out. No clock, no I/O. Everything here answers one
// of two questions about a completed season:
//   1. How good were the projections we drafted from?  (projectionReport)
//   2. How many real points did a drafted roster produce? (realizedValue)

import type { LeagueConfig, Position } from "../types";
import { optimalLineupTotal } from "./season";

export interface ProjRow {
  id: string;
  name: string;
  pos: Position;
  /** Draft-day projected points under the league's scoring. */
  proj: number;
  /** Realized season points under the same scoring. */
  actual: number;
  /** Draft-day ADP, for context in the misses table. */
  adp: number;
}

/** Average rank with ties broken by input order — fine for continuous scores. */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const out = new Array<number>(values.length);
  order.forEach(([, i], k) => (out[i] = k + 1));
  return out;
}

/** Spearman rank correlation of two equal-length series. */
export function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = ra.reduce((s, v) => s + v, 0) / n;
  const mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = ra[i] - ma;
    const y = rb[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Share of player pairs where the higher-projected player really did outscore
 * the other. This is the metric a draft tool should care about: "when we say
 * A over B, how often are we right?" Tied pairs on either side are skipped.
 */
export function pairwiseAccuracy(rows: { proj: number; actual: number }[]): number {
  let hits = 0;
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (a.proj === b.proj || a.actual === b.actual) continue;
      total++;
      if (a.proj > b.proj === a.actual > b.actual) hits++;
    }
  }
  return total ? hits / total : 0;
}

export interface ProjectionStats {
  n: number;
  rho: number;
  pairwise: number;
  /** Mean absolute error in points. */
  mae: number;
  /** Mean (actual − projected). Negative = we projected too high. */
  bias: number;
}

export interface ProjectionReport extends ProjectionStats {
  byPos: Partial<Record<Position, ProjectionStats>>;
}

function stats(rows: { proj: number; actual: number }[]): ProjectionStats {
  const n = rows.length;
  if (n === 0) return { n: 0, rho: 0, pairwise: 0, mae: 0, bias: 0 };
  return {
    n,
    rho: spearman(rows.map((r) => r.proj), rows.map((r) => r.actual)),
    pairwise: pairwiseAccuracy(rows),
    mae: rows.reduce((s, r) => s + Math.abs(r.actual - r.proj), 0) / n,
    bias: rows.reduce((s, r) => s + (r.actual - r.proj), 0) / n,
  };
}

/** Overall and per-position projection quality. */
export function projectionReport(rows: ProjRow[]): ProjectionReport {
  const byPos: ProjectionReport["byPos"] = {};
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const group = rows.filter((r) => r.pos === pos);
    if (group.length) byPos[pos] = stats(group);
  }
  return { ...stats(rows), byPos };
}

/** The k largest misses in each direction, by realized minus projected. */
export function biggestMisses(rows: ProjRow[], k: number): { busts: ProjRow[]; booms: ProjRow[] } {
  const sorted = [...rows].sort((a, b) => a.actual - a.proj - (b.actual - b.proj));
  return { busts: sorted.slice(0, k), booms: sorted.slice(-k).reverse() };
}

export interface RealizedPlayer {
  pos: Position;
  /** Realized points by week (index 0 = week 1); null when the player did not play. */
  weekly: (number | null)[];
}

export interface RealizedValue {
  /**
   * Sum over weeks of the optimal starting lineup that week. This is exactly
   * how best ball scores, and for redraft it is the standard "perfect manager"
   * yardstick — it credits depth only when it actually started.
   */
  weeklyLineup: number;
  /** Plain sum of every rostered player's season points — depth included. */
  seasonTotal: number;
}

/** Score a finished roster against what really happened. */
export function realizedValue(roster: RealizedPlayer[], config: LeagueConfig): RealizedValue {
  const weeks = roster.reduce((m, p) => Math.max(m, p.weekly.length), 0);
  let weeklyLineup = 0;
  for (let w = 0; w < weeks; w++) {
    weeklyLineup += optimalLineupTotal(
      roster.map((p) => ({ pos: p.pos, score: p.weekly[w] ?? 0 })),
      config
    );
  }
  const seasonTotal = roster.reduce(
    (s, p) => s + p.weekly.reduce<number>((a, v) => a + (v ?? 0), 0),
    0
  );
  return { weeklyLineup, seasonTotal };
}
