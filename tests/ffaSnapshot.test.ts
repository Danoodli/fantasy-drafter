// FFA + nflverse season snapshots: the pure pieces (scoring maps, receptions
// recovery, ADP synthesis, schedule facts) and the integrity of any committed
// data/raw/seasons/ffa/<year>.json, mirroring historicalBoard.test.ts.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/etl/csv";
import { buildHistoricalBoard, type CrossRow } from "../lib/etl/historicalBoard";
import type { SeasonSnapshot } from "../lib/etl/seasonSnapshot";
import {
  adpStdevFor,
  buildFfaSnapshot,
  FFA_POINTS_SCORING,
  ffaAdpTable,
  ffaProjectedLine,
  YARDS_PER_RECEPTION,
} from "../lib/etl/ffaSnapshot";
import {
  type Row,
  canonicalTeam,
  dstPoints,
  kickerPoints,
  pointsAllowedBracket,
  scheduleFromGames,
  statLineFromNflverse,
  addStatLines,
} from "../lib/etl/nflverse";
import { SCORING_PRESETS, scoreStatLine } from "../lib/scoring";
import type { LeagueConfig } from "../lib/types";

describe("nflverse mapping", () => {
  it("maps weekly components onto StatLine and sums fumbles lost from all three sources", () => {
    const line = statLineFromNflverse({
      passing_yards: "250", passing_tds: "2", passing_interceptions: "1", passing_2pt_conversions: "0",
      rushing_yards: "30", rushing_tds: "0", receptions: "", receiving_yards: "NA",
      sack_fumbles_lost: "1", rushing_fumbles_lost: "1", receiving_fumbles_lost: "0",
    });
    expect(line).toEqual({ passYds: 250, passTD: 2, passInt: 1, rushYds: 30, fumblesLost: 2 });
    // our PPR preset: 10 + 8 - 1 + 3 - 4
    expect(scoreStatLine(line, SCORING_PRESETS.ppr)).toBeCloseTo(16, 5);
  });

  it("adds stat lines component-wise", () => {
    expect(addStatLines([{ recYds: 50, receptions: 4 }, null, { recYds: 25, recTD: 1 }])).toEqual({ recYds: 75, receptions: 4, recTD: 1 });
  });

  it("scores kickers 3/4/5 with −1 misses", () => {
    expect(kickerPoints({ fg_made_0_19: "0", fg_made_20_29: "1", fg_made_30_39: "1", fg_made_40_49: "1", fg_made_50_59: "1", fg_made_60_: "0", fg_missed: "1", pat_made: "3", pat_missed: "1" })).toBe(3 + 3 + 4 + 5 + 3 - 2);
  });

  it("uses standard D/ST brackets", () => {
    expect(pointsAllowedBracket(0)).toBe(5);
    expect(pointsAllowedBracket(13)).toBe(3);
    expect(pointsAllowedBracket(21)).toBe(0);
    expect(pointsAllowedBracket(50)).toBe(-5);
    expect(dstPoints({ sacks: 3, interceptions: 1, fumbleRecoveries: 1, touchdowns: 1, safeties: 0, pointsAllowed: 10 })).toBe(3 + 2 + 2 + 6 + 3);
  });

  it("canonicalizes team codes from both publishers", () => {
    expect(["LA", "LAR", "STL"].map(canonicalTeam)).toEqual(["LAR", "LAR", "LAR"]);
    expect(["JAC", "JAX"].map(canonicalTeam)).toEqual(["JAX", "JAX"]);
    expect(["OAK", "LVR", "LV"].map(canonicalTeam)).toEqual(["LV", "LV", "LV"]);
    expect(canonicalTeam("FA")).toBe("");
  });

  it("derives points allowed, byes and season length from games.csv", () => {
    const games = [
      { season: "2018", game_type: "REG", week: "1", home_team: "LA", away_team: "OAK", home_score: "33", away_score: "13" },
      { season: "2018", game_type: "REG", week: "2", home_team: "OAK", away_team: "DEN", home_score: "19", away_score: "20" },
      { season: "2018", game_type: "REG", week: "3", home_team: "LA", away_team: "DEN", home_score: "35", away_score: "23" },
      { season: "2018", game_type: "POST", week: "19", home_team: "LA", away_team: "DAL", home_score: "30", away_score: "22" },
      { season: "2019", game_type: "REG", week: "1", home_team: "LA", away_team: "CAR", home_score: "30", away_score: "27" },
    ];
    const s = scheduleFromGames(games, 2018);
    expect(s.weeks).toBe(3);
    expect(s.pointsAllowed.get("LAR|1")).toBe(13);
    expect(s.pointsAllowed.get("LV|1")).toBe(33);
    expect(s.byes.get("LAR")).toBe(2);
    expect(s.byes.get("LV")).toBe(3);
    expect(s.byes.get("DEN")).toBe(1);
  });
});

describe("FFA projected line", () => {
  const raw = { pass_yds: "NA", pass_tds: "NA", pass_int: "NA", rush_yds: "1000", rush_tds: "8", rec: "50", rec_yds: "400", rec_tds: "3", fumbles_lost: "2", two_pts: "NA" };

  it("uses the receptions column when present", () => {
    const { line, recSource } = ffaProjectedLine(raw, { year: 2024, pos: "RB", points: 999 });
    expect(recSource).toBe("column");
    expect(line).toEqual({ rushYds: 1000, rushTD: 8, receptions: 50, recYds: 400, recTD: 3, fumblesLost: 2 });
  });

  it("backs receptions out of FFA's half-PPR points when the column is missing", () => {
    const { rec: _r, ...noRec } = raw;
    void _r;
    // FFA 2023 scoring: rec .5, INT −1, fum −2 → 100 + 48 + 40 + 18 − 4 = 202 without receptions; +25 for 50 receptions
    const { line, recSource } = ffaProjectedLine(noRec, { year: 2023, pos: "RB", points: 227 });
    expect(recSource).toBe("backout");
    expect(line.receptions).toBeCloseTo(50, 1);
  });

  it("falls back to the yards-per-reception prior for a standard-scored export", () => {
    const { rec: _r, ...noRec } = raw;
    void _r;
    const { line, recSource } = ffaProjectedLine(noRec, { year: 2018, pos: "WR", points: 150 });
    expect(recSource).toBe("prior");
    expect(line.receptions).toBeCloseTo(400 / YARDS_PER_RECEPTION.WR, 2);
  });

  it("never invents receptions for a pure passer", () => {
    const qb = { pass_yds: "4000", pass_tds: "30", pass_int: "10", rush_yds: "100", rush_tds: "1", rec_yds: "NA", rec_tds: "NA", fumbles_lost: "3" };
    const { line, recSource } = ffaProjectedLine(qb, { year: 2018, pos: "QB", points: 300 });
    expect(recSource).toBe("none");
    expect(line.receptions).toBeUndefined();
  });

  it("has a scoring entry for every exported year", () => {
    for (const y of [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]) expect(FFA_POINTS_SCORING[y]).toBeDefined();
  });
});

describe("FFA ADP table", () => {
  it("looks like an FFC payload: sorted, PK/DEF codes, spread growing with ADP", () => {
    const t = ffaAdpTable([
      { name: "B", pos: "K", team: "BAL", adp: 150, bye: 14 },
      { name: "A", pos: "RB", team: "SF", adp: 1.4, bye: 9 },
      { name: "C", pos: "DST", team: "DAL", adp: 120, bye: 7 },
    ]);
    expect(t.players.map((p) => p.name)).toEqual(["A", "C", "B"]);
    expect(t.players.map((p) => p.position)).toEqual(["RB", "DEF", "PK"]);
    expect(t.players[0].high).toBe(1);
    expect(t.players[2].stdev).toBeGreaterThan(t.players[0].stdev);
    expect(adpStdevFor(1)).toBe(1);
    expect(adpStdevFor(120)).toBeCloseTo(12, 0);
    expect(t.players[0].adp_formatted).toBe("1.01");
  });
});

describe("buildFfaSnapshot (synthetic season)", () => {
  // SF/DAL play weeks 1–2 (bye 3); KC/BUF play weeks 1 and 3 (bye 2).
  const games = [
    { season: "2023", game_type: "REG", week: "1", home_team: "SF", away_team: "DAL", home_score: "24", away_score: "17" },
    { season: "2023", game_type: "REG", week: "1", home_team: "KC", away_team: "BUF", home_score: "27", away_score: "20" },
    { season: "2023", game_type: "REG", week: "2", home_team: "SF", away_team: "DAL", home_score: "20", away_score: "10" },
    { season: "2023", game_type: "REG", week: "3", home_team: "KC", away_team: "BUF", home_score: "27", away_score: "20" },
  ];
  const inputs = {
    year: 2023 as number,
    projections: [
      { player: "Christian McCaffrey", position: "RB", team: "SF", bye_week: "9", points: "300", adp: "1.5" },
      { player: "Christian McCaffrey", position: "RB", team: "CAR", bye_week: "9", points: "300", adp: "1.5" }, // 2019-style duplicate
      { player: "Travis Kelce", position: "TE", team: "KC", bye_week: "10", points: "200", adp: "12" },
      { player: "Harrison Butker", position: "K", team: "KC", bye_week: "10", points: "140", adp: "NA" },
      { player: "49ers", position: "DST", team: "SF", bye_week: "9", points: "120", adp: "100" },
      { player: "Some Linebacker", position: "LB", team: "SF", bye_week: "9", points: "90", adp: "NA" },
      { player: "Andrew Luck", position: "QB", team: "IND", bye_week: "11", points: "280", adp: "67" },
    ],
    rawStats: [
      { player: "Christian McCaffrey", position: "RB", team: "SF", id: "13130", rush_yds: "1200", rush_tds: "10", rec_yds: "500", rec_tds: "4", fumbles_lost: "1" },
      { player: "Travis Kelce", position: "TE", team: "KC", id: "11244", rec_yds: "1000", rec_tds: "8" },
      { player: "Deep Sleeper", position: "WR", team: "DAL", id: "99999", rec_yds: "300", rec_tds: "1" },
      { player: "Andrew Luck", position: "QB", team: "IND", id: "10695", pass_yds: "4000", pass_tds: "30", pass_int: "10" },
    ] as Row[],
    weekly: [
      { season_type: "REG", week: "1", player_id: "00-cmc", player_display_name: "Christian McCaffrey", position: "RB", team: "SF", rushing_yards: "100", rushing_tds: "1", receptions: "5", receiving_yards: "40" },
      { season_type: "REG", week: "2", player_id: "00-cmc", player_display_name: "Christian McCaffrey", position: "RB", team: "SF", rushing_yards: "80", receptions: "2", receiving_yards: "10", rushing_fumbles_lost: "1" },
      { season_type: "POST", week: "19", player_id: "00-cmc", player_display_name: "Christian McCaffrey", position: "RB", team: "SF", rushing_yards: "999" },
      { season_type: "REG", week: "1", player_id: "00-kelce", player_display_name: "Travis Kelce", position: "TE", team: "KC", receptions: "7", receiving_yards: "70", receiving_tds: "1" },
      { season_type: "REG", week: "1", player_id: "00-butker", player_display_name: "Harrison Butker", position: "K", team: "KC", fg_made_30_39: "2", pat_made: "3", fg_missed: "0", pat_missed: "0" },
      { season_type: "REG", week: "2", player_id: "00-sleeper", player_display_name: "Deep Sleeper", position: "WR", team: "DAL", receptions: "3", receiving_yards: "45" },
    ] as Row[],
    teamWeekly: [
      { season_type: "REG", week: "1", team: "SF", def_sacks: "3", def_interceptions: "1", fumble_recovery_opp: "0", def_tds: "0", special_teams_tds: "0", def_safeties: "0" },
      { season_type: "REG", week: "2", team: "SF", def_sacks: "2", def_interceptions: "0", fumble_recovery_opp: "1", def_tds: "1", special_teams_tds: "0", def_safeties: "0" },
    ],
    games,
    cross: [{ mfl_id: "13130", gsis_id: "00-cmc" }],
  };
  const { snapshot, report } = buildFfaSnapshot(inputs);
  const by = (name: string) => snapshot.espn.find((p) => p.name.startsWith(name))!;

  it("dedupes FFA's duplicate rows and skips IDP", () => {
    expect(snapshot.espn.filter((p) => p.name === "Christian McCaffrey")).toHaveLength(1);
    expect(snapshot.espn.find((p) => p.name === "Some Linebacker")).toBeUndefined();
    expect(snapshot.source).toBe("ffa");
  });

  it("scores the projection from raw components, not FFA's points column", () => {
    const cmc = by("Christian McCaffrey");
    expect(cmc.proj).toMatchObject({ rushYds: 1200, rushTD: 10, recYds: 500, recTD: 4, fumblesLost: 1 });
    // 2023 export has no receptions column → backed out of 300 half-PPR points
    expect(cmc.proj!.receptions).toBeCloseTo((300 - (120 + 60 + 50 + 24 - 2)) / 0.5, 1);
    expect(report.receptions.backout).toBeGreaterThan(0);
  });

  it("joins realized weekly lines by mfl→gsis id, then by name", () => {
    const cmc = by("Christian McCaffrey");
    expect(cmc.espnId).toBe("00-cmc");
    expect(cmc.weekly[0]).toEqual({ rushYds: 100, rushTD: 1, receptions: 5, recYds: 40 });
    expect(cmc.weekly[1]).toEqual({ rushYds: 80, receptions: 2, recYds: 10, fumblesLost: 1 });
    expect(cmc.weekly[2]).toBeNull(); // bye
    expect(cmc.weekly[18]).toBeUndefined(); // postseason ignored, 18-week array
    expect(cmc.actual).toEqual({ rushYds: 180, rushTD: 1, receptions: 7, recYds: 50, fumblesLost: 1 });
    expect(by("Travis Kelce").espnId).toBe("00-kelce");
    expect(report.matchedById).toBe(1);
    expect(report.matchedByName).toBe(3); // Kelce, Butker, Deep Sleeper
  });

  it("keeps a projected player who never played, scored 0, and reports him", () => {
    const luck = by("Andrew Luck");
    expect(luck.proj).toMatchObject({ passYds: 4000 });
    expect(luck.actual).toEqual({});
    expect(luck.weekly.every((w) => w == null)).toBe(true);
    expect(report.noStatsDrafted).toEqual(["Andrew Luck (QB, ADP 67)"]);
  });

  it("scores kickers and D/ST as applied weekly points", () => {
    const k = by("Harrison Butker");
    expect(k.weeklyApplied[0]).toBe(9);
    expect(k.actualApplied).toBe(9);
    expect(k.projApplied).toBe(140);
    const dst = by("49ers");
    expect(dst.pos).toBe("DST");
    expect(dst.team).toBe("SF");
    expect(dst.weeklyApplied[0]).toBe(3 + 2 + pointsAllowedBracket(17));
    expect(dst.weeklyApplied[1]).toBe(2 + 2 + 6 + pointsAllowedBracket(10));
  });

  it("builds an ADP spine with a tail for un-ADP'd kickers and the team's real bye", () => {
    const adp = snapshot.ffc.ppr!.players;
    expect(adp.map((p) => p.name)).toEqual(["Christian McCaffrey", "Travis Kelce", "Andrew Luck", "49ers D/ST", "Harrison Butker"]);
    expect(adp[0].bye).toBe(3); // from games.csv, not FFA's bye_week (9)
    expect(adp.find((p) => p.name === "Harrison Butker")!.adp).toBeGreaterThan(180);
    expect(snapshot.ffc.standard).toBe(snapshot.ffc.ppr);
  });

  it("puts raw-only players in the pool as deep-pool candidates (no ADP, PPR-scored projection)", () => {
    const s = by("Deep Sleeper");
    expect(s.adpEspn).toBeNull();
    expect(s.projApplied).toBeCloseTo(300 * 0.1 + 6 + (300 / YARDS_PER_RECEPTION.WR) * 1, 0);
  });
});

// ---- integrity of committed FFA snapshots ----------------------------------
const FFA_DIR = join(process.cwd(), "data/raw/seasons/ffa");
const years = existsSync(FFA_DIR)
  ? readdirSync(FFA_DIR).filter((f) => /^\d{4}\.json$/.test(f)).map((f) => Number(f.slice(0, 4))).sort()
  : [];

describe.skipIf(years.length === 0).each(years)("FFA season snapshot %i", (year) => {
  const cross = parseCsv(readFileSync(join(process.cwd(), "data/raw/db_playerids.csv"), "utf8")) as unknown as CrossRow[];
  const config: LeagueConfig = {
    platform: "manual", leagueId: "", draftId: "", myDraftSlot: null, teams: 12, rounds: 15,
    scoring: "ppr", leagueType: "redraft",
    rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
    flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
  };
  const snapshot: SeasonSnapshot = JSON.parse(readFileSync(join(FFA_DIR, `${year}.json`), "utf8"));
  const hb = buildHistoricalBoard(snapshot, cross, "ppr", config);

  it("is tagged as an FFA snapshot for its year", () => {
    expect(snapshot.source).toBe("ffa");
    expect(snapshot.year).toBe(year);
  });

  it("matches every ADP'd player in the first 12 rounds to a projection row", () => {
    const early = hb.board.filter((p) => !p.deepPool && p.adp <= 144 && !hb.realized.has(p.id));
    expect(early.map((p) => `${p.name} (${p.pos}, ADP ${p.adp})`)).toEqual([]);
  });

  it("carries a genuine projection for most of the board", () => {
    const real = hb.board.filter((p) => !p.projImputed && p.projPoints > 0).length;
    expect(real / hb.board.length).toBeGreaterThan(0.8);
  });

  it("has weekly actuals for the players who played", () => {
    const withWeeks = [...hb.realized.values()].filter((r) => r.weekly.some((w) => w != null)).length;
    expect(withWeeks).toBeGreaterThan(300);
    // Almost every top-60 pick played at least one game; the exceptions are real (holdouts, retirements).
    const top = hb.board.filter((p) => p.adp <= 60 && p.pos !== "DST");
    const played = top.filter((p) => hb.realized.get(p.id)?.weekly.some((w) => (w ?? 0) > 0));
    expect(played.length).toBeGreaterThanOrEqual(top.length - 2);
  });

  it("is deep enough for a 20-round best ball", () => {
    const skill = hb.board.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.pos)).length;
    expect(skill).toBeGreaterThanOrEqual(240);
  });

  it("has a D/ST line for every team", () => {
    const dst = hb.board.filter((p) => p.pos === "DST" && (hb.realized.get(p.id)?.season ?? 0) > 0);
    expect(dst.length).toBeGreaterThanOrEqual(30);
  });
});
