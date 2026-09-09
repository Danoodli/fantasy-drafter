// Vegas game environment → per-position multipliers. Pure.
//
// The market's line is the single best free predictor of how many points a
// game will produce. Implied team points come straight out of it: half the
// total, shifted by half the spread.
//
// IMPORTANT: these coefficients are fitted on the RESIDUAL against the market
// projection (see scripts/calibrate-weekly.ts), never on actual points.
// Sleeper's projection already embeds some of this signal; fitting on actuals
// would count it twice and make the model worse than the number it is built on.
import type { Position } from "../../types";
import type { WeeklyModelParams } from "./model";

/** Half the total, shifted by half the spread. ownSpread negative = favored. */
export function impliedTeamPoints(total: number, ownSpread: number): number {
  return total / 2 - ownSpread / 2;
}

/**
 * Scale by how much scoring this team's game is expected to produce.
 *
 * DST inverts: a defense's fantasy points come from the OPPONENT failing, so
 * DST reads `itpOpp` and carries a negative alpha. Getting this backwards
 * would rank the worst defensive matchups as the best, so it is asserted in
 * tests/weeklyEnvironment.test.ts rather than left to the fit.
 */
export function envMult(
  pos: Position,
  itpOwn: number,
  itpOpp: number,
  p: WeeklyModelParams
): number {
  const alpha = p.environment.alpha[pos];
  if (!alpha) return 1;
  const avg = p.environment.leagueAvgItp;
  if (!(avg > 0)) return 1;
  const itp = pos === "DST" ? itpOpp : itpOwn;
  const ratio = Math.max(0.2, itp / avg); // a shut-out implied total is still not a zero
  return Math.pow(ratio, alpha);
}

/**
 * Game script. Favorites run out the clock; underdogs throw. Expressed per
 * seven points of spread so the coefficient reads as "per touchdown of spread".
 * Floored well above zero: a 30-point spread should not zero out a running back.
 */
export function scriptMult(pos: Position, ownSpread: number, p: WeeklyModelParams): number {
  const beta = p.environment.beta[pos];
  if (!beta) return 1;
  // Expressed on ownSpread DIRECTLY (negative = favored), matching the spec and
  // the calibration script. Do not rewrite this as `1 - beta * favoredness`:
  // that is algebraically identical but the double negative is what made an
  // earlier draft of this plan invert beta in three places at once.
  //
  // So with beta.RB < 0 a favorite's backs go UP (favorites run out the clock),
  // and with beta.WR > 0 an underdog's receivers go UP (underdogs throw).
  // Floor at 0.4: a 30-point spread should move a back's projection, not erase it.
  return Math.max(0.4, 1 + beta * (ownSpread / 7));
}
