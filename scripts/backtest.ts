// Backtest: replay a real Sleeper draft with the engine picking in one slot.
//
//   pnpm backtest <draft_id> <slot> [strategy] [scoring]
//
// Every other slot picks exactly what it picked in real life (when the
// engine has stolen that player, the room takes the next-best by ADP).
// Output: the engine's roster vs the slot's actual roster, scored with the
// board's projections. Works on any draft from the current season — run it
// against your league's mock drafts to tune strategies with evidence.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchDraftInfo, fetchPicks } from "../lib/draft/sleeper";
import { picksForSlot, pickOwner } from "../lib/draft/snake";
import { recommend } from "../lib/engine/recommend";
import { computeDrift } from "../lib/engine/drift";
import { mergeName } from "../lib/etl/names";
import type { Board, BoardPlayer, LeagueConfig, Position, Strategy } from "../lib/types";

async function main() {
  const [draftId, slotArg, strategyId = "balanced", scoring = "ppr"] = process.argv.slice(2);
  if (!draftId || !slotArg) {
    console.error("usage: pnpm backtest <draft_id> <slot> [strategy] [scoring]");
    process.exit(1);
  }
  const mySlot = Number(slotArg);

  const board: Board = JSON.parse(
    readFileSync(join(process.cwd(), "public", "data", `board-${scoring}.json`), "utf8")
  );
  const strategies: Strategy[] = JSON.parse(
    readFileSync(join(process.cwd(), "config", "strategies.json"), "utf8")
  );
  const strategy = strategies.find((s) => s.id === strategyId);
  if (!strategy) {
    console.error(`unknown strategy ${strategyId}. Options: ${strategies.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  const info = await fetchDraftInfo(draftId);
  const realPicks = await fetchPicks(draftId, mySlot);
  console.log(`draft ${draftId}: ${info.teams} teams × ${info.rounds} rounds, status=${info.status}, ${realPicks.length} picks`);

  const byId = new Map(board.players.map((p) => [p.id, p]));
  const byName = new Map<string, BoardPlayer>();
  for (const p of board.players) byName.set(mergeName(p.name) + "|" + p.pos, p);
  const resolve = (playerId: string, name: string, pos: string | null) =>
    byId.get(playerId) ?? byName.get(mergeName(name) + "|" + pos);

  const config: LeagueConfig = {
    platform: "sleeper",
    leagueId: info.leagueId ?? "",
    draftId,
    myDraftSlot: mySlot,
    teams: info.teams,
    rounds: info.rounds,
    scoring: scoring as LeagueConfig["scoring"],
    leagueType: info.bestBall ? "bestball" : "redraft",
    rosterSlots: info.bestBall
      ? { QB: 1, RB: 1, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 }
      : { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
    flexEligible: ["RB", "WR", "TE"],
    strategy: strategyId,
  };

  const myPickNos = picksForSlot(mySlot, info.teams, info.rounds, info.tradedPicks);
  const drafted = new Set<string>();
  const engineRoster: BoardPlayer[] = [];
  const actualRoster: BoardPlayer[] = [];
  const opponentCounts: Record<number, Partial<Record<Position, number>>> = {};
  const replayed: typeof realPicks = [];
  let unmatched = 0;

  const adpOrder = [...board.players].sort((a, b) => a.adp - b.adp);

  for (const pick of realPicks) {
    const player = resolve(pick.playerId, pick.playerName, pick.pos);
    const owner = pickOwner(pick.pickNo, info.teams, info.tradedPicks);

    if (owner === mySlot) {
      if (player) actualRoster.push(player);
      // Engine picks instead.
      const out = recommend({
        board: board.players,
        draftedIds: drafted,
        myRoster: engineRoster,
        currentPick: pick.pickNo,
        myPicks: myPickNos.filter((n) => n >= pick.pickNo),
        config,
        strategy,
        drift: computeDrift(replayed, byId),
        opponentCounts,
      });
      const choice = out.recommendations[0]?.player;
      if (choice) {
        engineRoster.push(choice);
        drafted.add(choice.id);
        console.log(
          `  pick ${String(pick.pickNo).padStart(3)}: engine takes ${choice.pos.padEnd(3)} ${choice.name.padEnd(24)} (real: ${pick.playerName})`
        );
      }
    } else {
      // The room picks what it really picked — unless the engine stole him.
      let taken = player;
      if (!taken) unmatched++;
      if (taken && drafted.has(taken.id)) {
        taken = adpOrder.find((p) => !drafted.has(p.id) && p.pos === taken!.pos);
      }
      if (taken) {
        drafted.add(taken.id);
        const counts = (opponentCounts[owner] ??= {});
        counts[taken.pos] = (counts[taken.pos] ?? 0) + 1;
        replayed.push({ ...pick, playerId: taken.id });
      }
    }
  }

  const total = (roster: BoardPlayer[], key: "projPoints" | "vorp") =>
    Math.round(roster.reduce((a, p) => a + p[key], 0));
  console.log(`\nunmatched room picks (not on 2026 board): ${unmatched}`);
  console.log(`\n=== slot ${mySlot}, strategy "${strategyId}" ===`);
  console.log(`engine roster: ${total(engineRoster, "projPoints")} proj pts, ${total(engineRoster, "vorp")} VORP`);
  for (const p of engineRoster) console.log(`   ${p.pos.padEnd(3)} ${p.name}`);
  console.log(`actual roster: ${total(actualRoster, "projPoints")} proj pts, ${total(actualRoster, "vorp")} VORP`);
  for (const p of actualRoster) console.log(`   ${p.pos.padEnd(3)} ${p.name}`);
}

main().catch((err) => {
  console.error("BACKTEST FAILED:", err);
  process.exit(1);
});
