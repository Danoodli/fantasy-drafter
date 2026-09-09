// P(this player is active this week). Pure.
//
// The fallback numbers below are the season model's STATUS_MISS_PROB read as
// weekly play probabilities. They are a stopgap: Sleeper's weekly projection
// payload carries `player.injury_status`, and nflverse says whether he actually
// played, so scripts/calibrate-weekly.ts measures the real
// status → P(played) table and writes it to availability.byStatus. Until it
// runs, these apply.
import type { WeeklyModelParams } from "./model";
import { SEASON_LONG } from "../injuryFeed";

/**
 * Graded weekly designations only — a player carrying one of these is expected
 * to play some of the time. Season-long designations are NOT listed here: they
 * come from SEASON_LONG in lib/engine/injuryFeed.ts, which is the codebase's
 * single definition of "done for the year" and is already shared with
 * recommend.ts's INJURY_EXCLUDE. Copying a subset of it here is how COV and DNR
 * went missing in an earlier draft, silently returning a COVID-list player to
 * full strength.
 *
 * These three numbers are a documented stopgap, chosen as football judgment —
 * NOT derived from outcomeModel.ts's STATUS_MISS_PROB, which is a per-game miss
 * probability added to a fitted healthyMissProb and does not reduce to these
 * values. scripts/calibrate-weekly.ts measures the real status -> P(played)
 * table from history and writes it to availability.byStatus, which wins.
 */
export const FALLBACK_PLAY_PROB: Record<string, number> = {
  Questionable: 0.75,
  Doubtful: 0.25,
  Out: 0.02,
};

/** Used when availability.healthy is absent from the config. */
export const HEALTHY_PLAY_PROB = 0.97;

export function pPlay(
  status: string | null | undefined,
  isBye: boolean,
  p: WeeklyModelParams
): number {
  if (isBye) return 0;
  // A player with no designation still misses the odd week. Fitted from
  // null-status history by the calibration; the constant is the fallback.
  const healthy = p.availability.healthy ?? HEALTHY_PLAY_PROB;
  if (!status) return healthy;
  const fitted = p.availability.byStatus[status];
  // Clamp defensively: tests construct params by hand, bypassing loadWeeklyModel.
  if (typeof fitted === "number") return Math.min(1, Math.max(0, fitted));
  // Season-long designations are zero, from the shared set — never re-listed.
  if (SEASON_LONG.has(status)) return 0;
  const fallback = FALLBACK_PLAY_PROB[status];
  // An unknown designation is far more likely to be a label we do not parse
  // than a hidden injury. Treating it as Out would bench healthy starters.
  return typeof fallback === "number" ? fallback : healthy;
}
