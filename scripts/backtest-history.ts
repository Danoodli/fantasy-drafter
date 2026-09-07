// Multi-season sweep: how accurate were draft-day projections and ADP, season
// by season, and how did the engine fare against the ADP crowd — with the
// cross-year view that separates a trend (evidence to tune) from one year's
// story (noise).
//
//   pnpm backtest:history [--source=ffa|espn] [--years=2018-2025]
//                         [--type=redraft|bestball|both] [--strategy=<id>]
//                         [--rooms=12] [--out=/tmp/bt] [--refresh] [--no-rooms]
//
// Part A (projection quality) is recomputed in-process from the committed
// snapshots — no rooms, instant. Part B (decision quality) reads the per-season
// JSON written by `backtest:season --json`, running any season that is missing
// from --out (or all of them with --refresh).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/etl/csv";
import { buildHistoricalBoard, type CrossRow } from "../lib/etl/historicalBoard";
import { loadSeasonSnapshot, type SnapshotSource } from "../lib/etl/seasonSnapshot";
import { pairwiseAccuracy, spearman, type ProjRow } from "../lib/engine/evaluate";
import type { LeagueConfig, Position } from "../lib/types";

// ---- args -----------------------------------------------------------------
const flags = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"] as const;
    })
);
const source = (flags.get("source") ?? "ffa") as SnapshotSource;
const yearsArg = flags.get("years") ?? (source === "ffa" ? "2018-2025" : "2024-2025");
const years = yearsArg.includes("-")
  ? Array.from({ length: Number(yearsArg.split("-")[1]) - Number(yearsArg.split("-")[0]) + 1 }, (_, i) => Number(yearsArg.split("-")[0]) + i)
  : yearsArg.split(",").map(Number);
const typeArg = flags.get("type") ?? "both";
const types = (typeArg === "both" ? ["redraft", "bestball"] : [typeArg]) as ("redraft" | "bestball")[];
const rooms = Number(flags.get("rooms") ?? 12);
const out = flags.get("out") ?? "/tmp/bt";
const refresh = flags.has("refresh");
const strategyFor = (type: string) => flags.get("strategy") ?? (type === "bestball" ? "robust-rb" : "balanced");

// ---- formatting -----------------------------------------------------------
const pad = (s: string | number, n: number) => String(s).padStart(n);
const padR = (s: string | number, n: number) => String(s).padEnd(n);
const f = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const signed = (n: number, d = 1) => (Number.isFinite(n) ? (n >= 0 ? "+" : "") + n.toFixed(d) : "—");
const pct = (n: number) => (Number.isFinite(n) ? (100 * n).toFixed(0) + "%" : "—");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const hr = (t: string) => console.log(`\n${"═".repeat(96)}\n ${t}\n${"═".repeat(96)}`);
const sub = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

const SKILL: Position[] = ["QB", "RB", "WR", "TE"];
const RANGES: [string, number, number][] = [["1-3", 0, 36], ["4-7", 36, 84], ["8-12", 84, 144], ["13+", 144, 9999]];
const TIER: Record<string, number> = { QB: 12, RB: 24, WR: 24, TE: 12 };

const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null, teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }, flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

interface Row extends ProjRow {
  /** Regular-season weeks with a positive line. */
  games: number;
}
interface YearProj {
  year: number;
  rows: Row[]; // skill positions, genuine projection + realized line
  weeks: number;
}

function stats(rows: { proj: number; actual: number }[]) {
  const n = rows.length;
  return {
    n,
    rho: n > 2 ? spearman(rows.map((r) => r.proj), rows.map((r) => r.actual)) : NaN,
    pairwise: n > 2 ? pairwiseAccuracy(rows) : NaN,
    mae: n ? mean(rows.map((r) => Math.abs(r.actual - r.proj))) : NaN,
    bias: n ? mean(rows.map((r) => r.actual - r.proj)) : NaN,
  };
}

async function projectionSweep(): Promise<YearProj[]> {
  const cross = parseCsv(readFileSync(join(process.cwd(), "data", "raw", "db_playerids.csv"), "utf8")) as unknown as CrossRow[];
  const outRows: YearProj[] = [];
  for (const year of years) {
    let snap;
    try {
      snap = (await loadSeasonSnapshot(year, { source })).snapshot;
    } catch (err) {
      console.log(`  ${year}: ${(err as Error).message}`);
      continue;
    }
    const hb = buildHistoricalBoard(snap, cross, "ppr", config);
    const rows: Row[] = hb.projRows
      .filter((r) => SKILL.includes(r.pos))
      .map((r) => ({ ...r, games: (hb.realized.get(r.id)?.weekly ?? []).filter((w) => (w ?? 0) > 0).length }));
    const weeks = Math.max(...[...hb.realized.values()].map((r) => r.weekly.reduce<number>((m, w, i) => (w != null ? i + 1 : m), 0)));
    outRows.push({ year, rows, weeks });
  }
  return outRows;
}

function printProjection(all: YearProj[]) {
  hr(`A. Projection quality by season — ${source.toUpperCase()} draft-day projections vs realized PPR, skill positions`);
  console.log("ρ = Spearman rank correlation; pairwise = share of player pairs ordered correctly; bias = mean(actual − projected), negative = projected too high.");

  sub("All skill players with a projection and a realized line");
  console.log(`${padR("year", 6)}${pad("n", 5)}${pad("rho", 7)}${pad("pairwise", 10)}${pad("MAE", 7)}${pad("bias", 8)}${pad("zero-game", 11)}${pad("<half season", 14)}`);
  for (const y of all) {
    const s = stats(y.rows);
    const drafted = y.rows.filter((r) => r.adp <= 120);
    const zero = drafted.filter((r) => r.games === 0).length / Math.max(1, drafted.length);
    const half = drafted.filter((r) => r.games < y.weeks / 2).length / Math.max(1, drafted.length);
    console.log(`${padR(y.year, 6)}${pad(s.n, 5)}${pad(f(s.rho, 3), 7)}${pad(pct(s.pairwise), 10)}${pad(f(s.mae, 1), 7)}${pad(signed(s.bias), 8)}${pad(pct(zero), 11)}${pad(pct(half), 14)}`);
  }
  console.log("  zero-game / <half season: share of players with ADP ≤ 120 who played 0 games / fewer than half the weeks — the injury tax inside 'bias'.");

  sub("Bias by position (actual − projected, mean per player) — the tunable");
  console.log(`${padR("year", 6)}${SKILL.map((p) => pad(p, 9)).join("")}    ${SKILL.map((p) => pad("ρ " + p, 8)).join("")}`);
  for (const y of all) {
    const byPos = SKILL.map((p) => stats(y.rows.filter((r) => r.pos === p)));
    console.log(`${padR(y.year, 6)}${byPos.map((s) => pad(signed(s.bias), 9)).join("")}    ${byPos.map((s) => pad(f(s.rho, 2), 8)).join("")}`);
  }
  const meanRow = SKILL.map((p) => mean(all.map((y) => stats(y.rows.filter((r) => r.pos === p)).bias)));
  const meanRho = SKILL.map((p) => mean(all.map((y) => stats(y.rows.filter((r) => r.pos === p)).rho)));
  console.log(`${padR("mean", 6)}${meanRow.map((b) => pad(signed(b), 9)).join("")}    ${meanRho.map((r) => pad(f(r, 2), 8)).join("")}`);
  const neg = SKILL.map((p) => all.filter((y) => stats(y.rows.filter((r) => r.pos === p)).bias < 0).length);
  console.log(`${padR("yrs<0", 6)}${neg.map((n) => pad(`${n}/${all.length}`, 9)).join("")}`);

  sub("Bias and ordering by draft range (12-team rounds)");
  console.log(`${padR("year", 6)}${RANGES.map(([l]) => pad(`bias ${l}`, 11)).join("")}    ${RANGES.map(([l]) => pad(`pair ${l}`, 10)).join("")}`);
  for (const y of all) {
    const rs = RANGES.map(([, lo, hi]) => stats(y.rows.filter((r) => r.adp > lo && r.adp <= hi)));
    console.log(`${padR(y.year, 6)}${rs.map((s) => pad(signed(s.bias), 11)).join("")}    ${rs.map((s) => pad(pct(s.pairwise), 10)).join("")}`);
  }
  const mb = RANGES.map(([, lo, hi]) => mean(all.map((y) => stats(y.rows.filter((r) => r.adp > lo && r.adp <= hi)).bias)));
  const mp = RANGES.map(([, lo, hi]) => mean(all.map((y) => stats(y.rows.filter((r) => r.adp > lo && r.adp <= hi)).pairwise)));
  console.log(`${padR("mean", 6)}${mb.map((b) => pad(signed(b), 11)).join("")}    ${mp.map((p) => pad(pct(p), 10)).join("")}`);

  sub("Projection vs the crowd — within position, ADP ≤ 180: ρ(projection→actual) vs ρ(ADP order→actual)");
  console.log(`${padR("year", 6)}${SKILL.map((p) => pad(`${p} proj`, 9) + pad("adp", 6)).join("  ")}`);
  const wins: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const y of all) {
    const cells = SKILL.map((p) => {
      const rows = y.rows.filter((r) => r.pos === p && r.adp <= 180);
      const rp = spearman(rows.map((r) => r.proj), rows.map((r) => r.actual));
      const ra = spearman(rows.map((r) => -r.adp), rows.map((r) => r.actual));
      if (rp > ra) wins[p]++;
      return pad(f(rp, 2), 9) + pad(f(ra, 2), 6);
    });
    console.log(`${padR(y.year, 6)}${cells.join("  ")}`);
  }
  console.log(`${padR("proj>adp", 8)}${SKILL.map((p) => pad(`${wins[p]}/${all.length}`, 15)).join("  ")}`);

  sub("Tier hit rates — projected top tier (QB12 / RB24 / WR24 / TE12) that finished in the tier");
  console.log(`${padR("year", 6)}${SKILL.map((p) => pad(p, 8)).join("")}`);
  const hitAll: Record<string, number[]> = { QB: [], RB: [], WR: [], TE: [] };
  for (const y of all) {
    const cells = SKILL.map((p) => {
      const rows = y.rows.filter((r) => r.pos === p);
      const k = TIER[p];
      const projTop = new Set([...rows].sort((a, b) => b.proj - a.proj).slice(0, k).map((r) => r.id));
      const realTop = new Set([...rows].sort((a, b) => b.actual - a.actual).slice(0, k).map((r) => r.id));
      const hit = [...projTop].filter((id) => realTop.has(id)).length / k;
      hitAll[p].push(hit);
      return pad(pct(hit), 8);
    });
    console.log(`${padR(y.year, 6)}${cells.join("")}`);
  }
  console.log(`${padR("mean", 6)}${SKILL.map((p) => pad(pct(mean(hitAll[p])), 8)).join("")}`);

  sub("Calibration by projection size — mean actual vs mean projected, and share who beat their projection");
  const buckets: [string, number, number][] = [["275+", 275, 9999], ["225-275", 225, 275], ["175-225", 175, 225], ["125-175", 125, 175], ["75-125", 75, 125]];
  console.log(`${padR("year", 6)}${buckets.map(([l]) => pad(l, 14)).join("")}`);
  for (const y of all) {
    const cells = buckets.map(([, lo, hi]) => {
      const rows = y.rows.filter((r) => r.proj >= lo && r.proj < hi);
      if (rows.length < 5) return pad("—", 14);
      const beat = rows.filter((r) => r.actual > r.proj).length / rows.length;
      return pad(`${signed(mean(rows.map((r) => r.actual - r.proj)), 0)} (${pct(beat)})`, 14);
    });
    console.log(`${padR(y.year, 6)}${cells.join("")}`);
  }
  console.log("  cell = mean(actual − projected) and (share of players who beat the projection). Calibrated ≈ 0 (50%).");
}

// ---- Part B: decision quality --------------------------------------------
interface SeasonJson {
  year: number;
  source?: string;
  decisions: {
    strategy: string; engine: number; bot: number; delta: number; se: number; beats: number; first: number; top3: number; avgRank: number;
    violations: number; fragility: number; botFragility: number; roomLo: number; roomHi: number;
  }[];
  shapes?: Record<string, Record<Position, { engine: number; bot: number; enginePts: number; botPts: number }>>;
}

function seasonJson(year: number, type: "redraft" | "bestball", strategy: string): SeasonJson | null {
  mkdirSync(out, { recursive: true });
  const file = join(out, `${source}-${year}-${type}-${strategy}.json`);
  if (refresh || !existsSync(file)) {
    if (flags.has("no-rooms")) return null;
    const args = ["scripts/backtest-season.ts", String(year), `--source=${source}`, `--strategy=${strategy}`, `--rooms=${rooms}`, `--json=${file}`];
    if (type === "bestball") args.push("--bestball");
    process.stderr.write(`  running ${year} ${type} ${strategy}…\n`);
    try {
      execFileSync("npx", ["tsx", ...args], { stdio: ["ignore", "ignore", "inherit"] });
    } catch {
      // the season script exits 1 on floor violations but still writes the JSON
    }
    if (!existsSync(file)) return null;
  }
  return JSON.parse(readFileSync(file, "utf8")) as SeasonJson;
}

/** --strategy=all: one matrix, strategies × seasons, of the same-seat delta (and its sign consistency). */
function printStrategyMatrix(type: "redraft" | "bestball") {
  hr(`B. Every strategy — ${type}, same-seat delta vs the ADP bot by season (${source.toUpperCase()} snapshots, ${rooms} rooms)`);
  const perYear = years.map((year) => ({ year, j: seasonJson(year, type, "all") })).filter((x) => x.j) as { year: number; j: SeasonJson }[];
  if (!perYear.length) return console.log("  no results");
  const ids = [...new Set(perYear.flatMap((x) => x.j.decisions.map((d) => d.strategy)))];
  console.log(`${padR("strategy", 20)}${perYear.map((x) => pad(x.year, 7)).join("")}${pad("mean", 7)}${pad("min", 7)}${pad("<0", 5)}${pad("viol", 6)}   avg RB/WR`);
  const rowsOut = ids.map((id) => {
    const ds = perYear.map((x) => x.j.decisions.find((d) => d.strategy === id));
    const deltas = ds.map((d) => d?.delta ?? NaN).filter(Number.isFinite);
    const shapes = perYear.map((x) => x.j.shapes?.[id]).filter(Boolean) as NonNullable<SeasonJson["shapes"]>[string][];
    return { id, ds, deltas, m: mean(deltas), min: Math.min(...deltas), neg: deltas.filter((d) => d < 0).length, viol: mean(ds.map((d) => d?.violations ?? NaN).filter(Number.isFinite)), rb: mean(shapes.map((s) => s.RB.engine)), wr: mean(shapes.map((s) => s.WR.engine)) };
  });
  rowsOut.sort((a, b) => b.m - a.m);
  for (const r of rowsOut)
    console.log(`${padR(r.id, 20)}${r.ds.map((d) => pad(d ? signed(d.delta, 0) : "—", 7)).join("")}${pad(signed(r.m, 0), 7)}${pad(signed(r.min, 0), 7)}${pad(`${r.neg}/${r.deltas.length}`, 5)}${pad(pct(r.viol), 6)}   ${f(r.rb, 1)} / ${f(r.wr, 1)}`);
  console.log("  Sorted by 8-season mean. 'min' = worst season; '<0' = seasons the strategy lost to the ADP bot; viol = seats below a construction floor.");
}

function printDecisions() {
  for (const type of types) {
    if (flags.get("strategy") === "all") {
      printStrategyMatrix(type);
      continue;
    }
    const strategy = strategyFor(type);
    hr(`B. Decision quality — ${strategy}, ${type}, engine vs ADP bot in the same seat (realized PPR points), ${source.toUpperCase()} snapshots`);
    const rowsOut: { year: number; d: SeasonJson["decisions"][number]; sh?: SeasonJson["shapes"] extends infer S ? (S extends Record<string, infer V> ? V : never) : never }[] = [];
    for (const year of years) {
      const j = seasonJson(year, type, strategy);
      const d = j?.decisions.find((x) => x.strategy === strategy);
      if (!j || !d) {
        console.log(`  ${year}: no result`);
        continue;
      }
      rowsOut.push({ year, d, sh: j.shapes?.[strategy] });
    }
    console.log(`${padR("year", 6)}${pad("engine", 8)}${pad("bot", 8)}${pad("delta", 8)}${pad("±se", 5)}${pad("beats", 7)}${pad("1st", 6)}${pad("top3", 6)}${pad("rank", 6)}${pad("viol", 6)}${pad("frag", 6)}${pad("bot frag", 9)}   room range`);
    for (const { year, d } of rowsOut) {
      console.log(
        `${padR(year, 6)}${pad(d.engine.toFixed(0), 8)}${pad(d.bot.toFixed(0), 8)}${pad(signed(d.delta, 0), 8)}${pad(d.se.toFixed(0), 5)}${pad(pct(d.beats), 7)}${pad(pct(d.first), 6)}${pad(pct(d.top3), 6)}${pad(d.avgRank.toFixed(1), 6)}` +
          `${pad(pct(d.violations), 6)}${pad(d.fragility.toFixed(1), 6)}${pad(d.botFragility.toFixed(1), 9)}   ${signed(d.roomLo, 0)} … ${signed(d.roomHi, 0)}`
      );
    }
    if (rowsOut.length) {
      const ds = rowsOut.map((r) => r.d);
      console.log(
        `${padR("mean", 6)}${pad(mean(ds.map((d) => d.engine)).toFixed(0), 8)}${pad(mean(ds.map((d) => d.bot)).toFixed(0), 8)}${pad(signed(mean(ds.map((d) => d.delta)), 0), 8)}${pad("", 5)}${pad(pct(mean(ds.map((d) => d.beats))), 7)}${pad(pct(mean(ds.map((d) => d.first))), 6)}${pad(pct(mean(ds.map((d) => d.top3))), 6)}${pad(mean(ds.map((d) => d.avgRank)).toFixed(1), 6)}`
      );
      console.log(`  seasons with delta > 2·se: ${ds.filter((d) => d.delta > 2 * d.se).length}/${ds.length}; delta < 0: ${ds.filter((d) => d.delta < 0).length}/${ds.length}. Chance: 1st 8%, top3 25%, rank 6.5.`);

      sub(`Roster shape — players per seat, engine vs bot (and realized points delta by position)`);
      const POS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];
      console.log(`${padR("year", 6)}${POS.map((p) => pad(p, 16)).join("")}`);
      for (const { year, sh } of rowsOut) {
        if (!sh) continue;
        console.log(`${padR(year, 6)}${POS.map((p) => pad(`${sh[p].engine.toFixed(1)}/${sh[p].bot.toFixed(1)} ${signed(sh[p].enginePts - sh[p].botPts, 0)}`, 16)).join("")}`);
      }
      const shs = rowsOut.map((r) => r.sh).filter(Boolean) as NonNullable<SeasonJson["shapes"]>[string][];
      if (shs.length)
        console.log(`${padR("mean", 6)}${POS.map((p) => pad(`${mean(shs.map((s) => s[p].engine)).toFixed(1)}/${mean(shs.map((s) => s[p].bot)).toFixed(1)} ${signed(mean(shs.map((s) => s[p].enginePts - s[p].botPts)), 0)}`, 16)).join("")}`);
      console.log("  cell = engine count / bot count, then (engine − bot) realized points from that position per seat.");
    }
  }
}

async function main() {
  const proj = await projectionSweep();
  if (proj.length) printProjection(proj);
  printDecisions();
  console.log(
    "\nRead across rows, not down one column: a sign that holds in 6+ of 8 seasons is a property of the projections or the engine;\n" +
      "anything that flips year to year is that season's injuries. Per-season detail: pnpm backtest:season <year> --source=" + source
  );
}

main().catch((err) => {
  console.error("\nHISTORY FAILED:", err.message ?? err);
  process.exit(1);
});
