// The objective: expected season lineup points of a roster.
//
// LineupPoints(R) = Σ_weeks optimal starting lineup from R's sampled weekly
// points, with any starting slot R cannot fill that week streamed from the
// waiver wire (redraft) or left empty (best ball). Every draft decision is
// judged by how it changes this number for the COMPLETED roster.

import type { BoardPlayer, LeagueConfig, Position } from "../types";
import { optimalLineupTotal } from "./season";
import { makeRng } from "./montecarlo";
import { FLEX_SHARE } from "./baselines";
import { coverageSlotWeeks } from "./coverage";
import { sampleSeason, expectedWeekly, healthyRate, availability, makeTeamShocks, type SeasonDraw } from "./outcome";
import type { OutcomeParams } from "./outcomeModel";

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

/** Expected weekly points of a streamable body per position. `{}` = no waivers (best ball). */
export type WaiverLine = Partial<Record<Position, number>>;

/** One week's optimal lineup, with the wire available for empty starting slots. */
export function lineupPointsWeek(
  entries: { pos: Position; pts: number }[],
  config: LeagueConfig,
  waiver: WaiverLine
): number {
  const all = entries.slice();
  for (const pos of POSITIONS) {
    const w = waiver[pos];
    if (w && (config.rosterSlots[pos] ?? 0) > 0) all.push({ pos, pts: w });
  }
  return optimalLineupTotal(all.map((e) => ({ pos: e.pos, score: e.pts })), config);
}

export interface RosterSample {
  mean: number;
  sd: number;
  samples: Float64Array;
}

const POS_INDEX: Record<Position, number> = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DST: 5 };

/**
 * Allocation-free optimal lineup for one week. Same answer as
 * `lineupPointsWeek`, built for the tens of thousands of calls the completed-
 * roster evaluation makes: fixed position buckets, insertion sort on ≤ ~10
 * entries, then FLEX from the best leftovers. The wire body per position is
 * appended when the slot exists and the wire pays.
 */
class FastLineup {
  private readonly slots = new Int8Array(6);
  private readonly flexEligible = new Uint8Array(6);
  private readonly wire = new Float64Array(6);
  private readonly flexSlots: number;
  private readonly buckets: number[][] = [[], [], [], [], [], []];
  constructor(config: LeagueConfig, waiver: WaiverLine) {
    for (const pos of POSITIONS) {
      const pi = POS_INDEX[pos];
      this.slots[pi] = config.rosterSlots[pos] ?? 0;
      this.flexEligible[pi] = config.flexEligible.includes(pos) ? 1 : 0;
      this.wire[pi] = this.slots[pi] > 0 ? waiver[pos] ?? 0 : 0;
    }
    this.flexSlots = config.rosterSlots.FLEX ?? 0;
  }
  /** posIdx[i], pts[i] for i < n. */
  total(posIdx: Int8Array, pts: Float64Array, n: number): number {
    const b = this.buckets;
    for (let pi = 0; pi < 6; pi++) {
      b[pi].length = 0;
      if (this.wire[pi] > 0) b[pi].push(this.wire[pi]);
    }
    for (let i = 0; i < n; i++) {
      const arr = b[posIdx[i]];
      const v = pts[i];
      // insertion into a descending array
      let k = arr.length;
      arr.push(v);
      while (k > 0 && arr[k - 1] < v) { arr[k] = arr[k - 1]; k--; }
      arr[k] = v;
    }
    let total = 0;
    for (let pi = 0; pi < 6; pi++) {
      const arr = b[pi];
      const take = Math.min(this.slots[pi], arr.length);
      for (let k = 0; k < take; k++) total += arr[k];
    }
    // FLEX: best leftovers across eligible positions.
    for (let f = 0; f < this.flexSlots; f++) {
      let bestPi = -1, bestV = -Infinity;
      for (let pi = 0; pi < 6; pi++) {
        if (!this.flexEligible[pi]) continue;
        const arr = b[pi];
        const k = this.slots[pi];
        if (k < arr.length && arr[k] > bestV) { bestV = arr[k]; bestPi = pi; }
      }
      if (bestPi < 0) break;
      total += bestV;
      b[bestPi].splice(this.slots[bestPi], 1);
    }
    return total;
  }
}

/**
 * Score every candidate's completed rosters with common random numbers: in
 * iteration `it`, each distinct player is sampled once and shared by every
 * candidate that rosters him, so the comparison between candidates is paired
 * and the draft-completion and season uncertainties combine in one sample.
 */
export function evaluateCompletions(
  base: BoardPlayer[],
  candidates: BoardPlayer[],
  futurePicks: BoardPlayer[][][],
  params: OutcomeParams,
  config: LeagueConfig,
  waiver: WaiverLine,
  seed: number,
  projOf?: (p: BoardPlayer) => number
): RosterSample[] {
  const iterations = futurePicks[0]?.length ?? 0;
  const out = candidates.map(() => new Float64Array(iterations));
  const fast = new FastLineup(config, waiver);
  for (let it = 0; it < iterations; it++) {
    const rng = makeRng((seed * 7919 + it * 104729) >>> 0);
    const shocks = makeTeamShocks(rng, params.weeks);
    const cache = new Map<string, SeasonDraw>();
    const draw = (p: BoardPlayer): SeasonDraw => {
      let d = cache.get(p.id);
      if (!d) {
        d = sampleSeason(p, params, rng, shocks, projOf?.(p));
        cache.set(p.id, d);
      }
      return d;
    };
    const baseDraws = base.map(draw);
    for (let ci = 0; ci < candidates.length; ci++) {
      const roster = [candidates[ci], ...futurePicks[ci][it]];
      const draws = [...baseDraws, ...roster.map(draw)];
      const n = draws.length;
      const posIdx = new Int8Array(n);
      for (let i = 0; i < base.length; i++) posIdx[i] = POS_INDEX[base[i].pos];
      for (let i = 0; i < roster.length; i++) posIdx[base.length + i] = POS_INDEX[roster[i].pos];
      const pts = new Float64Array(n);
      let total = 0;
      for (let w = 0; w < params.weeks; w++) {
        for (let i = 0; i < n; i++) pts[i] = draws[i].weekly[w];
        total += fast.total(posIdx, pts, n);
      }
      out[ci][it] = total;
    }
  }
  return out.map((samples) => {
    let s = 0;
    for (const v of samples) s += v;
    const mean = samples.length ? s / samples.length : 0;
    let v = 0;
    for (const x of samples) v += (x - mean) ** 2;
    return { mean, sd: samples.length > 1 ? Math.sqrt(v / (samples.length - 1)) : 0, samples };
  });
}

/**
 * Deterministic, closed-form gain from adding `candidate` to `roster` NOW,
 * using expected weekly points (byes exact). Used to shortlist candidates;
 * the completed-roster simulation makes the actual decision.
 */
export function marginalGainNow(
  candidate: BoardPlayer,
  roster: BoardPlayer[],
  params: OutcomeParams,
  config: LeagueConfig,
  waiver: WaiverLine,
  projOf?: (p: BoardPlayer) => number
): number {
  const rate = (p: BoardPlayer) => expectedWeekly(p, params, projOf?.(p));
  const rates = roster.map(rate);
  const cRate = rate(candidate);
  let gain = 0;
  for (let week = 1; week <= params.weeks; week++) {
    const entries = roster.map((p, i) => ({ pos: p.pos, pts: p.bye === week ? 0 : rates[i] }));
    const before = lineupPointsWeek(entries, config, waiver);
    const after = lineupPointsWeek(
      [...entries, { pos: candidate.pos, pts: candidate.bye === week ? 0 : cRate }],
      config,
      waiver
    );
    gain += after - before;
  }
  return gain;
}

/**
 * O(1)-per-player gain approximation for the roster-completion greedy fill:
 * per position, the slot-weeks one more body would cover on this roster
 * (open starting slots ≈ 16, bench insurance decays with depth) times the
 * body's expected weekly rate above the wire. FLEX counts as an extra slot
 * for the flex-eligible position with the largest share while it is open.
 */
export function positionGainTable(
  roster: { pos: Position; bye: number | null }[],
  params: OutcomeParams,
  config: LeagueConfig,
  waiver: WaiverLine
): Record<Position, (weeklyRate: number) => number> {
  void params;
  const flexSlots = config.rosterSlots.FLEX ?? 0;
  const surplus = config.flexEligible.reduce(
    (a, fp) => a + Math.max(0, roster.filter((r) => r.pos === fp).length - (config.rosterSlots[fp] ?? 0)),
    0
  );
  const flexOpen = surplus < flexSlots;
  const maxShare = Math.max(...config.flexEligible.map((fp) => FLEX_SHARE[fp] ?? 0), 1e-9);
  const table = {} as Record<Position, (weeklyRate: number) => number>;
  for (const pos of POSITIONS) {
    const slots = (config.rosterSlots[pos] ?? 0) + (flexOpen && (FLEX_SHARE[pos] ?? 0) >= maxShare - 1e-9 ? 1 : 0);
    const cfg: LeagueConfig = { ...config, rosterSlots: { ...config.rosterSlots, [pos]: slots } };
    const weeks = slots > 0 ? coverageSlotWeeks(pos, null, roster, cfg) : 0;
    const wire = waiver[pos] ?? 0;
    table[pos] = (weeklyRate) => weeks * Math.max(0, weeklyRate - wire);
  }
  return table;
}

/** Helper for callers building completion players. */
export function rateAndAvail(p: BoardPlayer, params: OutcomeParams, projOverride?: number): { rate: number; avail: number } {
  return { rate: healthyRate(p, params, projOverride), avail: availability(p, params) };
}
