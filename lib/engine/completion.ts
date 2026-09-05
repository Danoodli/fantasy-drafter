// Roster completion: what will my roster look like at the end of the draft
// if I take candidate c now?
//
// Per iteration, every remaining player gets one effective draft position
// (adp + stdev·N(0,1)) — the market. Each opponent takes the earliest player
// in that order whose expected lineup gain FOR THEIR ROSTER is meaningful:
// the best available player they need, judged by the same objective I use
// for myself. Between opponent runs, I fill my own future picks greedily by
// expected lineup gain on my roster-so-far. One opponent walk per iteration
// is shared by all candidates (opponents do not react to my pick); each
// candidate replays it, skipping itself and its own earlier picks.
// Pure and seeded. No position caps, no pacing rules.

import type { LeagueConfig, Position } from "../types";
import { makeRng } from "./montecarlo";
import { gaussian } from "./outcome";
import { positionGainTable, type WaiverLine } from "./rosterValue";
import { coverageSlotWeeks } from "./coverage";
import { FLEX_SHARE } from "./baselines";
import type { OutcomeParams } from "./outcomeModel";

/** How far down the market order a drafter looks for a player he needs. */
const OPP_SCAN = 10;
/** A position counts as a need when its gain is at least this share of the best gain on offer. */
const NEED_SHARE = 0.5;
/** How many top-of-market survivors my own greedy pick considers. */
const GREEDY_SCAN = 60;

export interface CompletionPlayer {
  id: string;
  pos: Position;
  adp: number;
  stdev: number;
  bye: number | null;
  /** expected points per week when rostered (rate × availability) */
  weeklyRate: number;
}

export type RosterShape = { pos: Position; bye: number | null }[];

export interface CompletionShared {
  /** available players, any order */
  players: CompletionPlayer[];
  myRoster: CompletionPlayer[];
  /** slot (1-indexed) → what that team already holds */
  opponentRosters: Record<number, RosterShape>;
  /** picks after the current one, ascending, mine flagged */
  schedule: { pickNo: number; slot: number; mine: boolean }[];
  teams: number;
  rounds: number;
  config: LeagueConfig;
  waiver: WaiverLine;
  params: OutcomeParams;
}

/**
 * The pick a need-aware drafter makes from `candidates` (market order):
 * the earliest whose gain for `roster` is within NEED_SHARE of the best gain
 * on offer. Falls back to the earliest when nothing stands out.
 */
export function opponentChoice(
  candidates: CompletionPlayer[],
  roster: RosterShape,
  params: OutcomeParams,
  config: LeagueConfig,
  waiver: WaiverLine
): number {
  if (candidates.length === 0) return -1;
  const table = positionGainTable(roster, params, config, waiver);
  // A marginal body covers ONE slot whether the team has one hole or three, so
  // urgency must also count how many starting slots at the position are still
  // open: a 2-RB / 0-WR team needs WRs, and an empty roster wants RB/WR (three
  // holes each, with FLEX) before a QB (one). No rule — just how many holes.
  const flexSlots = config.rosterSlots.FLEX ?? 0;
  const surplus = config.flexEligible.reduce((a, fp) => a + Math.max(0, roster.filter((r) => r.pos === fp).length - (config.rosterSlots[fp] ?? 0)), 0);
  const flexOpen = surplus < flexSlots;
  const maxShare = Math.max(...config.flexEligible.map((fp) => FLEX_SHARE[fp] ?? 0), 1e-9);
  const openSlots = (pos: Position) => {
    const eff = (config.rosterSlots[pos] ?? 0) + (flexOpen && config.flexEligible.includes(pos) && (FLEX_SHARE[pos] ?? 0) >= maxShare - 1e-9 ? 1 : 0);
    return Math.max(0, eff - roster.filter((r) => r.pos === pos).length);
  };
  // Phase 1 — starters. Humans fill open starting slots first, the position with
  // the most holes first, and take the earliest market player who does it.
  // A hole only counts when filling it beats the wire, so K/DST (whose shrunk
  // projections barely clear the wire) wait until nothing else is open.
  let maxOpen = 0;
  const open = candidates.map((c) => (table[c.pos](c.weeklyRate) > 0 ? openSlots(c.pos) : 0));
  for (const o of open) if (o > maxOpen) maxOpen = o;
  if (maxOpen > 0) {
    for (let j = 0; j < candidates.length; j++) if (open[j] === maxOpen) return j;
  }
  // Phase 2 — depth. Starters set: the best available by expected lineup gain.
  const gains = candidates.map((c) => table[c.pos](c.weeklyRate));
  const best = Math.max(...gains);
  if (best <= 0) return 0;
  for (let j = 0; j < candidates.length; j++) if (gains[j] >= NEED_SHARE * best) return j;
  return 0;
}

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];
const POS_INDEX: Record<Position, number> = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DST: 5 };
const MAX_BODIES = 12;

/**
 * Gain by (position, bodies already held, flex open) — the bye-blind twin of
 * positionGainTable, precomputed once per recommend() so the ~150 opponent picks
 * per iteration cost O(1) each. Opponents' bye weeks do not change what is left
 * for me, and my own future picks are re-evaluated exactly (with byes) afterwards.
 */
export interface CountGainTable {
  weeks: Float64Array; // [(posIdx * (MAX_BODIES + 1) + bodies) * 2 + flexOpen]
  wire: Float64Array; // per posIdx
  flexSlots: number;
  flexEligible: Uint8Array; // per posIdx, 1 if eligible
  maxSharePos: Uint8Array; // per posIdx, 1 if this position gets the extra FLEX slot
  slots: Int8Array; // per posIdx, starting slots
}

export function makeCountGainTable(config: LeagueConfig, waiver: WaiverLine): CountGainTable {
  const maxShare = Math.max(...config.flexEligible.map((fp) => FLEX_SHARE[fp] ?? 0), 1e-9);
  const weeks = new Float64Array(6 * (MAX_BODIES + 1) * 2);
  const wire = new Float64Array(6);
  const flexEligible = new Uint8Array(6);
  const maxSharePos = new Uint8Array(6);
  const slots = new Int8Array(6);
  for (const pos of POSITIONS) {
    const pi = POS_INDEX[pos];
    wire[pi] = waiver[pos] ?? 0;
    flexEligible[pi] = config.flexEligible.includes(pos) ? 1 : 0;
    maxSharePos[pi] = flexEligible[pi] && (FLEX_SHARE[pos] ?? 0) >= maxShare - 1e-9 ? 1 : 0;
    slots[pi] = config.rosterSlots[pos] ?? 0;
    for (let bodies = 0; bodies <= MAX_BODIES; bodies++) {
      const roster = Array.from({ length: bodies }, () => ({ pos, bye: null as number | null }));
      for (let flexOpen = 0; flexOpen < 2; flexOpen++) {
        const eff = slots[pi] + (flexOpen && maxSharePos[pi] ? 1 : 0);
        const cfg: LeagueConfig = { ...config, rosterSlots: { ...config.rosterSlots, [pos]: eff } };
        weeks[(pi * (MAX_BODIES + 1) + bodies) * 2 + flexOpen] = eff > 0 ? coverageSlotWeeks(pos, null, roster, cfg) : 0;
      }
    }
  }
  return { weeks, wire, flexSlots: config.rosterSlots.FLEX ?? 0, flexEligible, maxSharePos, slots };
}

/** Is the FLEX still unclaimed by surplus bodies at flex-eligible positions? */
function flexOpenFor(counts: Int8Array, t: CountGainTable): 0 | 1 {
  let surplus = 0;
  for (let pi = 0; pi < 6; pi++) if (t.flexEligible[pi]) surplus += Math.max(0, counts[pi] - t.slots[pi]);
  return surplus < t.flexSlots ? 1 : 0;
}

/** Gain for one more body at `pi` given the roster's position counts. */
export function countGain(t: CountGainTable, counts: Int8Array, pi: number, weeklyRate: number): number {
  const bodies = Math.min(MAX_BODIES, counts[pi]);
  const w = t.weeks[(pi * (MAX_BODIES + 1) + bodies) * 2 + flexOpenFor(counts, t)];
  return w * Math.max(0, weeklyRate - t.wire[pi]);
}

/** Open starting slots at `pi` (FLEX counted for the max-share positions while it is open). */
function countOpen(t: CountGainTable, counts: Int8Array, pi: number): number {
  const flexOpen = flexOpenFor(counts, t);
  const eff = t.slots[pi] + (flexOpen && t.maxSharePos[pi] ? 1 : 0);
  return Math.max(0, eff - counts[pi]);
}

/**
 * Need-aware drafter over position counts: the earliest of the first OPP_SCAN
 * market survivors whose gain is within NEED_SHARE of the best. The bye-aware
 * `opponentChoice` above is the reference implementation this mirrors.
 */
function chooseByCounts(
  t: CountGainTable,
  counts: Int8Array,
  order: Int32Array,
  taken: Uint8Array,
  players: CompletionPlayer[],
  scan: number,
  scratchGain: Float64Array,
  scratchIdx: Int32Array
): number {
  let m = 0;
  let best = 0;
  let maxOpen = 0;
  let firstAtMaxOpen = -1;
  for (let j = 0; j < order.length && m < scan; j++) {
    const i = order[j];
    if (taken[i]) continue;
    const pi = POS_INDEX[players[i].pos];
    const g = countGain(t, counts, pi, players[i].weeklyRate);
    const o = g > 0 ? countOpen(t, counts, pi) : 0;
    if (o > maxOpen) { maxOpen = o; firstAtMaxOpen = i; }
    scratchGain[m] = g;
    scratchIdx[m] = i;
    if (g > best) best = g;
    m++;
  }
  if (m === 0) return -1;
  if (maxOpen > 0) return firstAtMaxOpen; // phase 1: most open starting slots, earliest in market
  if (best <= 0) return scratchIdx[0];
  for (let k = 0; k < m; k++) if (scratchGain[k] >= NEED_SHARE * best) return scratchIdx[k]; // phase 2: depth by gain
  return scratchIdx[0];
}

export function completeRosters(
  shared: CompletionShared,
  candidateIdx: number[],
  iterations: number,
  seed: number
): number[][][] {
  const n = shared.players.length;
  const myPickCount = shared.schedule.filter((s) => s.mine).length;
  const out = candidateIdx.map(() => Array.from({ length: iterations }, () => [] as number[]));
  if (n === 0 || myPickCount === 0) return out;

  const rng = makeRng(seed);
  const adp = new Float64Array(n);
  const stdev = new Float64Array(n);
  const posIdx = new Int8Array(n);
  shared.players.forEach((p, i) => {
    adp[i] = p.adp;
    stdev[i] = Math.max(1.5, p.stdev);
    posIdx[i] = POS_INDEX[p.pos];
  });
  const table = makeCountGainTable(shared.config, shared.waiver);
  const baseOpp = new Map<number, Int8Array>();
  for (const [slot, r] of Object.entries(shared.opponentRosters)) {
    const c = new Int8Array(6);
    for (const p of r) c[POS_INDEX[p.pos]]++;
    baseOpp.set(Number(slot), c);
  }
  const myBase = new Int8Array(6);
  for (const p of shared.myRoster) myBase[POS_INDEX[p.pos]]++;

  const x = new Float64Array(n);
  const order = new Int32Array(n);
  const walkTaken = new Uint8Array(n);
  const taken = new Uint8Array(n);
  const seq: number[] = [];
  const scratchGain = new Float64Array(Math.max(OPP_SCAN, GREEDY_SCAN));
  const scratchIdx = new Int32Array(Math.max(OPP_SCAN, GREEDY_SCAN));
  const oppCounts = new Map<number, Int8Array>();
  const myCounts = new Int8Array(6);

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) x[i] = adp[i] + stdev[i] * gaussian(rng);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => x[a] - x[b]);

    // Shared opponent walk: each opponent takes what its roster needs.
    walkTaken.fill(0);
    seq.length = 0;
    const oppBeforeMine: number[] = [];
    oppCounts.clear();
    let oppSteps = 0;
    for (const step of shared.schedule) {
      if (step.mine) { oppBeforeMine.push(oppSteps); continue; }
      let counts = oppCounts.get(step.slot);
      if (!counts) { counts = new Int8Array(baseOpp.get(step.slot) ?? new Int8Array(6)); oppCounts.set(step.slot, counts); }
      const picked = chooseByCounts(table, counts, order, walkTaken, shared.players, OPP_SCAN, scratchGain, scratchIdx);
      if (picked < 0) break;
      walkTaken[picked] = 1;
      counts[posIdx[picked]]++;
      seq.push(picked);
      oppSteps++;
    }
    // Replacements for when a candidate or one of my picks collides with the walk.
    for (let j = 0, added = 0; j < n && added < myPickCount + 2; j++) {
      const i = order[j];
      if (!walkTaken[i]) { walkTaken[i] = 1; seq.push(i); added++; }
    }

    for (let ci = 0; ci < candidateIdx.length; ci++) {
      const cIdx = candidateIdx[ci];
      taken.fill(0);
      taken[cIdx] = 1;
      myCounts.set(myBase);
      myCounts[posIdx[cIdx]]++;
      let seqPtr = 0, consumed = 0;
      for (let k = 0; k < oppBeforeMine.length; k++) {
        while (consumed < oppBeforeMine[k] && seqPtr < seq.length) {
          const e = seq[seqPtr++];
          if (taken[e]) continue;
          taken[e] = 1; consumed++;
        }
        // My pick: best expected lineup gain among top-of-market survivors.
        let best = -1, bestGain = -Infinity;
        for (let j = 0, seen = 0; j < n && seen < GREEDY_SCAN; j++) {
          const i = order[j];
          if (taken[i]) continue;
          seen++;
          const g = countGain(table, myCounts, posIdx[i], shared.players[i].weeklyRate);
          if (g > bestGain) { bestGain = g; best = i; }
        }
        if (best < 0) break;
        taken[best] = 1;
        myCounts[posIdx[best]]++;
        out[ci][it].push(best);
      }
    }
  }
  return out;
}
