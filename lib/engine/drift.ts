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
 * Per-position ADP drift, in picks. Positive = the room takes this position
 * LATER than national ADP; the survival model shifts accordingly.
 */
export function computeDrift(
  picks: DraftPick[],
  boardById: Map<string, BoardPlayer>
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
    const s = sums[pos];
    if (!s || s.n === 0) continue;
    drift[pos] = s.sum / (s.n + DRIFT_PRIOR_WEIGHT);
  }
  return drift;
}
