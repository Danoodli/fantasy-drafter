// Strength of schedule from nflverse (free, CC): the 2026 schedule crossed
// with 2025 fantasy points allowed per defense per position. Produces, for
// every team × position, a 0-1 easiness percentile for the full season and
// for the fantasy playoff weeks (15-17) — in best-ball tournaments those are
// the advancement weeks, so playoff matchups carry real draft value.
//
// Node-only, build-time. The raw downloads (~10 MB) are reduced immediately;
// only the slim result is cached as the offline fixture.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "./csv";
import type { Position } from "../types";

const RAW_DIR = join(process.cwd(), "data", "raw");
const FIXTURE = join(RAW_DIR, "sos.json");

/** nflverse team codes → the FFC codes the board uses. */
const TEAM_FIX: Record<string, string> = { LA: "LAR" };

const SOS_POS: Position[] = ["QB", "RB", "WR", "TE"];
const PLAYOFF_WEEKS = [15, 16, 17];

export type SosTable = Record<string, Partial<Record<Position, { season: number; playoff: number }>>>;

export interface SosResult {
  data: SosTable;
  fetchedAt: string;
  fromFixture: boolean;
}

export async function fetchSos(season: number, statsSeason: number): Promise<SosResult> {
  try {
    const [gamesRes, statsRes] = await Promise.all([
      fetch("https://github.com/nflverse/nfldata/raw/master/data/games.csv"),
      fetch(
        `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${statsSeason}.csv`
      ),
    ]);
    if (!gamesRes.ok || !statsRes.ok)
      throw new Error(`HTTP ${gamesRes.status}/${statsRes.status}`);
    const games = parseCsv(await gamesRes.text()).filter(
      (g) => g.season === String(season) && g.game_type === "REG"
    );
    if (games.length < 200) throw new Error(`only ${games.length} ${season} games`);
    const stats = parseCsv(await statsRes.text());

    // Fantasy points allowed: mean PPR points per game a defense gave up to
    // each position last season.
    const fpa: Record<string, Record<string, { pts: number; games: Set<string> }>> = {};
    for (const row of stats) {
      if (row.season_type !== "REG") continue;
      const pos = row.position;
      if (!SOS_POS.includes(pos as Position)) continue;
      const def = TEAM_FIX[row.opponent_team] ?? row.opponent_team;
      if (!def) continue;
      const pts = Number(row.fantasy_points_ppr) || 0;
      const cell = ((fpa[def] ??= {})[pos] ??= { pts: 0, games: new Set() });
      cell.pts += pts;
      cell.games.add(`${row.week}-${TEAM_FIX[row.team] ?? row.team}`);
    }
    const perGame: Record<string, Record<string, number>> = {};
    for (const [def, posMap] of Object.entries(fpa)) {
      for (const [pos, cell] of Object.entries(posMap)) {
        (perGame[def] ??= {})[pos] = cell.pts / Math.max(1, cell.games.size);
      }
    }
    // Percentile-rank each defense per position: 1 = most generous (easiest).
    const easiness: Record<string, Record<string, number>> = {};
    for (const pos of SOS_POS) {
      const entries = Object.entries(perGame)
        .map(([def, m]) => [def, m[pos] ?? 0] as const)
        .sort((a, b) => a[1] - b[1]);
      entries.forEach(([def], i) => {
        (easiness[def] ??= {})[pos] = entries.length > 1 ? i / (entries.length - 1) : 0.5;
      });
    }

    // Opponent map for the target season.
    const opponents: Record<string, { week: number; opp: string }[]> = {};
    for (const g of games) {
      const week = Number(g.week);
      const home = TEAM_FIX[g.home_team] ?? g.home_team;
      const away = TEAM_FIX[g.away_team] ?? g.away_team;
      (opponents[home] ??= []).push({ week, opp: away });
      (opponents[away] ??= []).push({ week, opp: home });
    }

    const table: SosTable = {};
    for (const [team, opps] of Object.entries(opponents)) {
      for (const pos of SOS_POS) {
        const vals = opps.map((o) => easiness[o.opp]?.[pos] ?? 0.5);
        const playoffVals = opps
          .filter((o) => PLAYOFF_WEEKS.includes(o.week))
          .map((o) => easiness[o.opp]?.[pos] ?? 0.5);
        (table[team] ??= {})[pos] = {
          season: round2(mean(vals)),
          playoff: round2(mean(playoffVals.length ? playoffVals : vals)),
        };
      }
    }

    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(table));
    return { data: table, fetchedAt: new Date().toISOString(), fromFixture: false };
  } catch (err) {
    if (!existsSync(FIXTURE)) {
      console.warn(`⚠️  SOS: fetch failed (${err}) and no fixture — matchup data skipped`);
      return { data: {}, fetchedAt: "unknown", fromFixture: true };
    }
    console.warn(`⚠️  SOS: live fetch FAILED (${err}). Using fixture.`);
    return { data: JSON.parse(readFileSync(FIXTURE, "utf8")), fetchedAt: "fixture", fromFixture: true };
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const round2 = (x: number) => Math.round(x * 100) / 100;
