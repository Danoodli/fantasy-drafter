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

/** Columns that carry a measurement rather than an identifier. */
const NFLVERSE_STAT_COLUMNS = NFLVERSE_WEEKLY_COLUMNS.filter(
  (c) =>
    ![
      "player_id", "player_display_name", "position", "season", "week",
      "season_type", "team", "opponent_team",
    ].includes(c)
);

export function slimNflverseWeekly(csv: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const r of parseCsv(csv)) {
    if (r.season_type !== "REG") continue;
    if (!r.position) continue;
    const slim: Record<string, string> = {};
    let anyStat = false;
    for (const c of NFLVERSE_WEEKLY_COLUMNS) {
      const v = r[c];
      if (v === undefined || v === "") continue;
      slim[c] = v;
      if (!anyStat && NFLVERSE_STAT_COLUMNS.includes(c) && Number(v) !== 0) anyStat = true;
    }
    // Drop rows where every measurement is zero. Provably lossless for both
    // consumers: such a row adds 0 to the team volume totals the usage model
    // sums, and scores exactly 0 in the defence-vs-position table. In 2025
    // that is 13,150 of 18,522 rows — almost entirely defenders (LB, CB, DT,
    // SAF, DE) who appear in the offensive box score as blanks — and every one
    // was verified to have no non-zero stat before this filter was adopted.
    if (!anyStat) continue;
    out.push(slim);
  }
  return out;
}

/**
 * Cached shape. Array-of-objects repeats all 28 column names on all 18,522
 * rows: 8.82 MB of the 11.51 MB first fixture was key text alone, making the
 * "slim" file LARGER than the 8.6 MB CSV it reduced. Columnar plus the
 * all-zero-row filter takes one season to 0.79 MB, which is what makes five
 * committed seasons viable (3.9 MB rather than 57 MB).
 */
export interface SlimTable {
  cols: string[];
  rows: string[][];
}

export function toTable(rows: Record<string, string>[], cols: string[]): SlimTable {
  return { cols, rows: rows.map((r) => cols.map((c) => r[c] ?? "")) };
}

export function fromTable(t: SlimTable): Record<string, string>[] {
  return t.rows.map((row) => {
    const o: Record<string, string> = {};
    t.cols.forEach((c, i) => {
      if (row[i] !== "") o[c] = row[i];
    });
    return o;
  });
}

export async function fetchNflverseWeekly(
  season: number,
  opts: FetchOpts = {}
): Promise<SourceResult<Record<string, string>[]>> {
  // Cached columnar (see SlimTable); decoded back to rows for callers, so the
  // public shape is unchanged.
  const res = await fetchSlim<SlimTable>(
    `nflverse-week-${season}.json`,
    async () => {
      const url =
        `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
      const r = await fetch(url); // node fetch follows the release redirect
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const slim = slimNflverseWeekly(await r.text());
      if (slim.length < 100) throw new Error(`only ${slim.length} rows`);
      return toTable(slim, NFLVERSE_WEEKLY_COLUMNS);
    },
    opts,
    // Without box scores the usage model and the DvP table both go neutral,
    // which the engine handles (matchMult falls to 1, usage weight is 0).
    () => ({ cols: NFLVERSE_WEEKLY_COLUMNS, rows: [] })
  );
  return { ...res, data: fromTable(res.data) };
}
