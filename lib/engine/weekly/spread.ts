// How wide a player's week is. Pure.
//
// Sigma depends on projected VOLUME, not only on position. An 18-touch back is
// genuinely less volatile than a 4-target flier, and giving them the same shape
// is what makes most tools' floor/ceiling numbers useless. Fitted per position
// by scripts/calibrate-weekly.ts; delta = 0 recovers a flat per-position sigma.
import type { Position, StatLine } from "../../types";
import type { WeeklyModelParams } from "./model";

/** Fallbacks for a position the calibration has not fitted yet. */
const SIGMA_FALLBACK = 0.8;
const V0_FALLBACK = 8;
/** Volume can never be 0 in the sigma formula — it is a denominator. */
const MIN_VOLUME = 0.5;

/** Touches (or attempts) the projection implies. */
export function projectedVolume(pos: Position, stats: StatLine): number {
  switch (pos) {
    case "QB":
      // Attempts are not in the projected stat line; passing yards / 7.5 is a
      // stable proxy and the ratio is all sigma needs.
      return Math.max(MIN_VOLUME, (stats.passYds ?? 0) / 7.5 + (stats.rushYds ?? 0) / 5);
    case "RB":
      return Math.max(MIN_VOLUME, (stats.rushYds ?? 0) / 4.3 + (stats.receptions ?? 0));
    case "WR":
    case "TE":
      // Receptions understate volume; targets are the real driver, and catch
      // rate is roughly 0.65 league-wide.
      return Math.max(MIN_VOLUME, (stats.receptions ?? 0) / 0.65);
    default:
      // K and DST have no touch count. Their sigma is flat by construction.
      return Math.max(MIN_VOLUME, 1);
  }
}

export function weeklySigma(pos: Position, volume: number, p: WeeklyModelParams): number {
  const sigma0 = p.sigma.sigma0[pos] ?? SIGMA_FALLBACK;
  if (!p.sigma.delta) return sigma0;
  const v0 = p.sigma.v0[pos] ?? V0_FALLBACK;
  const v = Math.max(MIN_VOLUME, volume);
  const scaled = sigma0 * Math.pow(v0 / v, p.sigma.delta);
  // Clamp: a 0.1-volume player must not get a sigma of 4 and dominate every
  // ceiling ranking on the strength of arithmetic.
  return Math.min(2.5, Math.max(0.15, scaled));
}

/** Inverse normal CDF, Acklam's rational approximation (|error| < 1.15e-9). */
function probit(q: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (q <= 0) return -Infinity;
  if (q >= 1) return Infinity;
  if (q < pLow) {
    const s = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * s + c[1]) * s + c[2]) * s + c[3]) * s + c[4]) * s + c[5]) / ((((d[0] * s + d[1]) * s + d[2]) * s + d[3]) * s + 1);
  }
  if (q <= 1 - pLow) {
    const s = q - 0.5;
    const r = s * s;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * s / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const s = Math.sqrt(-2 * Math.log(1 - q));
  return -(((((c[0] * s + c[1]) * s + c[2]) * s + c[3]) * s + c[4]) * s + c[5]) / ((((d[0] * s + d[1]) * s + d[2]) * s + d[3]) * s + 1);
}

/**
 * Quantile of a lognormal with the given ARITHMETIC mean and log-sigma.
 * mu = log(mean) − sigma²/2 so that E[X] = mean exactly, which is what keeps
 * the quantiles consistent with the projection they came from.
 */
export function lognormalQuantile(mean: number, sigma: number, q: number): number {
  if (!(mean > 0)) return 0;
  const mu = Math.log(mean) - (sigma * sigma) / 2;
  return Math.exp(mu + sigma * probit(q));
}
