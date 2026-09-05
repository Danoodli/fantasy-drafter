// Survival calibration: does P(available at pick n) match what real rooms do?
//
//   pnpm calibrate:survival <draft_id> [<draft_id> ...] [--scoring=ppr] [--year=2025]
//
// For every real Sleeper draft given, every pick n, and every player near the
// board at that point, the model predicts P(still available at n) and reality
// says yes/no. The script scores a grid of tail settings (config/survival.json's
// tailScale × wideShare) by Brier score and log loss, prints a reliability
// table for the current setting, and suggests the best. It also reports how
// the humans in these rooms actually pick — how often the top-ADP player goes,
// how far they reach — which is what the simulated opponents assume.
//
// The board's ADP must be from the draft's season: current boards for this
// season's drafts, `--year=YYYY` (season snapshot FFC) for older ones.
// Read-only, free API, no keys. Nothing is written unless --write is passed.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchDraftInfo, fetchPicks } from "../lib/draft/sleeper";
import { computeDrift } from "../lib/engine/drift";
import { survivalProb, DEFAULT_TAIL, type SurvivalTail } from "../lib/engine/survival";
import { mergeName } from "../lib/etl/names";
import type { Board, BoardPlayer, DraftPick, Position, ScoringFormat } from "../lib/types";
import type { SeasonSnapshot } from "../lib/etl/seasonSnapshot";

interface Sample {
  predicted: number; // under a given tail
  available: 0 | 1;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function loadBoard(scoring: ScoringFormat, year?: number): BoardPlayer[] {
  if (!year) {
    const board: Board = JSON.parse(readFileSync(join(process.cwd(), "public", "data", `board-${scoring}.json`), "utf8"));
    return board.players;
  }
  const snap: SeasonSnapshot = JSON.parse(readFileSync(join(process.cwd(), "data", "raw", "seasons", `${year}.json`), "utf8"));
  const ffc = snap.ffc[scoring] ?? Object.values(snap.ffc)[0];
  if (!ffc) throw new Error(`no FFC ADP in the ${year} snapshot`);
  // Only the ADP fields matter here; everything else is filler.
  return ffc.players.map((p) => ({
    id: `ffc-${p.player_id}`,
    name: p.name,
    pos: (p.position === "PK" ? "K" : p.position === "DEF" ? "DST" : p.position) as Position,
    team: p.team,
    bye: p.bye ?? null,
    projPoints: 0,
    projImputed: true,
    stats: null,
    adp: p.adp,
    adpStdev: p.stdev,
    adpHigh: p.high,
    adpLow: p.low,
    ecr: null,
    ecrStdev: null,
    vorp: 0,
    vols: 0,
    tier: 0,
    injury: null,
    depthOrder: null,
    sosSeason: null,
    sosPlayoff: null,
    statsSleeper: null,
    news: null,
    adpSources: { ffc: p.adp },
    ids: { ffc: String(p.player_id) },
    adpTrend: null,
  })) as unknown as BoardPlayer[];
}

function brier(samples: Sample[]): number {
  return samples.reduce((s, x) => s + (x.predicted - x.available) ** 2, 0) / samples.length;
}
function logLoss(samples: Sample[]): number {
  const eps = 1e-4;
  return (
    -samples.reduce((s, x) => {
      const p = Math.min(1 - eps, Math.max(eps, x.predicted));
      return s + (x.available ? Math.log(p) : Math.log(1 - p));
    }, 0) / samples.length
  );
}

function reliability(samples: Sample[]): string {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, pred: 0, obs: 0 }));
  for (const s of samples) {
    const b = Math.min(9, Math.floor(s.predicted * 10));
    bins[b].n++;
    bins[b].pred += s.predicted;
    bins[b].obs += s.available;
  }
  const rows = bins
    .map((b, i) =>
      b.n === 0
        ? null
        : `  ${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}  n=${String(b.n).padStart(6)}  predicted ${(b.pred / b.n).toFixed(3)}  observed ${(b.obs / b.n).toFixed(3)}  ${b.obs / b.n > b.pred / b.n + 0.03 ? "← players survive MORE than modeled" : b.obs / b.n < b.pred / b.n - 0.03 ? "← players go EARLIER than modeled" : ""}`
    )
    .filter(Boolean);
  return rows.join("\n");
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (ids.length === 0) {
    console.error("usage: pnpm calibrate:survival <draft_id> [...] [--scoring=ppr] [--year=2025] [--write]");
    process.exit(1);
  }
  const scoring = (arg("scoring") ?? "ppr") as ScoringFormat;
  const year = arg("year") ? Number(arg("year")) : undefined;
  const players = loadBoard(scoring, year);
  const byId = new Map(players.map((p) => [p.id, p]));
  const byName = new Map<string, BoardPlayer[]>();
  for (const p of players) {
    const k = mergeName(p.name);
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  const resolve = (pick: DraftPick): BoardPlayer | undefined =>
    byId.get(pick.playerId) ?? (byName.get(mergeName(pick.playerName)) ?? []).find((c) => !pick.pos || c.pos === pick.pos);

  const grid: SurvivalTail[] = [];
  for (const tailScale of [0.8, 1, 1.2, 1.5, 2])
    for (const wideShare of [0, 0.15, 0.3]) grid.push({ tailScale, wideShare, wideFactor: 2.5 });

  const samplesByTail = new Map<string, Sample[]>(grid.map((t) => [JSON.stringify(t), []]));
  const samplesLive = new Map<string, Sample[]>(grid.map((t) => [JSON.stringify(t), []]));
  let picksSeen = 0, matched = 0, topAdp = 0, top3 = 0, top10 = 0;
  const reaches: number[] = [];

  for (const draftId of ids) {
    const info = await fetchDraftInfo(draftId);
    const picks = await fetchPicks(draftId, null);
    console.log(`draft ${draftId}: ${info.teams}×${info.rounds}, season ${info.season ?? "?"}, ${picks.length} picks${info.bestBall ? ", best ball" : ""}`);
    if (!year && info.season && String(new Date().getFullYear()) !== info.season)
      console.log(`  ⚠ draft is from ${info.season} but the board's ADP is current — pass --year=${info.season}`);
    const taken = new Set<string>();
    const resolvedPicks: DraftPick[] = [];
    for (const pick of picks.sort((a, b) => a.pickNo - b.pickNo)) {
      const n = pick.pickNo;
      const player = resolve(pick);
      picksSeen++;
      // Candidates: everyone still available whose ADP is within a window of this pick.
      const cands = players.filter((p) => !taken.has(p.id) && Math.abs(p.adp - n) <= 45);
      const drift = computeDrift(resolvedPicks, byId);
      for (const t of grid) {
        const key = JSON.stringify(t);
        const raw = samplesByTail.get(key)!;
        const live = samplesLive.get(key)!;
        for (const c of cands) {
          // "Available at pick n" means not taken by picks 1..n-1. The player
          // taken AT n was available at n.
          const avail: 0 | 1 = 1;
          void avail;
          raw.push({ predicted: survivalProb(c, n, {}, t), available: 1 });
          live.push({ predicted: survivalProb(c, n, drift, t), available: 1 });
        }
      }
      // The negative samples: players taken before n were NOT available at n.
      // Rather than enumerate every (taken player, later pick) pair — which
      // would swamp the positives — score each taken player once at the pick
      // right after he went and at his own ADP+10 (where the model still
      // gives him real survival mass).
      if (player) {
        matched++;
        const available = players.filter((p) => !taken.has(p.id)).sort((a, b) => a.adp - b.adp);
        const rank = available.findIndex((p) => p.id === player.id);
        if (rank === 0) topAdp++;
        if (rank >= 0 && rank < 3) top3++;
        if (rank >= 0 && rank < 10) top10++;
        reaches.push(n - player.adp);
        for (const t of grid) {
          const key = JSON.stringify(t);
          for (const at of [n + 1, Math.round(player.adp) + 10, Math.round(player.adp) + 25]) {
            if (at <= n) continue;
            samplesByTail.get(key)!.push({ predicted: survivalProb(player, at, {}, t), available: 0 });
            samplesLive.get(key)!.push({ predicted: survivalProb(player, at, drift, t), available: 0 });
          }
        }
        taken.add(player.id);
        resolvedPicks.push({ ...pick, playerId: player.id });
      }
    }
  }

  console.log(`\n${picksSeen} picks, ${matched} matched to the board.`);
  console.log(`Humans vs ADP: took the top-ADP player ${((100 * topAdp) / matched).toFixed(0)}% of the time, a top-3 ${((100 * top3) / matched).toFixed(0)}%, a top-10 ${((100 * top10) / matched).toFixed(0)}%.`);
  const sorted = [...reaches].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  console.log(`Reach (pick − ADP): median ${q(0.5).toFixed(1)}, p10 ${q(0.1).toFixed(1)} (reaches), p90 ${q(0.9).toFixed(1)} (falls).`);

  const current = JSON.stringify(DEFAULT_TAIL);
  console.log(`\nCalibration grid (lower is better). Current setting: tailScale ${DEFAULT_TAIL.tailScale}, wideShare ${DEFAULT_TAIL.wideShare}`);
  console.log("  tailScale  wideShare   Brier(raw)  logloss(raw)   Brier(live drift)  logloss(live)");
  let best: { t: SurvivalTail; ll: number } | null = null;
  for (const t of grid) {
    const key = JSON.stringify(t);
    const raw = samplesByTail.get(key)!;
    const live = samplesLive.get(key)!;
    const ll = logLoss(live);
    if (!best || ll < best.ll) best = { t, ll };
    console.log(
      `  ${String(t.tailScale).padEnd(9)}  ${String(t.wideShare).padEnd(9)}   ${brier(raw).toFixed(4)}      ${logLoss(raw).toFixed(4)}         ${brier(live).toFixed(4)}             ${ll.toFixed(4)}${key === current ? "   ← current" : ""}`
    );
  }
  console.log(`\nReliability at the current setting (live drift):\n${reliability(samplesLive.get(current)!)}`);
  const currentLl = logLoss(samplesLive.get(current)!);
  if (best && best.ll < currentLl - 0.002) {
    console.log(`\nBest: tailScale ${best.t.tailScale}, wideShare ${best.t.wideShare} (log loss ${best.ll.toFixed(4)} vs ${currentLl.toFixed(4)} now).`);
    if (process.argv.includes("--write")) {
      const path = join(process.cwd(), "config", "survival.json");
      const json = JSON.parse(readFileSync(path, "utf8"));
      json.tailScale = best.t.tailScale;
      json.wideShare = best.t.wideShare;
      json.wideFactor = best.t.wideFactor;
      writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
      console.log(`wrote ${path}. Run pnpm test, then pnpm backtest:gate before trusting it.`);
    } else {
      console.log("Pass --write to store it in config/survival.json (the lever: tailScale 1 + wideShare 0 turns it back off).");
    }
  } else {
    console.log(`\nThe current setting is as good as any on the grid — leave the lever off.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
