// Build a season snapshot from FantasyFootballAnalytics (FFA) draft-day
// projections + nflverse realized weekly stats, in the exact shape the ESPN
// snapshots use — so `pnpm backtest:season <year> --source=ffa` runs the
// unchanged harness on 2018+ seasons ESPN has purged.
//
// Pure: parsed CSV rows in, snapshot out. I/O (reading the hand-exported CSVs,
// fetching nflverse) lives in scripts/build-ffa-snapshot.ts.
//
// What each FFA export is (verified against the data, 2026-09-07):
//   projections_<year>_wk0.csv — one row per player: aggregated preseason
//     `points`, ADP, bye, sd/floor/ceiling. `points` is NOT scored the same way
//     every year (standard in 2018/20/21/25, half-PPR in 2022/23/24), so it is
//     never used as the projection. See FFA_POINTS_SCORING.
//   raw_stats_<year>_wk0.csv — the same preseason projection as raw stat
//     components (weighted average across FFA's sources). Despite the folder
//     name these are NOT actuals (2024 McCaffrey: 1300 projected rush yards vs
//     202 real). They are the projection we score under the league's settings,
//     exactly as the ESPN path scores ESPN's raw projected line.
//   Three exports (2018, 2022, 2023) lack a receptions column; see
//   ffaProjectedLine for how receptions are recovered.

import { SEASON_WEEKS, type SeasonPlayer } from "./espn";
import type { FfcPlayer } from "./fetchers";
import { looseName, mergeName } from "./names";
import {
  addStatLines,
  canonicalTeam,
  dstPoints,
  kickerPoints,
  num,
  scheduleFromGames,
  statLineFromNflverse,
  teamDefenseFromNflverse,
  type Row,
  type Schedule,
} from "./nflverse";
import type { FfcSnapshot, SeasonSnapshot } from "./seasonSnapshot";
import { SCORING_PRESETS, scoreStatLine } from "../scoring";
import type { Position, ScoringFormat, StatLine } from "../types";

const POS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];
const SKILL: Position[] = ["QB", "RB", "WR", "TE"];
const FORMATS: ScoringFormat[] = ["standard", "half-ppr", "ppr", "2qb"];

/**
 * How FFA scored the `points` column in each hand-exported file, fitted by
 * least squares on the raw components (fit MAE < 0.5 pts in every year that
 * carries a receptions column). Used ONLY to back out projected receptions in
 * the exports that omit them.
 */
export const FFA_POINTS_SCORING: Record<number, { rec: number; int: number; fum: number }> = {
  2018: { rec: 0, int: -3, fum: -3 },
  2019: { rec: 0, int: -3, fum: -3 },
  2020: { rec: 0, int: -3, fum: -3 },
  2021: { rec: 0, int: -3, fum: -3 },
  2022: { rec: 0.5, int: -1, fum: -2 },
  2023: { rec: 0.5, int: -1, fum: -2 },
  2024: { rec: 0.5, int: -1, fum: -2 },
  2025: { rec: 0, int: -3, fum: -3 },
};

/**
 * Projected yards per reception by position, medians of FFA's own projections
 * in the years that carry receptions (2019–2021, 2024–2025). Last-resort
 * receptions estimate; applying it to a year that has the column reproduces
 * receptions within 3.1 on average (p90 8.2) — i.e. ~3 PPR points per player.
 */
export const YARDS_PER_RECEPTION: Record<string, number> = { RB: 7.6, WR: 12.95, TE: 10.5, QB: 8 };

export type ReceptionSource = "column" | "backout" | "prior" | "none";

/** Score the parts of a projected line that are not receptions, under FFA's own weights for that export. */
function ffaPointsWithoutReceptions(line: StatLine, w: { int: number; fum: number }): number {
  return (
    (line.passYds ?? 0) * 0.04 +
    (line.passTD ?? 0) * 4 +
    (line.passInt ?? 0) * w.int +
    (line.rushYds ?? 0) * 0.1 +
    (line.rushTD ?? 0) * 6 +
    (line.recYds ?? 0) * 0.1 +
    (line.recTD ?? 0) * 6 +
    (line.fumblesLost ?? 0) * w.fum +
    (line.rush2pt ?? 0) * 2
  );
}

/**
 * A raw FFA projection row → StatLine. Receptions come from the `rec` column
 * when the export has one; otherwise they are backed out of FFA's own `points`
 * when that export scored receptions (2022/2023: half-PPR), and otherwise
 * estimated from projected receiving yards at the position's yards/reception.
 */
export function ffaProjectedLine(
  raw: Row,
  opts: { year: number; pos: Position; points: number | null }
): { line: StatLine; recSource: ReceptionSource } {
  const line: StatLine = {};
  const set = (k: keyof StatLine, v: number) => {
    if (v !== 0 && Number.isFinite(v)) line[k] = Math.round(v * 100) / 100;
  };
  set("passYds", num(raw.pass_yds));
  set("passTD", num(raw.pass_tds));
  set("passInt", num(raw.pass_int));
  set("rushYds", num(raw.rush_yds));
  set("rushTD", num(raw.rush_tds));
  set("recYds", num(raw.rec_yds));
  set("recTD", num(raw.rec_tds));
  set("fumblesLost", num(raw.fumbles_lost));
  set("rush2pt", num(raw.two_pts));

  let recSource: ReceptionSource = "none";
  const receiver = opts.pos === "RB" || opts.pos === "WR" || opts.pos === "TE" || (line.recYds ?? 0) > 0;
  if (raw.rec != null && raw.rec !== "" && raw.rec !== "NA") {
    set("receptions", num(raw.rec));
    recSource = "column";
  } else if (receiver) {
    const w = FFA_POINTS_SCORING[opts.year];
    if (w && w.rec > 0 && opts.points != null) {
      set("receptions", Math.max(0, (opts.points - ffaPointsWithoutReceptions(line, w)) / w.rec));
      recSource = "backout";
    } else if ((line.recYds ?? 0) > 0) {
      set("receptions", (line.recYds ?? 0) / (YARDS_PER_RECEPTION[opts.pos] ?? 10));
      recSource = "prior";
    }
  }
  return { line, recSource };
}

/** FFC-style ADP spread as a function of ADP, fitted on the 2024 FFC snapshot (stdev ≈ 0.096·adp + 0.45). */
export function adpStdevFor(adp: number): number {
  return Math.max(1, Math.round((0.096 * adp + 0.45) * 10) / 10);
}

export interface FfaAdpRow {
  name: string;
  pos: Position;
  team: string;
  adp: number;
  bye: number | null;
}

/**
 * FFA's ADP column as an FFC-shaped table so the historical board builder can
 * use it as the draft spine. high/low are ±2.5σ like FFC's observed extremes.
 */
export function ffaAdpTable(rows: FfaAdpRow[], teams = 12, rounds = 15): FfcSnapshot {
  const players: FfcPlayer[] = rows
    .slice()
    .sort((a, b) => a.adp - b.adp)
    .map((r, i) => {
      const stdev = adpStdevFor(r.adp);
      return {
        player_id: i + 1,
        name: r.name,
        position: r.pos === "K" ? "PK" : r.pos === "DST" ? "DEF" : r.pos,
        team: r.team,
        adp: Math.round(r.adp * 10) / 10,
        adp_formatted: `${Math.floor((r.adp - 1) / teams) + 1}.${String(Math.round(((r.adp - 1) % teams) + 1)).padStart(2, "0")}`,
        high: Math.max(1, Math.round(r.adp - 2.5 * stdev)),
        low: Math.round(r.adp + 2.5 * stdev),
        stdev,
        bye: r.bye ?? 0,
        times_drafted: 0,
      };
    });
  return { meta: { teams, rounds, total_drafts: 0, start_date: "", end_date: "" }, players };
}

export interface FfaInputs {
  year: number;
  /** projections_<year>_wk0.csv */
  projections: Row[];
  /** raw_stats_<year>_wk0.csv (projected components) */
  rawStats: Row[];
  /** nflverse stats_player_week_<year>.csv */
  weekly: Row[];
  /** nflverse stats_team_week_<year>.csv */
  teamWeekly: Row[];
  /** nflverse games.csv (any seasons; filtered) */
  games: Row[];
  /** db_playerids.csv — only mfl_id / gsis_id are used */
  cross: { mfl_id: string; gsis_id: string }[];
  fetchedAt?: string;
}

export interface FfaBuildReport {
  year: number;
  weeks: number;
  players: number;
  byPos: Record<Position, number>;
  withAdp: number;
  matchedById: number;
  matchedByName: number;
  /** Projected players with no NFL line all season — scored 0 (holdouts, retirements, suspensions, season-long IR). */
  noStats: string[];
  /** Same, restricted to players with an ADP inside the first 15 rounds — the ones that matter. */
  noStatsDrafted: string[];
  /** Projection rows with no raw-component row: projection kept as FFA's points only (imputed by the board). */
  noComponents: string[];
  receptions: Record<ReceptionSource, number>;
  ambiguousNames: string[];
}

interface FfaPlayer {
  name: string;
  pos: Position;
  team: string;
  merge: string;
  proj: Row | null;
  raw: Row | null;
}

function pos(p: string): Position | null {
  const q = p === "PK" ? "K" : p === "DEF" || p === "D/ST" ? "DST" : p;
  return (POS as string[]).includes(q) ? (q as Position) : null;
}

function nflPos(p: string): Position | null {
  // nflverse lists fullbacks/halfbacks separately; fantasy calls them RBs.
  if (p === "FB" || p === "HB") return "RB";
  if (p === "PK") return "K";
  return (POS as string[]).includes(p) ? (p as Position) : null;
}

/** Collapse FFA's player universe: projection rows ∪ raw rows, deduped by (name, position), first row wins. */
function ffaUniverse(inputs: FfaInputs): FfaPlayer[] {
  const byKey = new Map<string, FfaPlayer>();
  for (const r of inputs.projections) {
    const p = pos(r.position);
    if (!p) continue;
    const key = `${mergeName(r.player)}|${p}`;
    if (byKey.has(key)) continue;
    byKey.set(key, { name: r.player, pos: p, team: canonicalTeam(r.team), merge: mergeName(r.player), proj: r, raw: null });
  }
  for (const r of inputs.rawStats) {
    const p = pos(r.position);
    if (!p) continue;
    const key = `${mergeName(r.player)}|${p}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.raw ??= r;
      if (!existing.team) existing.team = canonicalTeam(r.team);
    } else {
      byKey.set(key, { name: r.player, pos: p, team: canonicalTeam(r.team), merge: mergeName(r.player), proj: null, raw: r });
    }
  }
  return [...byKey.values()];
}

/** Build the snapshot. */
export function buildFfaSnapshot(inputs: FfaInputs): { snapshot: SeasonSnapshot; report: FfaBuildReport } {
  const { year } = inputs;
  const schedule: Schedule = scheduleFromGames(inputs.games, year);
  const ppr = SCORING_PRESETS.ppr;

  // ---- nflverse indexes ---------------------------------------------------
  const weeklyById = new Map<string, Row[]>();
  const idsByMergePos = new Map<string, Set<string>>();
  const idsByLoosePos = new Map<string, Set<string>>();
  const idsByMerge = new Map<string, Set<string>>();
  const teamById = new Map<string, string>();
  const add = (m: Map<string, Set<string>>, k: string, id: string) => {
    const s = m.get(k) ?? new Set<string>();
    s.add(id);
    m.set(k, s);
  };
  for (const r of inputs.weekly) {
    if (r.season_type !== "REG") continue;
    const id = r.player_id;
    const list = weeklyById.get(id) ?? [];
    list.push(r);
    weeklyById.set(id, list);
    const p = nflPos(r.position);
    const merge = mergeName(r.player_display_name || r.player_name || "");
    if (p) {
      add(idsByMergePos, `${merge}|${p}`, id);
      add(idsByLoosePos, `${looseName(r.player_display_name || "")}|${p}`, id);
    }
    add(idsByMerge, merge, id);
    teamById.set(id, canonicalTeam(r.team));
  }
  const gsisByMfl = new Map<string, string>();
  for (const c of inputs.cross) if (c.mfl_id && c.gsis_id && c.gsis_id !== "NA") gsisByMfl.set(c.mfl_id, c.gsis_id);

  // D/ST weekly points by canonical team
  const dstWeekly = new Map<string, (number | null)[]>();
  for (const r of inputs.teamWeekly) {
    if (r.season_type !== "REG") continue;
    const team = canonicalTeam(r.team);
    const week = num(r.week);
    if (week < 1 || week > SEASON_WEEKS) continue;
    const pa = schedule.pointsAllowed.get(`${team}|${week}`);
    if (pa == null) continue;
    const arr = dstWeekly.get(team) ?? Array<number | null>(SEASON_WEEKS).fill(null);
    arr[week - 1] = Math.round(dstPoints(teamDefenseFromNflverse(r, pa)) * 10) / 10;
    dstWeekly.set(team, arr);
  }

  // ---- players -------------------------------------------------------------
  const report: FfaBuildReport = {
    year,
    weeks: schedule.weeks,
    players: 0,
    byPos: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 },
    withAdp: 0,
    matchedById: 0,
    matchedByName: 0,
    noStats: [],
    noStatsDrafted: [],
    noComponents: [],
    receptions: { column: 0, backout: 0, prior: 0, none: 0 },
    ambiguousNames: [],
  };
  const players: SeasonPlayer[] = [];
  const adpRows: FfaAdpRow[] = [];
  const pick = (ids: Set<string> | undefined, team: string): string | null => {
    if (!ids || ids.size === 0) return null;
    if (ids.size === 1) return [...ids][0];
    const same = [...ids].filter((id) => teamById.get(id) === team);
    if (same.length === 1) return same[0];
    // Ambiguous — take the one with the most game weeks (the one who actually played).
    return [...ids].sort((a, b) => (weeklyById.get(b)?.length ?? 0) - (weeklyById.get(a)?.length ?? 0))[0];
  };

  let idx = 0;
  for (const fp of ffaUniverse(inputs)) {
    idx++;
    const { name, pos: p, team } = fp;
    const adp = fp.proj && fp.proj.adp !== "NA" && fp.proj.adp !== "" ? num(fp.proj.adp) : null;
    const ffaPoints = fp.proj && fp.proj.points !== "NA" ? num(fp.proj.points) : null;
    const bye: number | null =
      (team ? schedule.byes.get(team) : undefined) ?? (fp.proj && fp.proj.bye_week !== "NA" && fp.proj.bye_week !== "" ? num(fp.proj.bye_week) : null);

    // projection
    let proj: StatLine | null = null;
    let projApplied = ffaPoints ?? 0;
    if (p === "K" || p === "DST") {
      // FFA's K/DST points are the projection (their components don't decompose into our StatLine).
      if (ffaPoints == null) continue; // raw-only K/DST rows carry nothing we can score
    } else if (fp.raw) {
      const { line, recSource } = ffaProjectedLine(fp.raw, { year, pos: p, points: ffaPoints });
      proj = line;
      report.receptions[recSource]++;
      projApplied = Math.round(scoreStatLine(line, ppr) * 10) / 10;
    } else {
      report.noComponents.push(`${name} (${p}${adp != null ? `, ADP ${adp}` : ""})`);
      if (ffaPoints == null) continue;
    }

    // realized
    let weekly: (StatLine | null)[] = Array(SEASON_WEEKS).fill(null);
    let weeklyApplied: (number | null)[] = Array(SEASON_WEEKS).fill(null);
    let actual: StatLine | null = {};
    let actualApplied = 0;
    let espnId = `ffa-${year}-${idx}`;
    if (p === "DST") {
      const arr = dstWeekly.get(team);
      if (arr) {
        weeklyApplied = arr;
        actualApplied = arr.reduce<number>((s, v) => s + (v ?? 0), 0);
      } else report.noStats.push(`${name} (DST ${team})`);
      espnId = `dst-${team}`;
    } else {
      const mfl = fp.raw?.id;
      let id: string | null = null;
      const gsis = mfl ? gsisByMfl.get(mfl) : undefined;
      if (gsis && weeklyById.has(gsis)) {
        id = gsis;
        report.matchedById++;
      } else {
        const cands = idsByMergePos.get(`${fp.merge}|${p}`) ?? idsByLoosePos.get(`${looseName(name)}|${p}`) ?? idsByMerge.get(fp.merge);
        if (cands && cands.size > 1) report.ambiguousNames.push(`${name} (${p})`);
        id = pick(cands, team);
        if (id) report.matchedByName++;
      }
      if (id) {
        espnId = id;
        for (const r of weeklyById.get(id)!) {
          const w = num(r.week) - 1;
          if (w < 0 || w >= SEASON_WEEKS) continue;
          if (p === "K") {
            weeklyApplied[w] = (weeklyApplied[w] ?? 0) + kickerPoints(r);
          } else {
            const line = statLineFromNflverse(r);
            weekly[w] = weekly[w] ? addStatLines([weekly[w], line]) : line;
          }
        }
        if (p === "K") actualApplied = weeklyApplied.reduce<number>((s, v) => s + (v ?? 0), 0);
        else actual = addStatLines(weekly);
      } else {
        report.noStats.push(`${name} (${p}${adp != null ? `, ADP ${adp}` : ""})`);
        if (adp != null && adp <= 180) report.noStatsDrafted.push(`${name} (${p}, ADP ${adp})`);
      }
    }

    players.push({
      espnId,
      name: p === "DST" ? `${name} D/ST` : name,
      pos: p,
      team,
      adpEspn: adp,
      proj,
      projApplied,
      actual,
      actualApplied,
      weekly,
      weeklyApplied,
    });
    report.players++;
    report.byPos[p]++;
    if (adp != null) {
      report.withAdp++;
      adpRows.push({ name: players[players.length - 1].name, pos: p, team, adp, bye });
    }
  }

  // K/DST with no ADP still need to be draftable (the board's deep pool is skill-only): tail them by projection.
  let tail = Math.max(180, ...adpRows.map((r) => r.adp));
  for (const sp of players
    .filter((sp) => (sp.pos === "K" || sp.pos === "DST") && sp.adpEspn == null)
    .sort((a, b) => b.projApplied - a.projApplied)) {
    tail += 1;
    adpRows.push({ name: sp.name, pos: sp.pos, team: sp.team, adp: tail, bye: (sp.team ? schedule.byes.get(sp.team) : undefined) ?? null });
  }

  const adpTable = ffaAdpTable(adpRows);
  const ffc: SeasonSnapshot["ffc"] = {};
  for (const f of FORMATS) ffc[f] = adpTable;

  const snapshot: SeasonSnapshot = {
    year,
    fetchedAt: inputs.fetchedAt ?? "",
    source: "ffa",
    espn: players,
    ffc,
  };
  return { snapshot, report };
}

export { SKILL as FFA_SKILL_POSITIONS };
