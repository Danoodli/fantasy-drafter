// Room drift: how this specific draft room deviates from national ADP,
// per position. Blend of a zero prior and observed evidence, weighted by
// sample size — ~90% prior at the first pick, decaying as picks accumulate.

import type { BoardPlayer, DraftPick, Position } from "../types";
import { POSITIONS } from "../types";

/** Prior weight in "virtual picks". With 8 observed picks at a position, the observed mean carries 50%. */
export const DRIFT_PRIOR_WEIGHT = 8;

/** Ignore deltas beyond this — someone drafting their nephew isn't a trend. */
const OUTLIER_CLAMP = 36;

/**
 * A drift prior fitted from this league's PREVIOUS season's draft
 * (scripts/build-board.ts emits public/data/drift-prior.json). It enters the
 * blend as `weight` virtual picks centered on last year's observed bias.
 */
export interface DriftPrior {
  drift: Partial<Record<Position, number>>;
  /** Virtual sample size the prior carries per position. */
  weight: number;
}

/**
 * Per-position ADP drift, in picks. Positive = the room takes this position
 * LATER than national ADP; the survival model shifts accordingly.
 *
 * Blend: (prior mean × prior weight + observed deltas) / (weights + samples),
 * with an extra zero-anchored regularizer so one pick can't swing it.
 */
export function computeDrift(
  picks: DraftPick[],
  boardById: Map<string, BoardPlayer>,
  prior?: DriftPrior
): Partial<Record<Position, number>> {
  const sums: Partial<Record<Position, { sum: number; n: number }>> = {};
  for (const pick of picks) {
    if (pick.isKeeper) continue; // keepers aren't market signal
    const player = boardById.get(pick.playerId);
    if (!player) continue;
    const delta = Math.max(-OUTLIER_CLAMP, Math.min(OUTLIER_CLAMP, pick.pickNo - player.adp));
    const s = (sums[player.pos] ??= { sum: 0, n: 0 });
    s.sum += delta;
    s.n += 1;
  }
  const drift: Partial<Record<Position, number>> = {};
  for (const pos of POSITIONS) {
    const s = sums[pos] ?? { sum: 0, n: 0 };
    const priorMean = prior?.drift[pos];
    const priorW = priorMean != null ? prior!.weight : 0;
    if (s.n === 0 && priorW === 0) continue;
    drift[pos] =
      (s.sum + (priorMean ?? 0) * priorW) / (s.n + priorW + DRIFT_PRIOR_WEIGHT);
  }
  return drift;
}
