// nflverse weekly stats → our StatLine, plus K and DST points. Pure.
//
// nflverse (https://github.com/nflverse/nflverse-data) publishes realized
// per-player, per-week box scores with raw components, so a season can be
// re-scored under any league's settings. Verified: statLineFromNflverse scored
// with our PPR preset reproduces nflverse's own `fantasy_points_ppr` on every
// 2024 regular-season row once their two rule differences (INT −2, special
// teams TD +6) are accounted for.

import type { StatLine } from "../types";

export type Row = Record<string, string>;

/** "NA", "" and garbage read as 0 — nflverse leaves inapplicable stats blank. */
export function num(v: string | undefined): number {
  if (v == null || v === "" || v === "NA") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * One team code per franchise, in the app's ESPN-style spelling. nflverse
 * writes LA / JAX / LV (LV retroactively for Oakland); FFA writes LAR / JAC /
 * LVR / OAK. Free agents ("FA", "NA") become "" so they never join a team.
 */
export function canonicalTeam(code: string | undefined): string {
  const c = (code ?? "").toUpperCase().trim();
  const map: Record<string, string> = {
    LA: "LAR",
    STL: "LAR",
    JAC: "JAX",
    LVR: "LV",
    OAK: "LV",
    SD: "LAC",
    FA: "",
    NA: "",
  };
  return map[c] ?? c;
}

/** Raw components of one weekly (or season) nflverse player row. Zeros are omitted, like statLineFromEspn. */
export function statLineFromNflverse(r: Row): StatLine {
  const out: StatLine = {};
  const set = (k: keyof StatLine, v: number) => {
    if (v !== 0) out[k] = v;
  };
  set("passYds", num(r.passing_yards));
  set("passTD", num(r.passing_tds));
  set("passInt", num(r.passing_interceptions));
  set("pass2pt", num(r.passing_2pt_conversions));
  set("rushYds", num(r.rushing_yards));
  set("rushTD", num(r.rushing_tds));
  set("rush2pt", num(r.rushing_2pt_conversions));
  set("receptions", num(r.receptions));
  set("recYds", num(r.receiving_yards));
  set("recTD", num(r.receiving_tds));
  set("rec2pt", num(r.receiving_2pt_conversions));
  set("fumblesLost", num(r.sack_fumbles_lost) + num(r.rushing_fumbles_lost) + num(r.receiving_fumbles_lost));
  return out;
}

/** Sum stat lines component-wise (season total from weeks). */
export function addStatLines(lines: (StatLine | null)[]): StatLine {
  const out: StatLine = {};
  for (const l of lines) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l) as [keyof StatLine, number][]) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

/**
 * Kicker points, ESPN/Sleeper default: FG 0–39 = 3, 40–49 = 4, 50+ = 5,
 * PAT = 1, every miss −1. Matches the applied totals the ESPN snapshots carry.
 */
export function kickerPoints(r: Row): number {
  const made3 = num(r.fg_made_0_19) + num(r.fg_made_20_29) + num(r.fg_made_30_39);
  const made4 = num(r.fg_made_40_49);
  const made5 = num(r.fg_made_50_59) + num(r.fg_made_60_);
  const missed = num(r.fg_missed) + num(r.pat_missed);
  return made3 * 3 + made4 * 4 + made5 * 5 + num(r.pat_made) - missed;
}

export interface TeamDefenseWeek {
  sacks: number;
  interceptions: number;
  fumbleRecoveries: number;
  /** Defensive + special-teams touchdowns. */
  touchdowns: number;
  safeties: number;
  pointsAllowed: number;
}

/** Standard D/ST points-allowed brackets (ESPN default). */
export function pointsAllowedBracket(pa: number): number {
  if (pa <= 0) return 5;
  if (pa <= 6) return 4;
  if (pa <= 13) return 3;
  if (pa <= 17) return 1;
  if (pa <= 27) return 0;
  if (pa <= 34) return -1;
  if (pa <= 45) return -3;
  return -5;
}

/** D/ST points: sack 1, INT 2, fumble recovery 2, TD 6, safety 2, plus the points-allowed bracket. */
export function dstPoints(d: TeamDefenseWeek): number {
  return (
    d.sacks * 1 +
    d.interceptions * 2 +
    d.fumbleRecoveries * 2 +
    d.touchdowns * 6 +
    d.safeties * 2 +
    pointsAllowedBracket(d.pointsAllowed)
  );
}

/** Read one nflverse team-week row (defensive side) into the D/ST components. */
export function teamDefenseFromNflverse(r: Row, pointsAllowed: number): TeamDefenseWeek {
  return {
    sacks: num(r.def_sacks),
    interceptions: num(r.def_interceptions),
    fumbleRecoveries: num(r.fumble_recovery_opp),
    touchdowns: num(r.def_tds) + num(r.special_teams_tds),
    safeties: num(r.def_safeties),
    pointsAllowed,
  };
}

export interface Schedule {
  /** `${canonicalTeam}|${week}` → points the team allowed that week. */
  pointsAllowed: Map<string, number>;
  /** canonical team → its bye week (the regular-season week it has no game). */
  byes: Map<string, number>;
  /** Number of regular-season weeks that season (17 through 2020, 18 after). */
  weeks: number;
}

/** Regular-season schedule facts for one season from nflverse games.csv. */
export function scheduleFromGames(games: Row[], season: number): Schedule {
  const pointsAllowed = new Map<string, number>();
  const played = new Map<string, Set<number>>();
  let weeks = 0;
  for (const g of games) {
    if (num(g.season) !== season || g.game_type !== "REG") continue;
    const week = num(g.week);
    if (g.home_score === "" || g.away_score === "") continue; // unplayed
    weeks = Math.max(weeks, week);
    const home = canonicalTeam(g.home_team);
    const away = canonicalTeam(g.away_team);
    pointsAllowed.set(`${home}|${week}`, num(g.away_score));
    pointsAllowed.set(`${away}|${week}`, num(g.home_score));
    for (const t of [home, away]) {
      const s = played.get(t) ?? new Set<number>();
      s.add(week);
      played.set(t, s);
    }
  }
  const byes = new Map<string, number>();
  for (const [team, s] of played) {
    for (let w = 1; w <= weeks; w++) {
      if (!s.has(w)) {
        byes.set(team, w);
        break;
      }
    }
  }
  return { pointsAllowed, byes, weeks };
}
