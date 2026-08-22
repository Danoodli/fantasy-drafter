// Monte Carlo over the wrap: simulate every opponent pick between now and my
// next two picks, then greedily fill my roster at those picks. One shared set
// of sampled drafts is evaluated for all candidates, so 12 candidates cost
// barely more than one. Deterministic given a seed — testable, replayable.
//
// Per iteration: each player's "effective draft position" is sampled ONCE
// (adp + stdev·gaussian); opponents then take players in that sampled order,
// skipping roster-need-capped positions. This is O(players) gaussians per
// iteration instead of O(players × picks), which is what keeps the full
// recompute under the 50ms budget.

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
/** Opponent roster-need caps: beyond these counts a position is skipped. */
const OPP_CAP = [2, 7, 7, 2, 1, 1]; // QB RB WR TE K DST

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

  // Slots are 1..teams; flatten opponent counts into slot-major Int16 array.
  const baseOppCounts = new Int16Array((shared.teams + 1) * 6);
  for (const [slotStr, counts] of Object.entries(shared.opponentCounts)) {
    const slot = Number(slotStr);
    for (const [p, c] of Object.entries(counts)) {
      baseOppCounts[slot * 6 + POS_INDEX[p as Position]] = c ?? 0;
    }
  }

  const lastTwoRoundsStart = (shared.rounds - 2) * shared.teams;
  const x = new Float64Array(n); // sampled effective draft position
  const order = new Int32Array(n);
  const taken = new Uint8Array(n);
  const oppCounts = new Int16Array(baseOppCounts.length);
  const totals = candidates.map(() => new Float64Array(iterations));

  // Reusable per-candidate my-counts as plain objects (small, 6 keys).
  const myCountsProto = candidates.map((c) => ({ ...c.myCounts }));

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) x[i] = adp[i] + stdev[i] * gaussian(rng);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => x[a] - x[b]);

    for (let ci = 0; ci < nc; ci++) {
      const cand = candidates[ci];
      taken.fill(0);
      if (cand.playerIndex >= 0) taken[cand.playerIndex] = 1;
      oppCounts.set(baseOppCounts);
      const myCounts: Partial<Record<Position, number>> = { ...myCountsProto[ci] };
      let total = 0;
      let ptr = 0; // pointer into `order` for opponent picks

      for (const step of shared.schedule) {
        if (step.mine) {
          // Greedy: best need-weighted value among top available by ADP.
          let bestIdx = -1;
          let bestVal = -Infinity;
          for (let i = 0, seen = 0; i < n && seen < 50; i++) {
            if (taken[i]) continue;
            seen++;
            const p = shared.players[i];
            const w = cand.myPosWeight(p.pos, myCounts);
            if (w <= 0) continue;
            const v = value[i] * w;
            if (v > bestVal) {
              bestVal = v;
              bestIdx = i;
            }
          }
          if (bestIdx >= 0) {
            taken[bestIdx] = 1;
            const p = shared.players[bestIdx];
            total += bestVal;
            myCounts[p.pos] = (myCounts[p.pos] ?? 0) + 1;
          }
        } else {
          const early = step.pickNo <= lastTwoRoundsStart;
          const cBase = step.slot * 6;
          // Advance through sampled order; skip taken/capped positions.
          let j = ptr;
          let picked = -1;
          let firstSkipped = -1;
          while (j < n) {
            const i = order[j];
            if (!taken[i]) {
              const pi = pos[i];
              const capped = oppCounts[cBase + pi] >= OPP_CAP[pi] || (early && pi >= 4);
              if (!capped) {
                picked = i;
                break;
              }
              if (firstSkipped < 0) firstSkipped = j;
            } else if (j === ptr) {
              ptr++; // shrink the window when the head is consumed
            }
            j++;
          }
          if (picked < 0 && firstSkipped >= 0) picked = order[firstSkipped];
          if (picked >= 0) {
            taken[picked] = 1;
            oppCounts[cBase + pos[picked]]++;
          }
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
