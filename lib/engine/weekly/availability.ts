// P(this player is active this week). Pure.
//
// The fallback numbers below are the season model's STATUS_MISS_PROB read as
// weekly play probabilities. They are a stopgap: Sleeper's weekly projection
// payload carries `player.injury_status`, and nflverse says whether he actually
// played, so scripts/calibrate-weekly.ts measures the real
// status → P(played) table and writes it to availability.byStatus. Until it
// runs, these apply.
import type { WeeklyModelParams } from "./model";

/** Derived from lib/engine/outcomeModel.ts STATUS_MISS_PROB. */
export const FALLBACK_PLAY_PROB: Record<string, number> = {
  Questionable: 0.75,
  Doubtful: 0.25,
  Out: 0.02,
  IR: 0,
  PUP: 0,
  Sus: 0,
  NA: 0,
};

/** A player with no designation still misses the odd week. */
const HEALTHY_PLAY_PROB = 0.97;

export function pPlay(
  status: string | null | undefined,
  isBye: boolean,
  p: WeeklyModelParams
): number {
  if (isBye) return 0;
  if (!status) return HEALTHY_PLAY_PROB;
  const fitted = p.availability.byStatus[status];
  if (typeof fitted === "number") return Math.min(1, Math.max(0, fitted));
  const fallback = FALLBACK_PLAY_PROB[status];
  // An unknown designation is far more likely to be a label we do not parse
  // than a hidden injury. Treating it as Out would bench healthy starters.
  return typeof fallback === "number" ? fallback : HEALTHY_PLAY_PROB;
}
