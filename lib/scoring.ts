import type { ScoringFormat, ScoringSettings, StatLine } from "./types";

/** Preset scoring for the four supported board formats (Sleeper defaults). */
export const SCORING_PRESETS: Record<ScoringFormat, ScoringSettings> = {
  standard: base(0),
  "half-ppr": base(0.5),
  ppr: base(1),
  // 2QB is a roster format, not a scoring format; score it as PPR.
  "2qb": base(1),
};

function base(rec: number): ScoringSettings {
  return {
    pass_yd: 0.04,
    pass_td: 4,
    pass_int: -1,
    pass_2pt: 2,
    rush_yd: 0.1,
    rush_td: 6,
    rush_2pt: 2,
    rec,
    rec_yd: 0.1,
    rec_td: 6,
    rec_2pt: 2,
    fum_lost: -2,
  };
}

/** Apply league scoring settings to a raw projected stat line. */
export function scoreStatLine(stats: StatLine, s: ScoringSettings, isTE = false): number {
  const recPts = (stats.receptions ?? 0) * (s.rec + (isTE ? s.bonus_rec_te ?? 0 : 0));
  return (
    (stats.passYds ?? 0) * s.pass_yd +
    (stats.passTD ?? 0) * s.pass_td +
    (stats.passInt ?? 0) * s.pass_int +
    (stats.pass2pt ?? 0) * s.pass_2pt +
    (stats.rushYds ?? 0) * s.rush_yd +
    (stats.rushTD ?? 0) * s.rush_td +
    (stats.rush2pt ?? 0) * s.rush_2pt +
    recPts +
    (stats.recYds ?? 0) * s.rec_yd +
    (stats.recTD ?? 0) * s.rec_td +
    (stats.rec2pt ?? 0) * s.rec_2pt +
    (stats.fumblesLost ?? 0) * s.fum_lost +
    // PPFD — only Sleeper stat lines carry projected first downs
    (stats.rushFd ?? 0) * (s.rush_fd ?? 0) +
    (stats.recFd ?? 0) * (s.rec_fd ?? 0) +
    (stats.passFd ?? 0) * (s.pass_fd ?? 0)
  );
}

/**
 * Map a Sleeper league's scoring_settings object onto our ScoringSettings.
 * Missing keys fall back to the given preset.
 */
export function scoringFromSleeper(
  sleeper: Record<string, number>,
  fallback: ScoringSettings
): ScoringSettings {
  const pick = (key: string, def: number) =>
    typeof sleeper[key] === "number" ? sleeper[key] : def;
  return {
    pass_yd: pick("pass_yd", fallback.pass_yd),
    pass_td: pick("pass_td", fallback.pass_td),
    pass_int: pick("pass_int", fallback.pass_int),
    pass_2pt: pick("pass_2pt", fallback.pass_2pt),
    rush_yd: pick("rush_yd", fallback.rush_yd),
    rush_td: pick("rush_td", fallback.rush_td),
    rush_2pt: pick("rush_2pt", fallback.rush_2pt),
    rec: pick("rec", fallback.rec),
    rec_yd: pick("rec_yd", fallback.rec_yd),
    rec_td: pick("rec_td", fallback.rec_td),
    rec_2pt: pick("rec_2pt", fallback.rec_2pt),
    fum_lost: pick("fum_lost", fallback.fum_lost),
    bonus_rec_te: pick("bonus_rec_te", 0) || undefined,
    rush_fd: pick("rush_fd", 0) || undefined,
    rec_fd: pick("rec_fd", 0) || undefined,
    pass_fd: pick("pass_fd", 0) || undefined,
  };
}

/**
 * ESPN raw stat id → StatLine field. Verified against the live
 * kona_player_info payload (see handoff doc for the confirmed ids).
 */
export const ESPN_STAT_MAP: Record<string, keyof StatLine> = {
  "3": "passYds",
  "4": "passTD",
  "19": "pass2pt",
  "20": "passInt",
  "24": "rushYds",
  "25": "rushTD",
  "26": "rush2pt",
  "42": "recYds",
  "43": "recTD",
  "44": "rec2pt",
  "53": "receptions",
  "72": "fumblesLost",
};

export function statLineFromEspn(raw: Record<string, number>): StatLine {
  const out: StatLine = {};
  for (const [id, field] of Object.entries(ESPN_STAT_MAP)) {
    const v = raw[id];
    if (typeof v === "number" && v !== 0) out[field] = v;
  }
  return out;
}
