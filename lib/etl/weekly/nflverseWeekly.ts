// nflverse weekly box scores: realized volume and production, per player per
// week. Feeds the usage model, the defense-vs-position table, and every
// backtest's actuals.
//
// The raw CSV is ~8.6 MB per season and carries 60+ columns. We keep about
// twenty and cache slim JSON — same policy as every other fixture here.
import { parseCsv } from "../csv";
import type { FetchOpts, SourceResult } from "../fetchers";
import { fetchSlim } from "./cache";

/** Every column any model in lib/engine/weekly/ reads. Verified against the 2025 file. */
export const NFLVERSE_WEEKLY_COLUMNS = [
  "player_id", "player_display_name", "position", "season", "week", "season_type",
  "team", "opponent_team",
  "attempts", "carries", "targets", "receptions",
  "passing_yards", "passing_tds", "passing_interceptions", "passing_2pt_conversions", "passing_first_downs",
  "rushing_yards", "rushing_tds", "rushing_2pt_conversions", "rushing_first_downs", "rushing_fumbles_lost",
  "receiving_yards", "receiving_tds", "receiving_2pt_conversions", "receiving_first_downs", "receiving_fumbles_lost",
  "sack_fumbles_lost",
];

export function slimNflverseWeekly(csv: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const r of parseCsv(csv)) {
    if (r.season_type !== "REG") continue;
    if (!r.position) continue;
    const slim: Record<string, string> = {};
    for (const c of NFLVERSE_WEEKLY_COLUMNS) {
      const v = r[c];
      if (v !== undefined && v !== "") slim[c] = v;
    }
    out.push(slim);
  }
  return out;
}

export function fetchNflverseWeekly(
  season: number,
  opts: FetchOpts = {}
): Promise<SourceResult<Record<string, string>[]>> {
  return fetchSlim<Record<string, string>[]>(
    `nflverse-week-${season}.json`,
    async () => {
      const url =
        `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
      const res = await fetch(url); // node fetch follows the release redirect
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const slim = slimNflverseWeekly(await res.text());
      if (slim.length < 100) throw new Error(`only ${slim.length} rows`);
      return slim;
    },
    opts,
    // Without box scores the usage model and the DvP table both go neutral,
    // which the engine handles (matchMult falls to 1, usage weight is 0).
    () => []
  );
}
