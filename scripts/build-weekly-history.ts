// Builds the historical weekly fit set: Sleeper's weekly projections (they
// serve past seasons — verified for 2021, 2024 and 2025 on 2026-09-09) crossed
// with nflverse weekly actuals and the spread/total in nfldata games.csv.
//
// Output: data/historical-data/weekly/{season}.json (compact, committed).
// Run once per season, or after a season ends. Not part of any CI lane.
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fetchSleeperWeekly } from "../lib/etl/weekly/sleeperWeekly";
import { fetchNflverseWeekly } from "../lib/etl/weekly/nflverseWeekly";
import { parseHistoricalLines, lineFor } from "../lib/etl/weekly/vegas";
import { fetchPlayerIds } from "../lib/etl/fetchers";
import { parseCsv } from "../lib/etl/csv";
import { statLineFromNflverse } from "../lib/etl/nflverse";
import { encodeHistory, type HistRow } from "../lib/etl/weekly/history";
import type { Position } from "../lib/types";

const OUT_DIR = join(process.cwd(), "data", "historical-data", "weekly");
const SEASONS = [2021, 2022, 2023, 2024, 2025];
const WEEKS = 18;
/** Below this projection a player is roster filler: keeping him triples the
 *  file size and contributes nothing but noise to the fit. */
const MIN_PROJ_YDS = 10;

async function main() {
  const gamesCsv = await fetch("https://github.com/nflverse/nfldata/raw/master/data/games.csv").then((r) => r.text());
  const idsRes = await fetchPlayerIds({ fixtureOnly: true });
  const cross = parseCsv(idsRes.data); // raw CSV body, per lib/etl/fetchers.ts:135
  const gsisToSleeper: Record<string, string> = {};
  for (const r of cross) if (r.sleeper_id && r.gsis_id) gsisToSleeper[r.gsis_id] = r.sleeper_id;

  mkdirSync(OUT_DIR, { recursive: true });

  for (const season of SEASONS) {
    const lines = parseHistoricalLines(gamesCsv, season);
    if (lines.length < 200) throw new Error(`${season}: only ${lines.length} games with lines`);
    const nfl = await fetchNflverseWeekly(season);

    // actuals: sleeperId|week → stat line
    const actual = new Map<string, ReturnType<typeof statLineFromNflverse>>();
    const unmapped = new Set<string>();
    const seen = new Set<string>();
    for (const r of nfl.data) {
      if (r.season !== String(season) || r.season_type !== "REG") continue;
      const gsis = r.player_id ?? "";
      if (gsis) seen.add(gsis);
      const sid = gsisToSleeper[gsis];
      // A crosswalk miss is NOT harmless: this player's real played game never
      // reaches `actual`, so his row later gets act: null and reads as "did not
      // play". That inflates the measured did-not-play rate and quietly biases
      // anything fitted from availability. Count it and say so.
      if (!sid) {
        if (gsis) unmapped.add(gsis);
        continue;
      }
      actual.set(`${sid}|${r.week}`, statLineFromNflverse(r));
    }
    const missPct = seen.size ? (100 * unmapped.size) / seen.size : 0;
    console.log(
      `${season}: crosswalk mapped ${seen.size - unmapped.size}/${seen.size} gsis ids ` +
        `(${missPct.toFixed(1)}% unmapped)`
    );
    if (missPct > 5) {
      throw new Error(
        `${season}: ${missPct.toFixed(1)}% of gsis ids are absent from db_playerids.csv. ` +
          `Their played games would be recorded as "did not play", inflating the DNP rate. ` +
          `Refresh the crosswalk (full lane) before trusting this fit set.`
      );
    }

    const rows: HistRow[] = [];
    for (let wk = 1; wk <= WEEKS; wk++) {
      const proj = await fetchSleeperWeekly(season, wk);
      for (const [id, p] of Object.entries(proj.data)) {
        const yds = (p.stats.passYds ?? 0) + (p.stats.rushYds ?? 0) + (p.stats.recYds ?? 0);
        if (yds < MIN_PROJ_YDS) continue;
        const line = lineFor(lines.filter((l) => l.week === wk), p.team);
        if (!line) continue; // bye, or a team the schedule file does not carry
        rows.push({
          id, pos: p.pos as Position, team: p.team, wk, opp: line.opp,
          stNow: p.status,
          proj: p.stats,
          act: actual.get(`${id}|${wk}`) ?? null,
          tot: line.total, spr: line.ownSpread,
        });
      }
      process.stdout.write(`\r${season} week ${wk}: ${rows.length} rows`);
    }
    const path = join(OUT_DIR, `${season}.json`);
    writeFileSync(path, encodeHistory(rows));
    const mb = statSync(path).size / 1e6;
    console.log(`\n${season}: ${rows.length} player-weeks, ${mb.toFixed(1)} MB`);
    if (mb > 4) {
      throw new Error(
        `${season}.json is ${mb.toFixed(1)} MB — over budget. Raise MIN_PROJ_YDS or trim a field; ` +
          `five seasons must stay under ~10 MB total (see the spec).`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
