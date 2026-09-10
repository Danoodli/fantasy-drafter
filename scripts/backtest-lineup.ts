// Leg B replay gates on synthetic leagues over the real historical
// player-weeks. There is no historical league data, so rosters and matchups
// are drawn at random (seeded) and both strategies face the SAME draws.
//
// Gate L1: start/sit by delta P(win) vs highest projection — realized matchup win rate.
// Gate L2: waiver claim by value-over-my-lineup vs generic ROS rank — realized lineup points added over the next 4 weeks.
// Gate L3: playoff odds calibration — NOT RUN (no league history yet).
//
// Usage: pnpm backtest:lineup -- --holdout=2025 --matchups=150 --seed=1
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeHistory, type HistRow } from "../lib/etl/weekly/history";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import { SCORING_PRESETS } from "../lib/scoring";
import { makeRng } from "../lib/engine/montecarlo";
import { bestLineup } from "../lib/engine/season/lineup";
import { startSitAdvice } from "../lib/engine/season/advice";
import { waiverAdds } from "../lib/engine/season/waivers";
import { histRowToBoardPlayer, histRowToOutlook, realizedPoints, sampleRoster } from "../lib/engine/season/replay";
import type { LeagueConfig, Position } from "../lib/types";

const HIST_DIR = join(process.cwd(), "data", "historical-data", "weekly");
const GATES = join(process.cwd(), "docs", "backtest-gates.md");
const scoring = SCORING_PRESETS.ppr;
const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 12, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
const ROSTER: Partial<Record<Position, number>> = { QB: 2, RB: 4, WR: 4, TE: 2 };
const OPP: Partial<Record<Position, number>> = { QB: 1, RB: 2, WR: 3, TE: 1 };
/** Only players Sleeper thought would matter: a floor on projected points keeps the pool realistic. */
const MIN_PROJ = 5;
const SIMS = 1000;

function arg(name: string, def: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : def;
}

const lines: string[] = [];
function log(s: string) { lines.push(s); console.log(s); }

function main() {
  const season = arg("holdout", 2025);
  const matchups = arg("matchups", 150);
  const seed = arg("seed", 1);
  const path = join(HIST_DIR, `${season}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path} — run pnpm build:weekly-history`);
  const rows = decodeHistory(readFileSync(path, "utf8"));
  const byWeek = new Map<number, HistRow[]>();
  for (const r of rows) {
    if (realizedPoints({ ...r, act: r.proj }, scoring) < MIN_PROJ) continue; // projection floor
    const list = byWeek.get(r.wk) ?? [];
    list.push(r);
    byWeek.set(r.wk, list);
  }
  const actual = new Map<string, number>(); // `${id}:${wk}` -> realized
  for (const r of rows) actual.set(`${r.id}:${r.wk}`, realizedPoints(r, scoring));
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  log(`# Leg B replay gates — holdout ${season}, ${rows.length} player-weeks, ${weeks.length} weeks, ${matchups} matchups/week, seed ${seed}\n`);

  // ---------------------------------------------------------------- Gate L1
  let winsA = 0, winsB = 0, differ = 0, bWinsWhenDiffer = 0, aWinsWhenDiffer = 0, dSq = 0, ptsA = 0, ptsB = 0, n = 0;
  for (const wk of weeks) {
    const pool = byWeek.get(wk)!;
    const rng = makeRng((seed * 7919 + wk * 104729) >>> 0);
    for (let m = 0; m < matchups; m++) {
      const mine = sampleRoster(pool, ROSTER, rng);
      const theirs = sampleRoster(pool, OPP, rng, new Set(mine.map((r) => r.id)));
      if (mine.length < 8 || theirs.length < 7) continue;
      const toAdvice = (r: HistRow) => ({ id: r.id, pos: r.pos, team: r.team, name: r.id, outlook: histRowToOutlook(r, DEFAULT_WEEKLY_MODEL, scoring) });
      const players = mine.map(toAdvice);
      const opp = theirs.map(toAdvice);
      // Their lineup: highest projections (the naive rule, applied to the opponent for both arms).
      const theirLineup = bestLineup(opp.map((p) => ({ id: p.id, pos: p.pos, points: p.outlook.mean })), config);
      const theirReal = theirLineup.starters.reduce((s, x) => s + (actual.get(`${x.player.id}:${wk}`) ?? 0), 0);
      // Arm A: highest projections. Arm B: delta P(win).
      const a = bestLineup(players.map((p) => ({ id: p.id, pos: p.pos, points: p.outlook.mean })), config);
      const b = startSitAdvice({ players, opponent: { kind: "roster", players: opp }, config, params: DEFAULT_WEEKLY_MODEL, sims: SIMS, seed: seed + m }).recommended;
      const realA = a.starters.reduce((s, x) => s + (actual.get(`${x.player.id}:${wk}`) ?? 0), 0);
      const realB = b.starters.reduce((s, x) => s + (actual.get(`${x.player.id}:${wk}`) ?? 0), 0);
      const wA = realA > theirReal ? 1 : realA === theirReal ? 0.5 : 0;
      const wB = realB > theirReal ? 1 : realB === theirReal ? 0.5 : 0;
      winsA += wA; winsB += wB; ptsA += realA; ptsB += realB; n++;
      const sameSet = a.starters.map((s) => s.player.id).sort().join() === b.starters.map((s) => s.player.id).sort().join();
      if (!sameSet) { differ++; bWinsWhenDiffer += wB; aWinsWhenDiffer += wA; dSq += (wB - wA) ** 2; }
    }
  }
  const rateA = winsA / n, rateB = winsB / n;
  // Paired z on the matchups where the lineups differed: mean paired
  // difference over its own standard error, Σd / sqrt(Σd²) — not
  // Σd / sqrt(count), which assumes every difference has unit variance (wA,
  // wB ∈ {0, 0.5, 1}, so a tie contributes d² = 0.25 or 0, not 1).
  const z = dSq > 0 ? (bWinsWhenDiffer - aWinsWhenDiffer) / Math.sqrt(dSq) : 0;
  log(`## Gate L1 — start/sit replay (${n} matchups)`);
  log(`- naive highest-projection lineup: win rate ${(rateA * 100).toFixed(1)}%, ${(ptsA / n).toFixed(1)} pts/wk`);
  log(`- delta P(win) lineup:             win rate ${(rateB * 100).toFixed(1)}%, ${(ptsB / n).toFixed(1)} pts/wk`);
  log(`- lineups differed in ${differ} of ${n} (${((differ / n) * 100).toFixed(1)}%); on those, delta P(win) won ${bWinsWhenDiffer.toFixed(1)} vs ${aWinsWhenDiffer.toFixed(1)} (paired z = ${z.toFixed(2)})`);
  log(`- ${rateB >= rateA ? "PASS" : "FAIL"} — delta P(win) ${rateB >= rateA ? "matches or beats" : "loses to"} naive on realized matchup win rate${Math.abs(z) < 1.96 ? " (difference not distinguishable from noise at 95%)" : ""}\n`);

  // ---------------------------------------------------------------- Gate L2
  const HORIZON = 4;
  let addA = 0, addB = 0, m2 = 0, same = 0;
  for (const wk of weeks) {
    if (!byWeek.has(wk + HORIZON)) continue;
    const pool = byWeek.get(wk)!;
    const rng = makeRng((seed * 7919 + wk * 104729 + 17) >>> 0);
    const future = Array.from({ length: HORIZON }, (_, i) => wk + 1 + i);
    for (let m = 0; m < Math.ceil(matchups / 3); m++) {
      const mine = sampleRoster(pool, ROSTER, rng);
      if (mine.length < 12) continue;
      const roster = mine.map((r) => histRowToBoardPlayer(r, scoring));
      const rostered = new Set(roster.map((p) => p.id));
      const available = pool.filter((r) => !rostered.has(r.id)).map((r) => histRowToBoardPlayer(r, scoring));
      const ctx = { weeks: future, config };
      const a = waiverAdds({ roster, available, ...ctx, maxResults: 1 })[0];
      const bAdd = [...available].sort((x, y) => y.projPoints - x.projPoints)[0];
      if (!a || !bAdd) continue;
      const bDrop = [...roster].sort((x, y) => x.projPoints - y.projPoints)[0];
      const realized = (players: { id: string; pos: Position }[]) => {
        let total = 0;
        for (const w of future) total += bestLineup(players.map((p) => ({ id: p.id, pos: p.pos, points: actual.get(`${p.id}:${w}`) ?? 0 })), config).total;
        return total;
      };
      const base = realized(roster);
      const withA = realized([...roster.filter((p) => p.id !== a.drop?.id), a.add]);
      const withB = realized([...roster.filter((p) => p.id !== bDrop.id), bAdd]);
      addA += withA - base; addB += withB - base; m2++;
      if (a.add.id === bAdd.id) same++;
    }
  }
  log(`## Gate L2 — waiver replay (${m2} rosters, next ${HORIZON} weeks, realized lineup points added; lineups set with hindsight on realized points, for both arms)`);
  log(`- value-over-my-lineup claim: +${(addA / m2).toFixed(2)} pts per roster`);
  log(`- generic ROS-rank claim:     +${(addB / m2).toFixed(2)} pts per roster`);
  log(`- same player chosen in ${same} of ${m2}`);
  log(`- ${addA >= addB ? "PASS" : "FAIL"} — lineup-aware claims ${addA >= addB ? "add at least as much" : "add less"} realized lineup value\n`);

  // ---------------------------------------------------------------- Gate L3
  log(`## Gate L3 — playoff odds calibration`);
  log(`- NOT RUN — needs historical league standings and rosters, which do not exist yet. Every Sleeper sync stores a LeagueSnapshot (lib/client/teams.ts); after a season of them, bucket mid-season odds and check that teams given ~70% made it ~70% of the time.\n`);

  // ---------------------------------------------------------------- write
  const start = "<!-- leg-b:start -->", end = "<!-- leg-b:end -->";
  const block = `${start}\n${lines.join("\n")}\n${end}`;
  let doc = existsSync(GATES) ? readFileSync(GATES, "utf8") : "# Backtest gates\n\n";
  // indexOf slicing rather than a RegExp built from the literal markers: a
  // regex built by string interpolation is fragile (the markers are plain
  // text today, but a future marker with a regex metacharacter would silently
  // change what gets replaced) and `[\s\S]*` is greedy across the WHOLE doc,
  // so two marker pairs would collapse into one.
  const startIdx = doc.indexOf(start);
  if (startIdx === -1) {
    doc = `${doc.trimEnd()}\n\n${block}\n`;
  } else {
    const endIdx = doc.indexOf(end, startIdx + start.length);
    const after = endIdx === -1 ? startIdx + start.length : endIdx + end.length;
    doc = doc.slice(0, startIdx) + block + doc.slice(after);
  }
  writeFileSync(GATES, doc);
  console.log(`\nwrote ${GATES}`);
}

main();
