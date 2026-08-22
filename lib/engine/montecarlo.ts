// Monte Carlo over the wrap: simulate every opponent pick between now and my
// next two picks, then greedily fill my roster at those picks. Deterministic
// given a seed — testable, replayable.
//
// Two structural optimizations keep the full recompute inside the 50ms budget:
// 1. Each player's "effective draft position" is sampled ONCE per iteration
//    (adp + stdev·gaussian) and opponents take players in that order —
//    O(players) gaussians per iteration instead of O(players × picks).
// 2. The opponent walk runs ONCE per iteration and is SHARED by all
//    candidates: opponents don't react to my pick, so each candidate just
//    replays the taken-sequence, skipping itself (the next player in the
//    sequence shifts in — exactly what the room would do).

import type { Position } from "../types";

/** mulberry32 — tiny fast seeded PRNG. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, one value per call. */
function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const POS_INDEX: Record<Position, number> = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DST: 5 };
const POS_LIST: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];
/** Opponent roster-need caps: beyond these counts a position is skipped. */
const OPP_CAP = [2, 7, 7, 2, 1, 1]; // QB RB WR TE K DST

const GREEDY_SCAN = 60; // my greedy picks consider this many top-of-ADP players

export interface SimPlayer {
  pos: Position;
  adp: number;
  stdev: number;
  value: number; // blended draft value (not raw points)
}

export interface SimCandidate {
  /** Index into the shared player list, or -1 if the candidate isn't in it. */
  playerIndex: number;
  /** My position counts INCLUDING the candidate. */
  myCounts: Partial<Record<Position, number>>;
  /** Value multiplier for my future greedy picks (strategy × need). */
  myPosWeight: (pos: Position, counts: Partial<Record<Position, number>>) => number;
}

export interface SimShared {
  /** Available players sorted by ADP asc (candidates included). */
  players: SimPlayer[];
  /** Opponent position counts by draft slot (1-indexed). */
  opponentCounts: Record<number, Partial<Record<Position, number>>>;
  /** Picks to simulate after the current one: ascending, mine flagged. */
  schedule: { pickNo: number; slot: number; mine: boolean }[];
  teams: number;
  rounds: number;
}

export interface SimResult {
  mean: number;
  stdev: number;
}

export function simulateAll(
  shared: SimShared,
  candidates: SimCandidate[],
  iterations: number,
  seed: number
): SimResult[] {
  const n = shared.players.length;
  const nc = candidates.length;
  if (shared.schedule.length === 0 || n === 0) {
    return candidates.map(() => ({ mean: 0, stdev: 0 }));
  }

  const rng = makeRng(seed);
  const pos = new Int8Array(n);
  const adp = new Float64Array(n);
  const stdev = new Float64Array(n);
  const value = new Float64Array(n);
  shared.players.forEach((p, i) => {
    pos[i] = POS_INDEX[p.pos];
    adp[i] = p.adp;
    stdev[i] = Math.max(1.5, p.stdev);
    value[i] = p.value;
  });

  const baseOppCounts = new Int16Array((shared.teams + 1) * 6);
  for (const [slotStr, counts] of Object.entries(shared.opponentCounts)) {
    const slot = Number(slotStr);
    for (const [p, c] of Object.entries(counts)) {
      baseOppCounts[slot * 6 + POS_INDEX[p as Position]] = c ?? 0;
    }
  }

  // Schedule split: for each of my sim picks, how many opponent picks precede it.
  const oppBeforeMine: number[] = [];
  let oppSteps = 0;
  for (const step of shared.schedule) {
    if (step.mine) oppBeforeMine.push(oppSteps);
    else oppSteps++;
  }
  const BUFFER = 2; // extra opponent picks: replacements when a candidate collides
  const lastTwoRoundsStart = (shared.rounds - 2) * shared.teams;

  const x = new Float64Array(n);
  const order = new Int32Array(n);
  const walkTaken = new Uint8Array(n);
  const taken = new Uint8Array(n);
  const oppCounts = new Int16Array(baseOppCounts.length);
  const seq = new Int32Array(oppSteps + BUFFER);
  const totals = candidates.map(() => new Float64Array(iterations));

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) x[i] = adp[i] + stdev[i] * gaussian(rng);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => x[a] - x[b]);

    // --- one opponent walk per iteration, shared by all candidates ---------
    walkTaken.fill(0);
    oppCounts.set(baseOppCounts);
    let seqLen = 0;
    let ptr = 0;
    for (const step of shared.schedule) {
      if (step.mine) continue;
      const early = step.pickNo <= lastTwoRoundsStart;
      const cBase = step.slot * 6;
      let picked = -1;
      let firstSkipped = -1;
      for (let j = ptr; j < n; j++) {
        const i = order[j];
        if (walkTaken[i]) {
          if (j === ptr) ptr++;
          continue;
        }
        const pi = pos[i];
        if (oppCounts[cBase + pi] >= OPP_CAP[pi] || (early && pi >= 4)) {
          if (firstSkipped < 0) firstSkipped = j;
          continue;
        }
        picked = i;
        break;
      }
      if (picked < 0 && firstSkipped >= 0) picked = order[firstSkipped];
      if (picked >= 0) {
        walkTaken[picked] = 1;
        oppCounts[cBase + pos[picked]]++;
        seq[seqLen++] = picked;
      }
    }
    // Buffer picks: generic next-off-the-board replacements.
    for (let b = 0; b < BUFFER; b++) {
      for (let j = ptr; j < n; j++) {
        const i = order[j];
        if (!walkTaken[i]) {
          walkTaken[i] = 1;
          seq[seqLen++] = i;
          break;
        }
      }
    }

    // --- each candidate replays the sequence, skipping itself --------------
    for (let ci = 0; ci < nc; ci++) {
      const cand = candidates[ci];
      taken.fill(0);
      if (cand.playerIndex >= 0) taken[cand.playerIndex] = 1;
      const counts: Partial<Record<Position, number>> = { ...cand.myCounts };
      let total = 0;
      let seqPtr = 0;
      let consumed = 0;

      for (let k = 0; k < oppBeforeMine.length; k++) {
        // Opponents consume up to their pick count; a taken entry (my
        // candidate or an earlier greedy pick) shifts the next one in.
        const target = oppBeforeMine[k];
        while (consumed < target && seqPtr < seqLen) {
          const e = seq[seqPtr++];
          if (taken[e]) continue;
          taken[e] = 1;
          consumed++;
        }
        // My greedy pick: need-weighted best among top-of-ADP survivors.
        const w: number[] = POS_LIST.map((p) => cand.myPosWeight(p, counts));
        let bestIdx = -1;
        let bestVal = -Infinity;
        for (let i = 0, seen = 0; i < n && seen < GREEDY_SCAN; i++) {
          if (taken[i]) continue;
          seen++;
          const wv = w[pos[i]];
          if (wv <= 0) continue;
          const v = value[i] * wv;
          if (v > bestVal) {
            bestVal = v;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0) {
          taken[bestIdx] = 1;
          total += bestVal;
          const p = POS_LIST[pos[bestIdx]];
          counts[p] = (counts[p] ?? 0) + 1;
        }
      }
      totals[ci][it] = total;
    }
  }

  return totals.map((arr) => {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
    const mean = sum / arr.length;
    let vs = 0;
    for (let i = 0; i < arr.length; i++) vs += (arr[i] - mean) ** 2;
    return { mean, stdev: Math.sqrt(vs / arr.length) };
  });
}
