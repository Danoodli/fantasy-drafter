// Stat-line scaling and DraftKings threshold bonuses. Pure.
//
// Why this exists: DK pays +3 for 100 rushing yards, 100 receiving yards and
// 300 passing yards. The expected value of a threshold bonus cannot be derived
// from a mean projection — a 92-yard mean with wide spread collects more bonus
// than a 98-yard mean with narrow spread. So the sampler draws a performance
// multiplier and applies it to the STAT LINE, then scores the scaled line.
//
// Approximation, stated plainly: yards and touchdowns are assumed to scale
// together with one multiplier. Real games decouple them. This is gated —
// simulated bonus frequency must match historical bonus frequency per
// position (see scripts/backtest-weekly.ts, gate 5).
import type { StatLine } from "../../types";

const VOLUME_FIELDS: (keyof StatLine)[] = [
  "passYds", "passTD", "passInt", "pass2pt",
  "rushYds", "rushTD", "rush2pt",
  "receptions", "recYds", "recTD", "rec2pt",
  "fumblesLost", "rushFd", "recFd", "passFd",
];

/**
 * @param mult MUST be >= 0. A negative multiplier would flip the sign of every
 *   volume field, including the penalty fields (`fumblesLost`, `passInt`), and
 *   produce a stat line that scores backwards. The sampler always passes a
 *   lognormal draw, which is strictly positive.
 */
export function scaleStatLine(stats: StatLine, mult: number): StatLine {
  const out: StatLine = {};
  for (const f of VOLUME_FIELDS) {
    const v = stats[f];
    if (typeof v === "number" && v !== 0) {
      const scaled = v * mult;
      if (scaled !== 0) out[f] = scaled;
    }
  }
  return out;
}

export const DK_BONUS_THRESHOLDS = {
  passYds: 300,
  rushYds: 100,
  recYds: 100,
} as const;

/** DK's flat +3 per threshold cleared. They stack. */
export function dkBonusPoints(stats: StatLine): number {
  let bonus = 0;
  if ((stats.passYds ?? 0) >= DK_BONUS_THRESHOLDS.passYds) bonus += 3;
  if ((stats.rushYds ?? 0) >= DK_BONUS_THRESHOLDS.rushYds) bonus += 3;
  if ((stats.recYds ?? 0) >= DK_BONUS_THRESHOLDS.recYds) bonus += 3;
  return bonus;
}
