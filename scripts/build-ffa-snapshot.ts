// Build data/raw/seasons/ffa/<year>.json from the hand-exported FFA CSVs in
// data/historical-data/ and nflverse realized weekly stats.
//
//   pnpm build:ffa-snapshot <year|all> [--refresh]
//
// nflverse weekly files are fetched once into data/cache/nflverse/ (gitignored,
// ~8 MB per season) — the snapshot is what gets committed. The user-provided
// season totals (data/historical-data/nflverse-actuals-raw-data/) are used as
// a cross-check: weekly sums must reproduce them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/etl/csv";
import { buildFfaSnapshot, type FfaBuildReport } from "../lib/etl/ffaSnapshot";
import { canonicalTeam, num } from "../lib/etl/nflverse";
import { snapshotPath } from "../lib/etl/seasonSnapshot";

const ROOT = process.cwd();
const HIST = join(ROOT, "data", "historical-data");
const CACHE = join(ROOT, "data", "cache", "nflverse");
const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const refresh = process.argv.includes("--refresh");
if (!positional[0]) {
  console.error("usage: pnpm build:ffa-snapshot <year|all> [--refresh]");
  process.exit(1);
}

function availableYears(): number[] {
  const years: number[] = [];
  for (let y = 2010; y <= 2035; y++) if (existsSync(join(HIST, "ffa-projections", `projections_${y}_wk0.csv`))) years.push(y);
  return years;
}

async function cached(name: string, urls: string[]): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, name);
  if (!refresh && existsSync(path) && readFileSync(path).length > 1000) return readFileSync(path, "utf8");
  let lastErr = "";
  for (const url of urls) {
    const res = await fetch(url);
    if (res.ok) {
      const text = await res.text();
      if (text.length > 1000) {
        writeFileSync(path, text);
        console.log(`  fetched ${name} (${Math.round(text.length / 1024)} KB)`);
        return text;
      }
    }
    lastErr = `HTTP ${res.status} ${url}`;
  }
  throw new Error(`could not fetch ${name}: ${lastErr}`);
}

/** nflverse moved per-season assets between release tags in 2025; try both. */
const weeklyUrls = (kind: "player" | "team", year: number) => [
  `${NFLVERSE}/stats_${kind}/stats_${kind}_week_${year}.csv`,
  `${NFLVERSE}/player_stats/stats_${kind}_week_${year}.csv`,
];

function printReport(r: FfaBuildReport) {
  const pos = (Object.entries(r.byPos) as [string, number][]).map(([p, n]) => `${p} ${n}`).join(", ");
  console.log(`  ${r.players} players (${pos}); ${r.withAdp} with ADP; ${r.weeks}-week season`);
  console.log(`  realized lines matched: ${r.matchedById} by id, ${r.matchedByName} by name; ${r.noStats.length} with no NFL line (scored 0)`);
  if (r.noStatsDrafted.length) console.log(`    drafted (ADP ≤ 180) but never played: ${r.noStatsDrafted.join("; ")}`);
  const rec = r.receptions;
  console.log(`  projected receptions: ${rec.column} from column, ${rec.backout} backed out of FFA points, ${rec.prior} from yards/reception prior`);
  if (r.noComponents.length) console.log(`  ${r.noComponents.length} projection rows without raw components (kept as points): ${r.noComponents.slice(0, 5).join("; ")}`);
  if (r.ambiguousNames.length) console.log(`  ambiguous names resolved by team/games: ${r.ambiguousNames.slice(0, 6).join("; ")}`);
}

/** Weekly sums must reproduce the user-provided season totals (same publisher, so exact). */
function crossCheck(year: number, snapshot: ReturnType<typeof buildFfaSnapshot>["snapshot"]) {
  const path = join(HIST, "nflverse-actuals-raw-data", `stats_player_reg_${year}.csv`);
  if (!existsSync(path)) {
    console.log("  (no season-total file to cross-check against)");
    return;
  }
  const season = new Map(parseCsv(readFileSync(path, "utf8")).map((r) => [r.player_id, r]));
  let checked = 0;
  const off: string[] = [];
  for (const sp of snapshot.espn) {
    const row = season.get(sp.espnId);
    if (!row || !sp.actual || sp.pos === "K" || sp.pos === "DST") continue;
    checked++;
    const yards = (sp.actual.passYds ?? 0) + (sp.actual.rushYds ?? 0) + (sp.actual.recYds ?? 0);
    const want = num(row.passing_yards) + num(row.rushing_yards) + num(row.receiving_yards);
    const tds = (sp.actual.passTD ?? 0) + (sp.actual.rushTD ?? 0) + (sp.actual.recTD ?? 0);
    const wantTds = num(row.passing_tds) + num(row.rushing_tds) + num(row.receiving_tds);
    if (Math.abs(yards - want) > 0.5 || Math.abs(tds - wantTds) > 0.5) off.push(`${sp.name}: ${yards}/${tds} vs ${want}/${wantTds}`);
  }
  console.log(`  cross-check vs season totals: ${checked} players compared, ${off.length} mismatches${off.length ? ` — ${off.slice(0, 4).join("; ")}` : ""}`);
  if (off.length > checked * 0.02) throw new Error(`${year}: weekly sums disagree with season totals for ${off.length} players`);
}

async function buildYear(year: number) {
  console.log(`\nseason ${year} (FFA + nflverse)`);
  const read = (rel: string) => parseCsv(readFileSync(join(HIST, rel), "utf8"));
  const projections = read(`ffa-projections/projections_${year}_wk0.csv`);
  const rawPath = `ffa-actuals-raw-data/raw_stats_${year}_wk0.csv`;
  const rawStats = existsSync(join(HIST, rawPath)) ? read(rawPath) : [];
  if (!rawStats.length) console.log("  ⚠ no raw projected components for this year — projections fall back to FFA points");
  const weekly = parseCsv(await cached(`stats_player_week_${year}.csv`, weeklyUrls("player", year)));
  const teamWeekly = parseCsv(await cached(`stats_team_week_${year}.csv`, weeklyUrls("team", year)));
  const games = parseCsv(await cached("games.csv", [`${NFLVERSE}/schedules/games.csv`]));
  const cross = parseCsv(readFileSync(join(ROOT, "data", "raw", "db_playerids.csv"), "utf8")) as { mfl_id: string; gsis_id: string }[];

  const { snapshot, report } = buildFfaSnapshot({
    year,
    projections,
    rawStats,
    weekly,
    teamWeekly,
    games,
    cross,
    fetchedAt: new Date().toISOString(),
  });
  printReport(report);
  crossCheck(year, snapshot);
  // Sanity: the top of the FFA board must have real lines (a join bug shows up here first).
  const top = snapshot.espn.filter((p) => p.adpEspn != null && p.adpEspn <= 60 && p.pos !== "DST");
  const topZero = top.filter((p) => !p.weekly.some((w) => w != null) && !p.weeklyApplied.some((w) => w != null));
  console.log(`  top-60 ADP players with a realized line: ${top.length - topZero.length}/${top.length}${topZero.length ? ` (none: ${topZero.map((p) => p.name).join(", ")})` : ""}`);
  const teams = new Set(snapshot.espn.map((p) => canonicalTeam(p.team)).filter(Boolean));
  if (teams.size !== 32) console.log(`  ⚠ ${teams.size} team codes on the board (expected 32): ${[...teams].sort().join(" ")}`);

  const out = snapshotPath(year, "ffa");
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshot));
  console.log(`  wrote ${out} (${Math.round(readFileSync(out).length / 1024)} KB) — commit this file`);
}

async function main() {
  const years = positional[0] === "all" ? availableYears() : positional.map(Number);
  if (!years.length) throw new Error("no FFA projection files found under data/historical-data/ffa-projections/");
  for (const y of years) await buildYear(y);
}

main().catch((err) => {
  console.error("\nBUILD FAILED:", err.message ?? err);
  process.exit(1);
});
