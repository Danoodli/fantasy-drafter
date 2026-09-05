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
  const gains = candidates.map((c) => table[c.pos](c.weeklyRate));
  const best = Math.max(...gains);
  if (best <= 0) return 0;
  for (let j = 0; j < candidates.length; j++) if (gains[j] >= NEED_SHARE * best) return j;
  return 0;
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
  shared.players.forEach((p, i) => {
    adp[i] = p.adp;
    stdev[i] = Math.max(1.5, p.stdev);
  });

  const x = new Float64Array(n);
  const order = new Int32Array(n);
  const walkTaken = new Uint8Array(n);
  const seq: number[] = [];

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) x[i] = adp[i] + stdev[i] * gaussian(rng);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => x[a] - x[b]);

    // Shared opponent walk: each opponent takes what its roster needs.
    walkTaken.fill(0);
    seq.length = 0;
    const oppBeforeMine: number[] = [];
    const rosters: Record<number, RosterShape> = {};
    for (const [slot, r] of Object.entries(shared.opponentRosters)) rosters[Number(slot)] = r.slice();
    let oppSteps = 0;
    for (const step of shared.schedule) {
      if (step.mine) { oppBeforeMine.push(oppSteps); continue; }
      const cands: CompletionPlayer[] = [];
      const candIdx: number[] = [];
      for (let j = 0; j < n && cands.length < OPP_SCAN; j++) {
        const i = order[j];
        if (walkTaken[i]) continue;
        cands.push(shared.players[i]);
        candIdx.push(i);
      }
      if (cands.length === 0) break;
      const roster = rosters[step.slot] ?? (rosters[step.slot] = []);
      const k = opponentChoice(cands, roster, shared.params, shared.config, shared.waiver);
      const picked = candIdx[k];
      walkTaken[picked] = 1;
      roster.push({ pos: shared.players[picked].pos, bye: shared.players[picked].bye });
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
      const taken = new Uint8Array(n);
      taken[cIdx] = 1;
      const rosterSoFar: RosterShape = [
        ...shared.myRoster.map((p) => ({ pos: p.pos, bye: p.bye })),
        { pos: shared.players[cIdx].pos, bye: shared.players[cIdx].bye },
      ];
      let seqPtr = 0, consumed = 0;
      for (let k = 0; k < oppBeforeMine.length; k++) {
        while (consumed < oppBeforeMine[k] && seqPtr < seq.length) {
          const e = seq[seqPtr++];
          if (taken[e]) continue;
          taken[e] = 1; consumed++;
        }
        // My pick: best expected lineup gain among top-of-market survivors.
        const gain = positionGainTable(rosterSoFar, shared.params, shared.config, shared.waiver);
        let best = -1, bestGain = -Infinity;
        for (let j = 0, seen = 0; j < n && seen < GREEDY_SCAN; j++) {
          const i = order[j];
          if (taken[i]) continue;
          seen++;
          const g = gain[shared.players[i].pos](shared.players[i].weeklyRate);
          if (g > bestGain) { bestGain = g; best = i; }
        }
        if (best < 0) break;
        taken[best] = 1;
        out[ci][it].push(best);
        rosterSoFar.push({ pos: shared.players[best].pos, bye: shared.players[best].bye });
      }
    }
  }
  return out;
}
