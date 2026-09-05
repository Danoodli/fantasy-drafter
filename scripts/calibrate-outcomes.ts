// Fit config/outcome-model.json from the committed season snapshots.
//
//   pnpm calibrate [--years=2024,2025] [--out=config/outcome-model.json]
//
// Population: drafted skill players (FFC ADP <= 180) with a real ESPN
// projection and a realized line. Every number here is a statistic of that
// population, not a judgment call; re-run each season after snapshotting.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/etl/csv";
import { loadSeasonSnapshot } from "../lib/etl/seasonSnapshot";
import { buildHistoricalBoard, type CrossRow } from "../lib/etl/historicalBoard";
import { DEFAULT_KDST, type OutcomeParams, type PosOutcome } from "../lib/engine/outcomeModel";
import { localMeanProjection } from "../lib/engine/outcome";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const flags = new Map(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.slice(2).split("=");
    return [k, v ?? "true"] as const;
  })
);
const years = (flags.get("years") ?? "2024,2025").split(",").map(Number);
const out = flags.get("out") ?? join("config", "outcome-model.json");

const WEEKS = 17;
const GAMES = 16;
const SKILL: Position[] = ["QB", "RB", "WR", "TE"];
const ALL_POS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];
const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null, teams: 12, rounds: 15,
  scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const spearman = (a: number[], b: number[]) => {
  const rank = (v: number[]) => { const o = v.map((x, i) => [x, i] as const).sort((p, q) => q[0] - p[0]); const r = new Array<number>(v.length); o.forEach(([, i], k) => (r[i] = k + 1)); return r; };
  return pearson(rank(a), rank(b));
};
const pearson = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : 0;
};

interface Row { p: BoardPlayer; weekly: (number | null)[]; season: number; played: number }

async function main() {
  const cross = parseCsv(readFileSync(join(process.cwd(), "data/raw/db_playerids.csv"), "utf8")) as unknown as CrossRow[];
  const rows: Row[] = [];
  const stackPairs: number[] = [];
  for (const year of years) {
    const { snapshot } = await loadSeasonSnapshot(year, { log: (l) => console.log(l) });
    const { board, realized } = buildHistoricalBoard(snapshot, cross, "ppr", config);
    const pop = board.filter((p) => ALL_POS.includes(p.pos) && !p.projImputed && p.projPoints > 0 && p.adp <= 180 && realized.has(p.id));
    for (const p of pop) {
      const r = realized.get(p.id)!;
      const weekly = r.weekly.slice(0, WEEKS);
      const played = weekly.filter((w, i) => w != null && w > 0 && p.bye !== i + 1).length;
      rows.push({ p, weekly, season: r.season, played });
    }
    // Same-team QB <-> WR/TE weekly correlation, pairs with >= 10 shared games.
    const qbs = pop.filter((p) => p.pos === "QB");
    for (const qb of qbs) {
      for (const rec of pop.filter((x) => (x.pos === "WR" || x.pos === "TE") && x.team === qb.team && x.adp <= 120)) {
        const a: number[] = [], b: number[] = [];
        const wq = realized.get(qb.id)!.weekly, wr = realized.get(rec.id)!.weekly;
        for (let i = 0; i < WEEKS; i++) {
          if (wq[i] != null && wr[i] != null && wq[i]! > 0 && wr[i]! > 0) { a.push(wq[i]!); b.push(wr[i]!); }
        }
        if (a.length >= 10) stackPairs.push(pearson(a, b));
      }
    }
  }

  const byPos = {} as Record<Position, PosOutcome>;
  for (const pos of ALL_POS) {
    const g = rows.filter((r) => r.p.pos === pos);
    if (g.length < 15) {
      if (pos === "K" || pos === "DST") { byPos[pos] = DEFAULT_KDST; continue; }
      throw new Error(`only ${g.length} ${pos} in the calibration population`);
    }
    const ended = g.filter((r) => r.played <= 8);
    const healthy = g.filter((r) => r.played > 8);
    const missed = healthy.map((r) => Math.max(0, GAMES - r.played));
    const skill = g.filter((r) => r.played >= 12);
    // Reliability: how much of the projected spread is signal. Spearman between
    // the projection and per-game production among players who mostly played.
    const rel = g.filter((r) => r.played >= 6); // per-game rate is meaningful past a handful of games; more n than the >= 12 fit
    const reliability = Math.max(0, Math.min(1, spearman(rel.map((r) => r.p.projPoints), rel.map((r) => r.season / r.played))));
    // Shrink projections toward the position mean by (1 − reliability) — the
    // engine does the same — and fit the ratio on the SHRUNK projection so the
    // level is right after shrinkage.
    const local = localMeanProjection(g.map((r) => r.p));
    const shrunk = (r: Row) => { const mu = local.get(r.p.id) ?? r.p.projPoints; return mu + reliability * (r.p.projPoints - mu); };
    // PER-GAME ratio: what he scored per game he played vs what the (shrunk)
    // projection implies per game. Availability is modeled separately, so a
    // season ratio here would count missed games twice.
    const ratio = skill.map((r) => Math.max(0.05, (r.season / r.played) / (shrunk(r) / GAMES)));
    const logRatio = ratio.map((x) => Math.log(x));
    const weeklySigma = skill.map((r) => {
      const w = r.weekly.filter((x): x is number => x != null && x > 0);
      const cv = sd(w) / Math.max(1e-6, mean(w));
      return Math.sqrt(Math.log(1 + cv * cv)); // lognormal sigma from CV
    });
    // A defense plays every non-bye week; a "missed" DST week is a 0-point game,
    // not an absence. Kickers do get cut mid-season, so their data stands.
    byPos[pos] = {
      seasonEndingProb: pos === "DST" ? 0 : ended.length / g.length,
      healthyMissProb: pos === "DST" ? 0 : mean(missed) / GAMES,
      projLogSigma: sd(logRatio),
      projMedianRatio: median(ratio),
      weeklyLogSigma: median(weeklySigma),
      projReliability: reliability,
    };
  }

  // Market weight: blend projection rank with ADP rank within position; pick
  // the weight that best orders realized points (pairwise accuracy).
  let bestW = 0, bestAcc = -1;
  for (const w of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
    let hits = 0, tot = 0;
    for (const pos of SKILL) {
      const g = rows.filter((r) => r.p.pos === pos);
      const byProj = [...g].sort((a, b) => b.p.projPoints - a.p.projPoints).map((r) => r.p.id);
      const byAdp = [...g].sort((a, b) => a.p.adp - b.p.adp).map((r) => r.p.id);
      const score = new Map(g.map((r) => [r.p.id, (1 - w) * byProj.indexOf(r.p.id) + w * byAdp.indexOf(r.p.id)]));
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        if (g[i].season === g[j].season) continue;
        tot++;
        if ((score.get(g[i].p.id)! < score.get(g[j].p.id)!) === (g[i].season > g[j].season)) hits++;
      }
    }
    const acc = hits / tot;
    if (acc > bestAcc + 1e-9) { bestAcc = acc; bestW = w; }
  }

  const params: OutcomeParams = {
    fittedOn: years,
    weeks: WEEKS,
    gamesPerSeason: GAMES,
    byPos,
    teamCorrelation: Math.max(0, mean(stackPairs)),
    marketWeight: bestW,
  };
  writeFileSync(out, JSON.stringify(params, null, 2) + "\n");
  console.log(`\nwrote ${out} from ${rows.length} player-seasons (${years.join(", ")})`);
  for (const pos of ALL_POS) {
    const p = byPos[pos];
    console.log(`  ${pos.padEnd(3)}: SE ${(p.seasonEndingProb * 100).toFixed(0).padStart(2)}%  miss/game ${p.healthyMissProb.toFixed(3)}  reliability ${p.projReliability.toFixed(2)}  skill log-sd ${p.projLogSigma.toFixed(2)}  bias ${p.projMedianRatio.toFixed(2)}  weekly sigma ${p.weeklyLogSigma.toFixed(2)}`);
  }
  console.log(`  QB<->receiver weekly r ${params.teamCorrelation.toFixed(2)} (${stackPairs.length} pairs)   market weight ${bestW}`);
  // Reconciliation: the model's implied mean season ratio must match the population's.
  console.log("\n  reconciliation (all drafted players): observed mean season/proj  vs  model avail × E[per-game ratio]");
  for (const pos of ALL_POS) {
    const g = rows.filter((r) => r.p.pos === pos);
    if (g.length < 15) continue;
    const pp = byPos[pos];
    const local = localMeanProjection(g.map((r) => r.p));
    const observed = mean(g.map((r) => { const mu = local.get(r.p.id) ?? r.p.projPoints; return r.season / (mu + pp.projReliability * (r.p.projPoints - mu)); }));
    const avail = (1 - pp.seasonEndingProb) * (1 - pp.healthyMissProb) + pp.seasonEndingProb * (4 / GAMES);
    const eRatio = pp.projMedianRatio * Math.exp((pp.projLogSigma * pp.projLogSigma) / 2);
    console.log(`  ${pos.padEnd(3)}: observed ${observed.toFixed(3)}   model ${(avail * eRatio).toFixed(3)}   (avail ${avail.toFixed(3)} × ratio ${eRatio.toFixed(3)})`);
  }
}

main().catch((e) => { console.error("CALIBRATE FAILED:", e.message ?? e); process.exit(1); });
