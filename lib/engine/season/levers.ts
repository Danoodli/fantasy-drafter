// Tuned numbers for the in-season cockpit, read from config/season.json and
// validated at import — a bad value fails here, with its name, not as a NaN
// three modules downstream. Same discipline as lib/engine/weekly/model.ts.
import seasonJson from "../../../config/season.json";

export interface SeasonLevers {
  /** A starter with pPlay at or below this is a forced swap. */
  forcedPlayThreshold: number;
  /** Smallest objective move worth listing as a swap. */
  minDeltaWin: number;
  /** 0 = rank by this week's delta P(win) only. See config/season.json. */
  riskFromPlayoffOdds: number;
  /** Projected points equivalent to a 100% swing in P(win) when blending. */
  pointsScale: number;
}

function num(raw: Record<string, unknown>, key: string, lo: number, hi: number, opts: { openLo?: boolean; openHi?: boolean } = {}): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`season.json: ${key} must be a finite number`);
  const aboveLo = opts.openLo ? v > lo : v >= lo;
  const belowHi = opts.openHi ? v < hi : v <= hi;
  if (!aboveLo || !belowHi) {
    throw new Error(`season.json: ${key} must be in ${opts.openLo ? "(" : "["}${lo}, ${hi}${opts.openHi ? ")" : "]"}, got ${v}`);
  }
  return v;
}

export function loadSeasonLevers(raw: unknown): SeasonLevers {
  if (!raw || typeof raw !== "object") throw new Error("season.json: expected an object");
  const r = raw as Record<string, unknown>;
  return {
    forcedPlayThreshold: num(r, "forcedPlayThreshold", 0, 1, { openHi: true }),
    minDeltaWin: num(r, "minDeltaWin", 0, 1, { openHi: true }),
    riskFromPlayoffOdds: num(r, "riskFromPlayoffOdds", 0, 1),
    pointsScale: num(r, "pointsScale", 0, Infinity, { openLo: true }),
  };
}

export const DEFAULT_SEASON_LEVERS: SeasonLevers = loadSeasonLevers(seasonJson);
