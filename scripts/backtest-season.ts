// Season backtest: draft with what we knew on draft day of a PAST season, then
// score every roster with what actually happened.
//
//   pnpm backtest:season <year> [--format=ppr] [--strategy=balanced|all]
//                        [--rooms=12] [--teams=12] [--rounds=15] [--bestball]
//                        [--seed=42] [--refresh] [--json=out.json] [--snapshot-only]
//
// Two questions, answered separately:
//   A. Projection quality — how well did draft-day projections predict realized
//      points? (rank correlation, pairwise ordering accuracy, MAE, signed bias
//      by position and by draft range). Bias is the tunable: a position that
//      comes in −30 every year is a projection problem, not bad luck.
//   B. Decision quality — put the engine in every seat of N simulated rooms
//      against ADP-following bots, then compare its roster's REALIZED points
//      with the bot that would have sat in the same seat of the same room.
//      Paired by seed, so the room is identical until the engine deviates.
//
// The first run for a season fetches ESPN + FFC and writes
// data/raw/seasons/<year>.json. Commit it — ESPN purges old projections.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/etl/csv";
import { loadSeasonSnapshot } from "../lib/etl/seasonSnapshot";
import { buildHistoricalBoard, type CrossRow } from "../lib/etl/historicalBoard";
import { biggestMisses, projectionReport, realizedValue, type ProjRow } from "../lib/engine/evaluate";
import { replayRoom } from "../lib/engine/replay";
import { rosterFragility } from "../lib/engine/coverage";
import { evaluateCompletions, WAIVER_FRICTION } from "../lib/engine/rosterValue";
import { spearman } from "../lib/engine/evaluate";
import outcomeJson from "../config/outcome-model.json";
import type { OutcomeParams } from "../lib/engine/outcomeModel";
import { requiredFloor, BESTBALL_TARGETS } from "../lib/engine/recommend";
import type { BoardPlayer, LeagueConfig, Position, ScoringFormat, Strategy } from "../lib/types";

// ---- args -----------------------------------------------------------------

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"] as const;
    })
);
const year = Number(positional[0]);
if (!year || year < 2015) {
  console.error(
    "usage: pnpm backtest:season <year> [--format=ppr] [--strategy=balanced|all] [--rooms=12] " +
      "[--teams=12] [--rounds=15] [--bestball] [--seed=42] [--refresh] [--json=out.json] [--snapshot-only]"
  );
  process.exit(1);
}
const format = (flags.get("format") ?? "ppr") as ScoringFormat;
const strategyArg = flags.get("strategy") ?? "balanced";
const bestball = flags.has("bestball");
const teams = Number(flags.get("teams") ?? 12);
const rounds = Number(flags.get("rounds") ?? (bestball ? 20 : 15));
const rooms = Number(flags.get("rooms") ?? (strategyArg === "all" ? 4 : 12));
const seed = Number(flags.get("seed") ?? 42);
/** Force every strategy onto one value model (A/B against the shipped default). */
const modelOverride = flags.get("model") as "unified" | "lineup" | "blend" | undefined;
/** Alternative outcome-model parameters, e.g. a hold-out fit on one season. */
const calibPath = flags.get("calib");
const outcome: OutcomeParams | undefined = calibPath ? (JSON.parse(readFileSync(calibPath, "utf8")) as OutcomeParams) : undefined;
const paramsForCalib: OutcomeParams = outcome ?? (outcomeJson as OutcomeParams);

// ---- formatting -----------------------------------------------------------

const pad = (s: string | number, n: number) => String(s).padStart(n);
const padR = (s: string | number, n: number) => String(s).padEnd(n);
const f1 = (n: number) => n.toFixed(1);
const signed = (n: number, d = 1) => (n >= 0 ? "+" : "") + n.toFixed(d);
const pct = (n: number) => (100 * n).toFixed(0) + "%";
const hr = (title: string) => console.log(`\n${"═".repeat(78)}\n ${title}\n${"═".repeat(78)}`);

function configFor(): LeagueConfig {
  return {
    platform: "manual",
    leagueId: "",
    draftId: "",
    myDraftSlot: null,
    teams,
    rounds,
    scoring: format,
    leagueType: bestball ? "bestball" : "redraft",
    rosterSlots: bestball
      ? { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, K: 0, DST: 0 }
      : format === "2qb"
        ? { QB: 2, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }
        : { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
    flexEligible: ["RB", "WR", "TE"],
    strategy: strategyArg,
  };
}

// ---- main -----------------------------------------------------------------

async function main() {
  const { snapshot, fromFixture } = await loadSeasonSnapshot(year, {
    refresh: flags.has("refresh"),
    log: (l) => console.log(l),
  });
  if (flags.has("snapshot-only")) return;

  const now = new Date();
  const currentSeason = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  if (year >= currentSeason)
    console.log(`\n⚠️  ${year} is the current season — realized points are PARTIAL and this report will understate every player.`);
  if (!fromFixture) console.log("   (first run for this season — commit data/raw/seasons/)");

  const cross = parseCsv(readFileSync(join(process.cwd(), "data", "raw", "db_playerids.csv"), "utf8")) as unknown as CrossRow[];
  const config = configFor();
  const withWaivers = config.leagueType !== "bestball"; // best ball has no waiver wire
  const { board, realized, projRows, join: j } = buildHistoricalBoard(snapshot, cross, format, config);

  console.log(
    `\nboard ${year} ${format}: ${board.length} players (${j.ffc} from FFC ADP, ${j.deepPool} deep pool), ` +
      `${j.matched} matched to ESPN, ${j.imputed} imputed projections, ${j.unmatched.length} unmatched`
  );
  if (j.unmatched.length) {
    console.log(`  unmatched (no ESPN row — realized as 0): ${j.unmatched.slice(0, 8).join("; ")}${j.unmatched.length > 8 ? " …" : ""}`);
  }

  // ---- A. projection quality ------------------------------------------
  hr(`A. Projection quality — ${year} draft-day projections vs realized (${format})`);
  const rep = projectionReport(projRows);
  console.log(`n=${rep.n} players with a real projection and a realized line\n`);
  console.log(`${padR("", 8)}${pad("n", 5)}${pad("rho", 8)}${pad("pairwise", 10)}${pad("MAE", 8)}${pad("bias", 8)}`);
  const line = (label: string, s: typeof rep) =>
    console.log(`${padR(label, 8)}${pad(s.n, 5)}${pad(s.rho.toFixed(3), 8)}${pad(pct(s.pairwise), 10)}${pad(f1(s.mae), 8)}${pad(signed(s.bias), 8)}`);
  line("ALL", rep);
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const s = rep.byPos[pos];
    if (s) line(pos, { ...s, byPos: {} });
  }

  // Where in the draft does the projection drift live?
  console.log("\nby draft range (rounds, 12-team):");
  const ranges: [string, number, number][] = [["1-3", 0, 36], ["4-7", 36, 84], ["8-12", 84, 144], ["13+", 144, 9999]];
  for (const [label, lo, hi] of ranges) {
    const rows = projRows.filter((r) => r.adp > lo && r.adp <= hi);
    if (rows.length < 5) continue;
    const s = projectionReport(rows);
    console.log(`  rounds ${padR(label, 5)} n=${pad(s.n, 3)}  pairwise=${pad(pct(s.pairwise), 4)}  MAE=${pad(f1(s.mae), 6)}  bias=${pad(signed(s.bias), 7)}`);
  }

  const { busts, booms } = biggestMisses(projRows.filter((r) => r.adp <= 120), 8);
  const miss = (r: ProjRow) =>
    `  ${padR(r.name, 24)} ${padR(r.pos, 3)} ADP ${pad(f1(r.adp), 6)}  proj ${pad(f1(r.proj), 6)} → ${pad(f1(r.actual), 6)}  (${signed(r.actual - r.proj)})`;
  console.log("\nbiggest busts (ADP ≤ 120):");
  busts.forEach((r) => console.log(miss(r)));
  console.log("biggest booms (ADP ≤ 120):");
  booms.forEach((r) => console.log(miss(r)));

  // ---- B. decision quality -------------------------------------------
  const strategies: Strategy[] = JSON.parse(readFileSync(join(process.cwd(), "config", "strategies.json"), "utf8"));
  const chosen = (strategyArg === "all" ? strategies : strategies.filter((s) => s.id === strategyArg)).map((s) =>
    modelOverride ? { ...s, valueModel: modelOverride } : s
  );
  if (modelOverride) console.log(`value model forced to "${modelOverride}" for every strategy`);
  if (calibPath) console.log(`outcome model: ${calibPath} (fitted on ${paramsForCalib.fittedOn.join(", ")})`);
  if (chosen.length === 0) {
    console.error(`unknown strategy ${strategyArg}. Options: all, ${strategies.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  hr(
    `B. Decision quality — engine vs ADP bot in the same seat, ${rooms} rooms × ${teams} seats, ` +
      `${rounds} rounds ${config.leagueType} (realized ${year} points)`
  );
  console.log(
    withWaivers
      ? "Scoring = sum over weeks of the optimal lineup, with one waiver-level body per position available each week (3rd-best undrafted player's actual points) — empty slots get streamed, not zeroed.\n"
      : "Scoring = sum over weeks of the optimal lineup (how best ball scores). No waivers in best ball.\n"
  );

  // Waiver wire. Redraft managers stream: an empty slot in week 6 is filled
  // from free agency, not left at zero. Without this the harness overvalues
  // rostered depth and would grade "stream your TE2" as a loss. But a pickup
  // is made on PROJECTIONS, not hindsight: the streamable pool is the three
  // best undrafted players by preseason projection, and the wire pays the best
  // of those three each week (a manager can choose among a few known names by
  // matchup). Same definition the engine prices. Best ball has no waivers.
  // Redraft: the manager streams the HIGHEST-PROJECTED of the three who is
  // active that week (a choice made on expectation, not hindsight).
  const WAIVER_POOL = 3;
  const waiverLine = (drafted: Set<string>): Record<Position, { weekly: (number | null)[]; expected: number }> => {
    const out = {} as Record<Position, { weekly: (number | null)[]; expected: number }>;
    for (const pos of POSITIONS) {
      const pool = board
        .filter((p) => p.pos === pos && !drafted.has(p.id))
        .sort((a, b) => b.projPoints - a.projPoints)
        .slice(0, WAIVER_POOL);
      // Streaming costs a roster move and a worse-than-projected pickup: the same
      // friction the engine charges (lib/engine/rosterValue.ts).
      const weekly = Array.from({ length: 18 }, (_, w) => {
        const active = pool.find((p) => (realized.get(p.id)?.weekly[w] ?? 0) > 0);
        return active ? Math.max(0, realized.get(active.id)!.weekly[w]! - WAIVER_FRICTION) : 0;
      });
      out[pos] = { weekly, expected: pool.length ? Math.max(0, pool[0].projPoints / 16 - WAIVER_FRICTION) : 0 };
    }
    return out;
  };
  const value = (roster: BoardPlayer[], drafted: Set<string>) => {
    const players = roster.map((p) => ({ pos: p.pos, weekly: realized.get(p.id)?.weekly ?? [], expected: p.projPoints / 16 }));
    if (withWaivers) {
      const line = waiverLine(drafted);
      for (const pos of POSITIONS) if ((config.rosterSlots[pos] ?? 0) > 0) players.push({ pos, weekly: line[pos].weekly, expected: line[pos].expected });
    }
    return realizedValue(players, config).weeklyLineup;
  };

  interface SeatResult { strategy: string; room: number; slot: number; engine: number; bot: number; rank: number; roomMean: number }
  const seats: SeatResult[] = [];
  // Roster shape and where the points came from — usually the whole explanation.
  const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];
  type PosAgg = Record<Position, { n: number; pts: number }>;
  const emptyAgg = (): PosAgg =>
    Object.fromEntries(POSITIONS.map((p) => [p, { n: 0, pts: 0 }])) as PosAgg;
  const shape = new Map<string, { engine: PosAgg; bot: PosAgg; seats: number }>();
  const seasonPts = (id: string) => realized.get(id)?.season ?? 0;

  // Roster legality. Expected points cannot see a roster that can't field
  // its own lineup in week 6 — a 7-RB / 2-WR redraft roster scored fine in
  // the mean and was unplayable. Count floor violations and expected empty
  // starting slot-weeks per seat, engine vs bot.
  const floorFor = (pos: Position) =>
    config.leagueType === "bestball"
      ? Math.max(config.rosterSlots[pos] ?? 0, Math.round((BESTBALL_TARGETS[pos]?.[0] ?? 0) * config.rounds))
      : requiredFloor(pos, config);
  const violations = (roster: BoardPlayer[]): string[] => {
    const out: string[] = [];
    for (const pos of POSITIONS) {
      const n = roster.filter((p) => p.pos === pos).length;
      const floor = floorFor(pos);
      if (n < floor) out.push(`${pos} ${n}<${floor}`);
    }
    return out;
  };
  interface Legality { engineViol: number; botViol: number; engineFrag: number; botFrag: number; worst: string; worstN: number; seats: number }
  const legality = new Map<string, Legality>();
  // Objective calibration: does the model's own expected-points number for a
  // finished roster predict what that roster really scored? Spearman across seats.
  const calib = new Map<string, { expected: number[]; realized: number[] }>();
  const modelExpected = (roster: BoardPlayer[]): number =>
    roster.length === 0 ? 0 : evaluateCompletions([], [roster[0]], [Array.from({ length: 120 }, () => roster.slice(1))], paramsForCalib, config, {}, 1)[0].mean;
  const engineTaken = new Map<string, Map<string, { n: number; pickSum: number }>>(); // strategy → playerId → stats

  for (let r = 0; r < rooms; r++) {
    const roomSeed = seed * 1000 + r;
    const baseline = replayRoom({ board, config, strategy: chosen[0], engineSlot: null, seed: roomSeed, outcome });
    const baseDrafted = new Set(baseline.picks.map((p) => p.playerId));
    const botValues = baseline.rosters.map((r) => value(r, baseDrafted));
    for (const strategy of chosen) {
      const taken = engineTaken.get(strategy.id) ?? new Map();
      engineTaken.set(strategy.id, taken);
      for (let slot = 1; slot <= teams; slot++) {
        const room = replayRoom({ board, config, strategy, engineSlot: slot, seed: roomSeed, outcome });
        const roomDrafted = new Set(room.picks.map((p) => p.playerId));
        const values = room.rosters.map((r) => value(r, roomDrafted));
        const engine = values[slot - 1];
        const rank = 1 + values.filter((v) => v > engine).length;
        seats.push({
          strategy: strategy.id,
          room: r,
          slot,
          engine,
          bot: botValues[slot - 1],
          rank,
          roomMean: values.reduce((a, b) => a + b, 0) / values.length,
        });
        const sh = shape.get(strategy.id) ?? { engine: emptyAgg(), bot: emptyAgg(), seats: 0 };
        shape.set(strategy.id, sh);
        sh.seats++;
        for (const p of room.rosters[slot - 1]) { sh.engine[p.pos].n++; sh.engine[p.pos].pts += seasonPts(p.id); }
        for (const p of baseline.rosters[slot - 1]) { sh.bot[p.pos].n++; sh.bot[p.pos].pts += seasonPts(p.id); }
        const lg = legality.get(strategy.id) ?? { engineViol: 0, botViol: 0, engineFrag: 0, botFrag: 0, worst: "", worstN: 0, seats: 0 };
        legality.set(strategy.id, lg);
        lg.seats++;
        const ev = violations(room.rosters[slot - 1]);
        if (ev.length) {
          lg.engineViol++;
          const desc = POSITIONS.map((q) => `${q}${room.rosters[slot - 1].filter((p) => p.pos === q).length}`).join(" ");
          if (ev.length > lg.worstN) { lg.worstN = ev.length; lg.worst = `${desc} (${ev.join(", ")})`; }
        }
        if (violations(baseline.rosters[slot - 1]).length) lg.botViol++;
        lg.engineFrag += rosterFragility(room.rosters[slot - 1], config);
        lg.botFrag += rosterFragility(baseline.rosters[slot - 1], config);
        // Pool the engine's roster with the bot's in the same seat: rosters that
        // differ systematically are what a calibration test needs.
        const cal = calib.get(strategy.id) ?? { expected: [], realized: [] };
        calib.set(strategy.id, cal);
        cal.expected.push(modelExpected(room.rosters[slot - 1]), modelExpected(baseline.rosters[slot - 1]));
        cal.realized.push(engine, botValues[slot - 1]);
        for (const p of room.picks.filter((p) => p.byEngine)) {
          const t = taken.get(p.playerId) ?? { n: 0, pickSum: 0 };
          t.n++;
          t.pickSum += p.pickNo;
          taken.set(p.playerId, t);
        }
      }
    }
    if (process.stderr.isTTY) process.stderr.write(`\r  rooms ${r + 1}/${rooms}`);
  }
  if (process.stderr.isTTY) process.stderr.write("\r" + " ".repeat(20) + "\r");

  console.log(
    `${padR("strategy", 20)}${pad("engine", 8)}${pad("bot", 8)}${pad("delta", 8)}${pad("±se", 6)}${pad("beats bot", 11)}${pad("1st", 6)}${pad("top3", 6)}${pad("avg rank", 10)}`
  );
  const summary: Record<string, unknown>[] = [];
  for (const strategy of chosen) {
    const mine = seats.filter((s) => s.strategy === strategy.id);
    const n = mine.length;
    const mean = (f: (s: SeatResult) => number) => mine.reduce((a, s) => a + f(s), 0) / n;
    const deltas = mine.map((s) => s.engine - s.bot);
    const dMean = deltas.reduce((a, b) => a + b, 0) / n;
    // Seats within a season are NOT independent — the engine drafts the same
    // core in every room — so the error bar is clustered by room, not by seat.
    const roomMeans = Array.from({ length: rooms }, (_, r) => {
      const inRoom = mine.filter((s) => s.room === r);
      return inRoom.reduce((a, s) => a + s.engine - s.bot, 0) / inRoom.length;
    });
    const dSe = Math.sqrt(
      roomMeans.reduce((a, d) => a + (d - dMean) ** 2, 0) / Math.max(1, rooms - 1) / rooms
    );
    const roomLo = Math.min(...roomMeans);
    const roomHi = Math.max(...roomMeans);
    const row = {
      strategy: strategy.id,
      engine: mean((s) => s.engine),
      bot: mean((s) => s.bot),
      delta: dMean,
      se: dSe,
      beats: mine.filter((s) => s.engine > s.bot).length / n,
      first: mine.filter((s) => s.rank === 1).length / n,
      top3: mine.filter((s) => s.rank <= 3).length / n,
      avgRank: mean((s) => s.rank),
      seats: n,
      roomLo,
      roomHi,
      violations: (legality.get(strategy.id)?.engineViol ?? 0) / Math.max(1, legality.get(strategy.id)?.seats ?? 1),
      fragility: (legality.get(strategy.id)?.engineFrag ?? 0) / Math.max(1, legality.get(strategy.id)?.seats ?? 1),
      botFragility: (legality.get(strategy.id)?.botFrag ?? 0) / Math.max(1, legality.get(strategy.id)?.seats ?? 1),
      objectiveRho: spearman(calib.get(strategy.id)?.expected ?? [], calib.get(strategy.id)?.realized ?? []),
    };
    summary.push(row);
    console.log(
      `${padR(row.strategy, 20)}${pad(row.engine.toFixed(0), 8)}${pad(row.bot.toFixed(0), 8)}${pad(signed(row.delta, 0), 8)}${pad(row.se.toFixed(0), 6)}` +
        `${pad(pct(row.beats), 11)}${pad(pct(row.first), 6)}${pad(pct(row.top3), 6)}${pad(row.avgRank.toFixed(2), 10)}`
    );
  }
  console.log(
    `\nchance levels: 1st ${pct(1 / teams)}, top3 ${pct(3 / teams)}, avg rank ${((teams + 1) / 2).toFixed(2)}. ` +
      `±se is clustered by room (n=${rooms}); a delta inside ±2·se is noise.`
  );
  for (const row of summary) {
    console.log(`  ${row.strategy}: per-room delta ranged ${signed(row.roomLo as number, 0)} … ${signed(row.roomHi as number, 0)}`);
  }
  console.log(
    "\nOne season is one sample. The engine drafts the same core in every room, so a season's result is a bet on a\n" +
      "handful of players — run every snapshotted season before drawing conclusions about a strategy."
  );

  // Roster shape: the single most explanatory table. A 'balanced' strategy that
  // takes 7 RBs in a 2-WR league has a tilt, whether or not it paid off this year.
  for (const strategy of chosen) {
    const sh = shape.get(strategy.id)!;
    console.log(`\nroster shape — ${strategy.id} vs ADP bot (per seat, ${sh.seats} seats):`);
    console.log(`${padR("pos", 5)}${pad("engine #", 10)}${pad("bot #", 8)}${pad("engine pts", 12)}${pad("bot pts", 9)}${pad("delta", 8)}`);
    for (const pos of POSITIONS) {
      const e = sh.engine[pos];
      const b = sh.bot[pos];
      if (e.n === 0 && b.n === 0) continue;
      console.log(
        `${padR(pos, 5)}${pad((e.n / sh.seats).toFixed(2), 10)}${pad((b.n / sh.seats).toFixed(2), 8)}` +
          `${pad((e.pts / sh.seats).toFixed(0), 12)}${pad((b.pts / sh.seats).toFixed(0), 9)}${pad(signed((e.pts - b.pts) / sh.seats, 0), 8)}`
      );
    }
  }

  // Roster legality: the check that would have caught 7 RB / 2 WR.
  let illegal = false;
  console.log(`\nroster legality — floor violations and expected EMPTY starting slot-weeks per season:`);
  console.log(`${padR("strategy", 20)}${pad("engine viol", 12)}${pad("bot viol", 10)}${pad("engine empty", 13)}${pad("bot empty", 11)}  worst engine roster`);
  for (const strategy of chosen) {
    const lg = legality.get(strategy.id)!;
    if (lg.engineViol > 0) illegal = true;
    console.log(
      `${padR(strategy.id, 20)}${pad(pct(lg.engineViol / lg.seats), 12)}${pad(pct(lg.botViol / lg.seats), 10)}` +
        `${pad((lg.engineFrag / lg.seats).toFixed(2), 13)}${pad((lg.botFrag / lg.seats).toFixed(2), 11)}  ${lg.worst || "—"}`
    );
  }
  console.log(
    "'empty' = expected weeks x slots where the roster starts nobody (byes exact, injuries by position rate). Lower is better; the bot is the yardstick."
  );
  console.log("\nobjective calibration — Spearman between the model's expected points for the engine's finished roster and what it really scored, across seats:");
  for (const strategy of chosen) {
    const c = calib.get(strategy.id);
    if (c && c.expected.length > 2) console.log(`  ${padR(strategy.id, 20)} ρ = ${spearman(c.expected, c.realized).toFixed(2)}  (n=${c.expected.length})`);
  }
  if (illegal) {
    console.log("\n⚠️  ILLEGAL ROSTERS: the engine finished at least one seat below a construction floor. This is a bug in the value model, not a strategy choice.");
    process.exitCode = 1;
  }

  // ---- C. what the engine kept drafting --------------------------------
  const focus = chosen[0];
  const taken = engineTaken.get(focus.id)!;
  const byId = new Map(board.map((p) => [p.id, p]));
  const posRank = (key: (p: BoardPlayer) => number) => {
    const m = new Map<string, number>();
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
      board.filter((p) => p.pos === pos).sort((a, b) => key(b) - key(a)).forEach((p, i) => m.set(p.id, i + 1));
    }
    return m;
  };
  const projRank = posRank((p) => p.projPoints);
  const realRank = posRank((p) => realized.get(p.id)?.season ?? 0);

  hr(`C. Players the engine (${focus.id}) drafted most across ${rooms * teams} seats — projected vs realized position rank`);
  const rows = [...taken.entries()]
    .map(([id, t]) => ({ p: byId.get(id)!, n: t.n, avgPick: t.pickSum / t.n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 14);
  console.log(`${padR("player", 26)}${pad("drafted", 8)}${pad("avg pick", 9)}${pad("ADP", 7)}${pad("proj rk", 8)}${pad("real rk", 8)}  verdict`);
  for (const { p, n, avgPick } of rows) {
    const pr = projRank.get(p.id)!;
    const rr = realRank.get(p.id)!;
    const verdict = rr <= pr - 3 ? "✓ boom" : rr >= pr + 8 ? "✗ bust" : "≈ as expected";
    console.log(
      `${padR(`${p.name} (${p.pos})`, 26)}${pad(n, 8)}${pad(f1(avgPick), 9)}${pad(f1(p.adp), 7)}${pad(`${p.pos}${pr}`, 8)}${pad(`${p.pos}${rr}`, 8)}  ${verdict}`
    );
  }

  if (flags.has("json")) {
    const out = flags.get("json")!;
    writeFileSync(out, JSON.stringify({ year, format, config, projection: rep, decisions: summary, seats }, null, 1));
    console.log(`\nwrote ${out}`);
  }
}

main().catch((err) => {
  console.error("\nBACKTEST FAILED:", err.message ?? err);
  process.exit(1);
});
