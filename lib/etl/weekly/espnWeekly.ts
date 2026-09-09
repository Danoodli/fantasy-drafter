// ESPN's weekly projections: the same kona endpoint the season board already
// uses (lib/etl/fetchers.ts fetchEspnProjections), with scoringPeriodId set to
// the week. Free, keyless. Second opinion in the market ensemble.
//
// Keyed by ESPN id, so the join to sleeper ids goes through the DynastyProcess
// crosswalk the same way the season board does it.
import type { Position, StatLine } from "../../types";
import { statLineFromEspn } from "../../scoring";
import { ESPN_POS, ESPN_TEAM } from "../espn";
import type { FetchOpts, SourceResult } from "../fetchers";
import { fetchSlim } from "./cache";

export interface EspnWeeklyPlayer {
  stats: StatLine;
  name: string;
  pos: Position;
  team: string;
}

interface RawStatEntry {
  statSourceId?: number;
  statSplitTypeId?: number;
  scoringPeriodId?: number;
  stats?: Record<string, number>;
}
interface RawEntry {
  id?: number;
  player?: {
    fullName?: string;
    defaultPositionId?: number;
    proTeamId?: number;
    stats?: RawStatEntry[];
  };
}

/**
 * statSourceId 1 = projection, 0 = actual. statSplitTypeId 1 = single week.
 * Taking the wrong source would silently train the model on results.
 */
export function parseEspnWeekly(json: unknown, week: number): Record<string, EspnWeeklyPlayer> {
  const doc = json as { players?: RawEntry[] };
  const out: Record<string, EspnWeeklyPlayer> = {};
  for (const entry of doc?.players ?? []) {
    const id = entry.id;
    const pl = entry.player;
    if (!id || !pl) continue;
    const pos = ESPN_POS[pl.defaultPositionId ?? -1] as Position | undefined;
    if (!pos) continue;
    const proj = (pl.stats ?? []).find(
      (s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === week
    );
    if (!proj?.stats) continue;
    const stats = statLineFromEspn(proj.stats);
    if (Object.keys(stats).length === 0) continue;
    out[String(id)] = {
      stats,
      name: pl.fullName ?? "",
      pos,
      team: ESPN_TEAM[pl.proTeamId ?? -1] ?? "",
    };
  }
  return out;
}

export function fetchEspnWeekly(
  season: number,
  week: number,
  opts: FetchOpts = {}
): Promise<SourceResult<Record<string, EspnWeeklyPlayer>>> {
  return fetchSlim<Record<string, EspnWeeklyPlayer>>(
    `espn-week-${season}-${week}.json`,
    async () => {
      const url =
        `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}` +
        `/segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId=${week}`;
      const filter = {
        players: { limit: 1500, sortPercOwned: { sortAsc: false, sortPriority: 1 } },
      };
      const res = await fetch(url, { headers: { "x-fantasy-filter": JSON.stringify(filter) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseEspnWeekly(await res.json(), week);
      const n = Object.keys(parsed).length;
      if (n < 100) throw new Error(`only ${n} weekly projections`);
      return parsed;
    },
    opts,
    // ESPN is the SECOND ensemble source and ships at weight 0, so dropping it
    // degrades nothing today; blendMarket renormalizes over the sources present.
    () => ({})
  );
}
