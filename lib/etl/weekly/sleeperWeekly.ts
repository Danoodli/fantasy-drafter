// Sleeper's WEEKLY projections (undocumented, free, no auth). Verified live
// on 2026-09-09 for seasons 2021–2025 (five seasons of history makes the
// weekly model fittable rather than asserted).
//
// Keyed by sleeper_id, our canonical board id, so the join is exact.
// Node-only, build time. Reduced immediately; only the slim map is cached.
import type { Position, StatLine } from "../../types";
import type { FetchOpts, SourceResult } from "../fetchers";
import { canonicalTeam } from "../nflverse";
import { fetchSlim } from "./cache";

export interface WeeklyProjection {
  stats: StatLine;
  /**
   * K and DST ONLY: the source's published point total. Sleeper reports
   * kickers as fgm/fga/fgm_40_49 and defenses as points-allowed buckets, none
   * of which map to StatLine, so these two positions cannot be re-scored under
   * league settings. Same accepted limitation as the season board, where
   * BoardPlayer.stats is documented absent for K/DST.
   */
  points?: number;
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
    const pos = (posRaw === "DEF" ? "DST" : posRaw) as Position;
    let points: number | undefined;
    if (Object.keys(stats).length === 0) {
      // K and DST never have a mappable stat line, so they take the published
      // total instead — without this, a weekly board has no kicker and no
      // defense, and a lineup needs one of each.
      if (pos !== "K" && pos !== "DST") {
        // An offensive row with no stats is a rostered player Sleeper has no
        // opinion on. Emitting him as 0.0 would put a phantom in every
        // ranking, so drop him and let the board's player list decide.
        continue;
      }
      for (const key of ["pts_half_ppr", "pts_ppr", "pts_std"] as const) {
        const v = s[key];
        if (typeof v === "number" && v !== 0) {
          points = v;
          break;
        }
      }
      if (points === undefined) continue;
    }
    out[id] = {
      stats,
      points,
      status: raw.player?.injury_status ?? null,
      team: canonicalTeam(raw.player?.team),
      pos,
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
  return fetchSlim(
    key,
    async () => {
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
      // Guard against a whole position group vanishing; a lineup needs all six.
      const positions = new Set<string>();
      for (const proj of Object.values(slim)) {
        positions.add(proj.pos);
      }
      const required = ["QB", "RB", "WR", "TE", "K", "DST"];
      const missing = required.filter(p => !positions.has(p));
      if (missing.length > 0) throw new Error(`missing positions: ${missing.join(", ")}`);
      return slim;
    },
    opts
  );
}
