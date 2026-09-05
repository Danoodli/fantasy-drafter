// Survival model: P(player still on the board at pick n), from FFC's
// per-player ADP mean + stdev via the normal CDF. Pure functions.
//
// Tail lever (config/survival.json): the same noise model drives both this
// CDF and the simulated market's draws (montecarlo, completion, replay), so
// the engine's opponents reach and let players fall exactly as often as the
// survival math assumes. Defaults are a plain normal — identical to the
// model before the lever existed. `pnpm calibrate:survival` fits it on real
// drafts and reports whether turning it on is worth it.

import type { BoardPlayer, Position } from "../types";
import survivalJson from "../../config/survival.json";

export interface SurvivalTail {
  /** Multiplies every player's ADP stdev. 1 = as published. */
  tailScale: number;
  /** Share of picks drawn from the wide component. 0 = off (pure normal). */
  wideShare: number;
  /** How much wider the wide component is. */
  wideFactor: number;
}

export const DEFAULT_TAIL: SurvivalTail = {
  tailScale: survivalJson.tailScale,
  wideShare: survivalJson.wideShare,
  wideFactor: survivalJson.wideFactor,
};

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

/** P(a draw from the tail-model noise around `adp` with `stdev` lands at or after `pickNo`). */
function tailSurvival(adp: number, stdev: number, pickNo: number, tail: SurvivalTail): number {
  const sigma = Math.max(0.7, stdev * tail.tailScale);
  const narrow = 1 - normalCdf((pickNo - adp) / sigma);
  if (tail.wideShare <= 0) return narrow;
  const wide = 1 - normalCdf((pickNo - adp) / (sigma * tail.wideFactor));
  return (1 - tail.wideShare) * narrow + tail.wideShare * wide;
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
  drift: Partial<Record<Position, number>> = {},
  tail: SurvivalTail = DEFAULT_TAIL
): number {
  const shift = drift[player.pos] ?? 0;
  const adp = player.adp + shift;
  let p = tailSurvival(adp, player.adpStdev, pickNo, tail);
  if (pickNo <= player.adpHigh + shift) p = Math.max(p, 0.95);
  if (pickNo >= player.adpLow + shift) p = Math.min(p, 0.05);
  return Math.min(1, Math.max(0, p));
}

/**
 * One draw of pick noise for the simulated market: where a player with this
 * ADP stdev actually goes, relative to his ADP. Consumes one uniform for the
 * gaussian pair and — only when the wide component is on — one more to pick
 * the component, so a disabled lever leaves every seeded stream unchanged.
 */
export function sampleAdpNoise(rng: () => number, stdev: number, tail: SurvivalTail = DEFAULT_TAIL): number {
  let u = 0;
  while (u === 0) u = rng();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  const wide = tail.wideShare > 0 && rng() < tail.wideShare;
  return stdev * tail.tailScale * (wide ? tail.wideFactor : 1) * g;
}
