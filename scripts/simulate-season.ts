// Season simulator: run a drafted room through hundreds of simulated seasons
// (ffsimulator-style bootstrap) and report win rates + ceiling percentiles.
// The number that matters in winner-take-most best ball is win rate and p99,
// not mean points.
//
//   pnpm simulate <draft_id> [mySlot] [scoring] [--sims 500] [--bestball]
//
// Rosters come from a real (or mock) Sleeper draft. With --bestball, lineups
// score as best ball (Underdog-style slots, no K/DST) regardless of the
// draft's own settings.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchDraftInfo, fetchPicks } from "../lib/draft/sleeper";
import { pickOwner } from "../lib/draft/snake";
import { simulateRoom } from "../lib/engine/season";
import { mergeName } from "../lib/etl/names";
import type { Board, BoardPlayer, LeagueConfig } from "../lib/types";

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  const [draftId, slotArg, scoring = "ppr"] = args;
  const sims = Number(flags.find((f) => f.startsWith("--sims"))?.split("=")[1] ?? 500);
  const bestball = flags.includes("--bestball");
  if (!draftId) {
    console.error("usage: pnpm simulate <draft_id> [mySlot] [scoring] [--sims=500] [--bestball]");
    process.exit(1);
  }
  const mySlot = slotArg ? Number(slotArg) : null;

  const board: Board = JSON.parse(
    readFileSync(join(process.cwd(), "public", "data", `board-${scoring}.json`), "utf8")
  );
  const byId = new Map(board.players.map((p) => [p.id, p]));
  const byName = new Map(board.players.map((p) => [mergeName(p.name) + "|" + p.pos, p]));

  const info = await fetchDraftInfo(draftId);
  const picks = await fetchPicks(draftId, mySlot);
  console.log(`draft ${draftId}: ${info.teams} teams, ${picks.length} picks, status=${info.status}`);

  const config: LeagueConfig = {
    platform: "sleeper",
    leagueId: info.leagueId ?? "",
    draftId,
    myDraftSlot: mySlot,
    teams: info.teams,
    rounds: info.rounds,
    scoring: scoring as LeagueConfig["scoring"],
    leagueType: bestball || info.bestBall ? "bestball" : "redraft",
    rosterSlots:
      bestball || info.bestBall
        ? { QB: 1, RB: 1, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 }
        : { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
    flexEligible: ["RB", "WR", "TE"],
    strategy: "balanced",
  };

  // Group rosters by owning slot.
  const rosters: BoardPlayer[][] = Array.from({ length: info.teams }, () => []);
  let unmatched = 0;
  for (const pick of picks) {
    const player =
      byId.get(pick.playerId) ?? byName.get(mergeName(pick.playerName) + "|" + pick.pos);
    if (!player) {
      unmatched++;
      continue;
    }
    const owner = pickOwner(pick.pickNo, info.teams, info.tradedPicks);
    rosters[owner - 1].push(player);
  }
  if (unmatched > 0) console.log(`(${unmatched} picks not on the 2026 board — ignored)`);

  console.log(`simulating ${sims} seasons × ${info.teams} rosters (${config.leagueType})…`);
  const { winRate, results } = simulateRoom(rosters, config, sims, 42);

  const rows = results
    .map((r, i) => ({ slot: i + 1, win: winRate[i], ...r }))
    .sort((a, b) => b.win - a.win);
  console.log("\nslot  win%   mean    p10    p50    p90    p99");
  for (const r of rows) {
    const mark = mySlot === r.slot ? "  ← you" : "";
    console.log(
      `${String(r.slot).padStart(4)}  ${(r.win * 100).toFixed(1).padStart(4)}%  ${r.mean.toFixed(0).padStart(5)}  ${r.p10.toFixed(0).padStart(5)}  ${r.p50.toFixed(0).padStart(5)}  ${r.p90.toFixed(0).padStart(5)}  ${r.p99.toFixed(0).padStart(5)}${mark}`
    );
  }
  console.log(
    "\nWin rate = share of simulated seasons this roster outscores the whole room." +
      "\nIn top-heavy tournaments, prefer the roster with the fatter p99, not the fatter mean."
  );
}

main().catch((err) => {
  console.error("SIMULATE FAILED:", err);
  process.exit(1);
});
