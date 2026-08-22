// The recommendation engine's front door. Pure — zero I/O, deterministic
// given the seed, so it unit-tests and backtests offline.

import type {
  BoardPlayer,
  EngineOutput,
  EngineState,
  Position,
  Recommendation,
  Strategy,
} from "../types";
import { survivalProb } from "./survival";
import { vona } from "./vona";
import { simulateAll, type SimShared, type SimCandidate, type SimPlayer } from "./montecarlo";
import { buildReason } from "./reasons";
import { slotOnClock, pickOwner } from "../draft/snake";

const MC_ITERATIONS = 400;
const MC_CANDIDATES = 12;
/** Value-points penalty per pick of reach past ADP, at adpDiscipline = 1. */
const REACH_PENALTY_PER_PICK = 1.0;
/** Soft penalty when a candidate shares a bye with a same-position starter. */
const BYE_COLLISION_PENALTY = 4;

export function positionMultiplier(strategy: Strategy, pos: Position, round: number): number {
  for (const [range, mults] of Object.entries(strategy.positionMultipliers)) {
    const [lo, hi] = range.split("-").map(Number);
    if (round >= lo && round <= (hi || lo)) return mults[pos] ?? 1;
  }
  return 1;
}

/** Diminishing-returns weight for MY roster at a position. */
export function needWeight(
  pos: Position,
  counts: Partial<Record<Position, number>>,
  state: Pick<EngineState, "config">
): number {
  const { rosterSlots, flexEligible } = state.config;
  const have = counts[pos] ?? 0;
  const starters = rosterSlots[pos] ?? 0;
  if (have < starters) return 1;
  if (pos === "K" || pos === "DST") return have >= 1 ? 0 : 1;
  // Flex capacity: how many flex slots are still unclaimed by surplus players?
  const flexSlots = rosterSlots.FLEX ?? 0;
  const surplus = flexEligible.reduce(
    (a, fp) => a + Math.max(0, (counts[fp] ?? 0) - (rosterSlots[fp] ?? 0)),
    0
  );
  if (flexEligible.includes(pos) && surplus < flexSlots) return 0.85;
  // Bench depth
  const depth = have - starters - (flexEligible.includes(pos) ? 1 : 0);
  const benchBase = pos === "RB" || pos === "WR" ? 0.55 : 0.3;
  return benchBase * Math.pow(0.6, Math.max(0, depth));
}

function blendedValue(p: BoardPlayer, strategy: Strategy): number {
  return strategy.baselineBlend * p.vorp + (1 - strategy.baselineBlend) * p.vols;
}

interface Scored {
  player: BoardPlayer;
  quickScore: number;
  baseValue: number; // need-and-multiplier-weighted value in sim units
}

function quickScoreAll(
  available: BoardPlayer[],
  state: EngineState,
  strategy: Strategy,
  myCounts: Partial<Record<Position, number>>,
  round: number
): Scored[] {
  const { currentPick } = state;
  return available.map((p) => {
    const mult = positionMultiplier(strategy, p.pos, round);
    const need = needWeight(p.pos, myCounts, state);
    const base = blendedValue(p, strategy) * mult * need;
    const reach = Math.max(0, p.adp - currentPick - 3); // small free slack
    const byeClash = state.myRoster.some(
      (r) => r.pos === p.pos && r.bye != null && r.bye === p.bye
    );
    const quickScore =
      base -
      strategy.adpDiscipline * REACH_PENALTY_PER_PICK * reach -
      (byeClash ? BYE_COLLISION_PENALTY : 0);
    return { player: p, quickScore, baseValue: base };
  });
}

function hardFilter(
  available: BoardPlayer[],
  state: EngineState,
  myCounts: Partial<Record<Position, number>>,
  round: number
): BoardPlayer[] {
  const { config, strategy, myPicks } = state;
  const lastTwoRounds = round > config.rounds - 2;

  // If my remaining picks are only enough to fill required starting slots,
  // recommend nothing but those positions.
  const required: Position[] = [];
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const missing = (config.rosterSlots[pos] ?? 0) - (myCounts[pos] ?? 0);
    for (let i = 0; i < missing; i++) required.push(pos);
  }
  const mustFill = myPicks.length <= required.length;

  return available.filter((p) => {
    if (mustFill && !required.includes(p.pos)) return false;
    if ((p.pos === "K" || p.pos === "DST") && !lastTwoRounds) return false;
    if (
      p.pos === "QB" &&
      (config.rosterSlots.QB ?? 0) <= 1 &&
      (myCounts.QB ?? 0) >= 1 &&
      round < 12
    )
      return false;
    const cap = strategy.positionCaps[p.pos];
    if (cap != null && (myCounts[p.pos] ?? 0) >= cap) return false;
    return true;
  });
}

export function recommend(state: EngineState, seed = 42): EngineOutput {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { board, draftedIds, config, strategy, currentPick, myPicks, drift } = state;

  const available = board.filter((p) => !draftedIds.has(p.id));
  const myCounts: Partial<Record<Position, number>> = {};
  for (const p of state.myRoster) myCounts[p.pos] = (myCounts[p.pos] ?? 0) + 1;
  const round = slotOnClock(currentPick, config.teams).round;

  const pool = hardFilter(available, state, myCounts, round);
  const scored = quickScoreAll(pool, state, strategy, myCounts, round).sort(
    (a, b) => b.quickScore - a.quickScore
  );
  const candidates = scored.slice(0, MC_CANDIDATES);

  const nextPick = myPicks.find((n) => n > currentPick) ?? currentPick + 2 * config.teams;
  const horizon = myPicks.filter((n) => n > currentPick).slice(0, 2);
  const simEnd = horizon[horizon.length - 1] ?? currentPick;

  // Shared sim scaffolding: one player pool + sampled drafts for all candidates.
  const schedule: SimShared["schedule"] = [];
  for (let n = currentPick + 1; n <= simEnd; n++) {
    const owner = pickOwner(n, config.teams, []);
    schedule.push({ pickNo: n, slot: owner, mine: horizon.includes(n) });
  }
  const poolSorted = [...available].sort((a, b) => a.adp - b.adp).slice(0, 160);
  const indexById = new Map(poolSorted.map((p, i) => [p.id, i]));
  const simPlayers: SimPlayer[] = poolSorted.map((a) => ({
    pos: a.pos,
    adp: a.adp + (drift[a.pos] ?? 0),
    stdev: a.adpStdev,
    value: Math.max(0, blendedValue(a, strategy)),
  }));
  const nextRound = slotOnClock(nextPick, config.teams).round;
  const myPosWeight = (pos: Position, counts: Partial<Record<Position, number>>) =>
    positionMultiplier(strategy, pos, nextRound) * needWeight(pos, counts, state);

  const simCandidates: SimCandidate[] = candidates.map((c) => ({
    playerIndex: indexById.get(c.player.id) ?? -1,
    myCounts: { ...myCounts, [c.player.pos]: (myCounts[c.player.pos] ?? 0) + 1 },
    myPosWeight,
  }));
  const shared: SimShared = {
    players: simPlayers,
    opponentCounts: state.opponentCounts ?? {},
    schedule,
    teams: config.teams,
    rounds: config.rounds,
  };
  const sims = simulateAll(shared, simCandidates, MC_ITERATIONS, seed);

  const recommendations: Recommendation[] = candidates.map((c, ci) => {
    const p = c.player;
    const sim = sims[ci];
    const survival = survivalProb(p, nextPick, drift);
    const v = vona(p, available, nextPick, drift);
    const score = c.baseValue + sim.mean - strategy.lambda * sim.stdev;
    return {
      player: p,
      reason: "",
      score,
      vona: v,
      survivalToNextPick: survival,
      simMean: sim.mean,
      simStdev: sim.stdev,
    };
  });

  recommendations.sort((a, b) => b.score - a.score);
  const top = recommendations.slice(0, 3);
  for (const rec of top) {
    rec.reason = buildReason(rec, available, nextPick);
  }

  const strategyWarning = checkStrategyViability(state, scored, round, myCounts);
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { recommendations: top, strategyWarning, computeMs: t1 - t0 };
}

/**
 * If the strategy's multipliers are fighting the board hard (its top pick's
 * UNWEIGHTED value trails the neutral top pick badly), say so — don't
 * silently override.
 */
function checkStrategyViability(
  state: EngineState,
  scored: Scored[],
  round: number,
  myCounts: Partial<Record<Position, number>>
): string | null {
  if (scored.length < 2 || round > 9) return null;
  const { strategy } = state;
  const top = scored[0];
  const neutral: Strategy = { ...strategy, positionMultipliers: {} };
  const neutralScored = quickScoreAll(
    scored.map((s) => s.player),
    state,
    neutral,
    myCounts,
    round
  ).sort((a, b) => b.quickScore - a.quickScore);
  const nTop = neutralScored[0];
  if (nTop.player.id === top.player.id) return null;
  const strategyValueOfNeutralTop = neutralScored.find((s) => s.player.id === top.player.id);
  if (!strategyValueOfNeutralTop) return null;
  const gap = nTop.quickScore - strategyValueOfNeutralTop.quickScore;
  if (gap > 0.25 * Math.abs(nTop.quickScore) && gap > 12) {
    return `${strategy.label} is fighting the board — ${nTop.player.name} (${nTop.player.pos}) is worth ${Math.round(gap)} more points than your strategy's pick. Consider switching to Balanced.`;
  }
  return null;
}
