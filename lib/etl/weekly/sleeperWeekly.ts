// Sleeper's WEEKLY projections (undocumented, free, no auth). Verified live
// on 2026-09-09 for 2021, 2024, 2025 and 2026 — five seasons of history is
// what makes the weekly model fittable rather than asserted.
//
// Keyed by sleeper_id, our canonical board id, so the join is exact.
// Node-only, build time. Reduced immediately; only the slim map is cached.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Position, StatLine } from "../../types";
import type { FetchOpts, SourceResult } from "../fetchers";
import { canonicalTeam } from "../nflverse";

const RAW_DIR = join(process.cwd(), "data", "raw", "weekly");

export interface WeeklyProjection {
  stats: StatLine;
  /** Sleeper's injury_status at the time of the projection: fits availability. */
  status: string | null;
  team: string;
  pos: Position;
}

const POSITIONS = new Set<string>(["QB", "RB", "WR", "TE", "K", "DST", "DEF"]);

interface RawRow {
  player_id?: string;
  stats?: Record<string, number | null>;
  player?: { position?: string; team?: string; injury_status?: string | null };
}

/** Pure: raw Sleeper rows → slim map. Exported so tests need no network. */
export function parseSleeperWeekly(rows: unknown[]): Record<string, WeeklyProjection> {
  const out: Record<string, WeeklyProjection> = {};
  for (const raw of rows as RawRow[]) {
    const id = raw?.player_id;
    const posRaw = raw?.player?.position;
    if (!id || !posRaw || !POSITIONS.has(posRaw)) continue;
    const s = raw.stats ?? {};
    const stats: StatLine = {};
    const set = (k: keyof StatLine, v: number | null | undefined) => {
      if (typeof v === "number" && v !== 0) stats[k] = v;
    };
    set("passYds", s.pass_yd);
    set("passTD", s.pass_td);
    set("passInt", s.pass_int);
    set("pass2pt", s.pass_2pt);
    set("rushYds", s.rush_yd);
    set("rushTD", s.rush_td);
    set("rush2pt", s.rush_2pt);
    set("receptions", s.rec);
    set("recYds", s.rec_yd);
    set("recTD", s.rec_td);
    set("rec2pt", s.rec_2pt);
    set("fumblesLost", s.fum_lost);
    set("rushFd", s.rush_fd);
    set("recFd", s.rec_fd);
    set("passFd", s.pass_fd);
    // A row with no stats at all is a rostered player Sleeper has no opinion
    // on. Emitting him as a 0.0 projection would put a phantom in every
    // ranking, so drop him and let the board's own player list decide.
    if (Object.keys(stats).length === 0) continue;
    out[id] = {
      stats,
      status: raw.player?.injury_status ?? null,
      team: canonicalTeam(raw.player?.team),
      pos: (posRaw === "DEF" ? "DST" : posRaw) as Position,
    };
  }
  return out;
}

export async function fetchSleeperWeekly(
  season: number,
  week: number,
  opts: FetchOpts = {}
): Promise<SourceResult<Record<string, WeeklyProjection>>> {
  const key = `sleeper-week-${season}-${week}.json`;
  const fixturePath = join(RAW_DIR, key);
  const readFixture = () => JSON.parse(readFileSync(fixturePath, "utf8"));

  if (opts.fixtureOnly) {
    if (!existsSync(fixturePath)) throw new Error(`fixture ${key} missing — run the weekly lane live first`);
    return { data: readFixture(), fetchedAt: "fixture", fromFixture: true };
  }
  try {
    const url =
      `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular` +
      `&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF` +
      `&order_by=pts_ppr`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as unknown[];
    if (!Array.isArray(rows) || rows.length < 200) throw new Error(`only ${(rows as unknown[])?.length} rows`);
    const slim = parseSleeperWeekly(rows);
    if (Object.keys(slim).length < 150) throw new Error(`only ${Object.keys(slim).length} usable rows`);
    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(fixturePath, JSON.stringify(slim));
    return { data: slim, fetchedAt: new Date().toISOString(), fromFixture: false };
  } catch (err) {
    if (!existsSync(fixturePath)) {
      throw new Error(`sleeper week ${season}/${week} failed (${err}) and no fixture at ${fixturePath}`);
    }
    console.warn(`\n⚠️  ${key}: live fetch FAILED (${err}). Using committed fixture.\n`);
    return { data: readFixture(), fetchedAt: "fixture", fromFixture: true };
  }
}
