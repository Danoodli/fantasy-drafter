// Survival model: P(player still on the board at pick n), from FFC's
// per-player ADP mean + stdev via the normal CDF. Pure functions.

import type { BoardPlayer, Position } from "../types";

/** Abramowitz–Stegun approximation of the standard normal CDF. */
export function normalCdf(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/**
 * P(player is still available at overall pick n), given an optional
 * per-position ADP drift observed in this room (+ = position going later).
 * adpHigh/adpLow act as soft bounds: before anyone has ever taken him,
 * availability is near-certain; after everyone always has, near-zero.
 */
export function survivalProb(
  player: Pick<BoardPlayer, "adp" | "adpStdev" | "adpHigh" | "adpLow" | "pos">,
  pickNo: number,
  drift: Partial<Record<Position, number>> = {}
): number {
  const shift = drift[player.pos] ?? 0;
  const adp = player.adp + shift;
  const stdev = Math.max(0.7, player.adpStdev);
  let p = 1 - normalCdf((pickNo - adp) / stdev);
  if (pickNo <= player.adpHigh + shift) p = Math.max(p, 0.95);
  if (pickNo >= player.adpLow + shift) p = Math.min(p, 0.05);
  return Math.min(1, Math.max(0, p));
}
