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
import { buildReason, buildAlternateReason } from "./reasons";
import { slotOnClock, pickOwner } from "../draft/snake";

const MC_ITERATIONS = 400;
const MC_CANDIDATES = 12;
/** Value-points penalty per pick of reach past ADP, at adpDiscipline = 1. */
const REACH_PENALTY_PER_PICK = 1.0;
/** Soft penalty when a candidate shares a bye with a same-position starter. */
const BYE_COLLISION_PENALTY = 4;
/**
 * Escalating penalty for piling roster onto one bye week, indexed by how many
 * rostered players already share the candidate's bye. Two is life, five is a
 * forfeited week — especially in best ball, where that week's optimal lineup
 * simply craters.
 */
const BYE_STACK_PENALTY = [0, 1, 3, 7, 12, 18];
/** Value-points bonus for a QB↔pass-catcher stack, at stacking = 1. */
const STACK_BONUS = 8;
/** Late-round bonus for the direct backup of an RB I already roster. */
const HANDCUFF_BONUS = 6;
/** Injuries that remove a player from recommendations entirely. */
const INJURY_EXCLUDE = new Set(["IR", "PUP", "Sus", "NA", "COV", "DNR"]);
/** Soft projected-value multiplier by draft-day injury status. */
const INJURY_PENALTY: Record<string, number> = { Out: 0.75, Doubtful: 0.85, Questionable: 0.97 };

/**
 * Best-ball roster-construction targets as fractions of total rounds:
 * [min, max] share of the roster a position should occupy. For 18 rounds
 * this yields roughly QB 2–3, RB 5–6, WR 7–9, TE 2–3 — standard
 * tournament construction.
 */
export const BESTBALL_TARGETS: Partial<Record<Position, [number, number]>> = {
  QB: [0.11, 0.17],
  RB: [0.26, 0.34],
  WR: [0.36, 0.48],
  TE: [0.11, 0.17],
  K: [0.0, 0.06],
  DST: [0.0, 0.06],
};

/**
 * Best-ball positional value adjustment. Season-total projections understate
 * WRs in best ball: weekly spike scoring is the format, and WR spike weeks
 * are what the optimal-lineup math harvests. Tuned toward published
 * WR-heavy-builds-win tournament findings.
 */
export const BESTBALL_POS_VALUE: Record<Position, number> = {
  QB: 1.0,
  RB: 0.9,
  WR: 1.18,
  TE: 1.02,
  K: 1,
  DST: 1,
};

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
  const { rosterSlots, flexEligible, leagueType, rounds } = state.config;
  const have = counts[pos] ?? 0;
  const starters = rosterSlots[pos] ?? 0;

  // Positions the league doesn't roster at all (best-ball formats usually
  // drop K/DST) are worth nothing.
  if ((pos === "K" || pos === "DST") && starters === 0) return 0;

  if (leagueType === "bestball") {
    // No waivers, no lineup management: chase position-count targets, not
    // starter slots. Depth IS the lineup.
    const [minF, maxF] = BESTBALL_TARGETS[pos] ?? [0, 0.1];
    const minT = Math.max(starters, Math.round(minF * rounds));
    const maxT = Math.max(minT, Math.round(maxF * rounds));
    if (have < minT) return 1;
    if (have < maxT) return 0.72;
    return 0.12 * Math.pow(0.6, have - maxT);
  }

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

/** Value-points swing for schedule strength, full range (0 → 1 easiness). */
const SOS_SEASON_WEIGHT = 5;
/**
 * Weeks 15-17 get their own, larger weight: they're the fantasy playoffs in
 * redraft and the advancement weeks in best-ball tournaments.
 */
const SOS_PLAYOFF_WEIGHT = { redraft: 6, bestball: 10 };

function sosAdjust(p: BoardPlayer, bestball: boolean): number {
  let adj = 0;
  if (p.sosSeason != null) adj += (p.sosSeason - 0.5) * SOS_SEASON_WEIGHT;
  if (p.sosPlayoff != null)
    adj += (p.sosPlayoff - 0.5) * SOS_PLAYOFF_WEIGHT[bestball ? "bestball" : "redraft"];
  return adj;
}

/**
 * Build the value function for this draft.
 *
 * Redraft: the VORP/VOLS blend.
 *
 * Best ball: season-total VORP is structurally broken here — a 12-round
 * bench pushes the RB replacement baseline to ~RB67 and inflates every RB,
 * while the format's actual scoring (weekly spikes harvested by the optimal
 * lineup) never appears in season totals. So value anchors mostly to the
 * MARKET: a smoothed ADP-implied value curve (what a typical player at this
 * ADP is worth), lightly blended with projections and a positional spike
 * premium. Construction then comes from targets, stacks, and fallers —
 * which is how winning best-ball drafters actually operate.
 */
function makeValueFn(
  board: BoardPlayer[],
  strategy: Strategy,
  bestball: boolean
): (p: BoardPlayer) => number {
  if (!bestball) return (p) => blendedValue(p, strategy) + sosAdjust(p, false);

  // Smoothed blended value by ADP order — the market curve.
  const byAdp = [...board].sort((a, b) => a.adp - b.adp);
  const smoothed = new Map<string, number>();
  const W = 7; // smoothing half-window
  for (let i = 0; i < byAdp.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(byAdp.length - 1, i + W); j++) {
      sum += blendedValue(byAdp[j], strategy);
      n++;
    }
    smoothed.set(byAdp[i].id, sum / n);
  }
  const PROJ_WEIGHT = 0.35; // how much projections pull against the market
  return (p) => {
    const market = smoothed.get(p.id) ?? 0;
    const proj = blendedValue(p, strategy);
    return (
      (market * (1 - PROJ_WEIGHT) + proj * PROJ_WEIGHT) * BESTBALL_POS_VALUE[p.pos] +
      sosAdjust(p, true)
    );
  };
}

/**
 * Apply a need weight sign-aware: positive value shrinks toward zero as the
 * position saturates, but NEGATIVE value must grow more negative — otherwise
 * a surplus position's bad players outrank a needed position's mediocre ones
 * (−30 × 0.02 beats −40 × 1.0) and late rounds hoard the wrong position.
 */
function applyNeed(value: number, need: number): number {
  return value >= 0 ? value * need : value * (2 - need);
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
  round: number,
  valueFn: (p: BoardPlayer) => number
): Scored[] {
  const { currentPick } = state;
  const stacking = strategy.stacking ?? 0;
  const lateRounds = round >= state.config.rounds - 6;

  // Unfilled-floor urgency: as spare picks shrink, positions still under
  // their construction floor get escalating priority — a roster must never
  // drift toward an empty required slot.
  const { missing, unmet } = shortfalls(state, myCounts);
  const slack = state.myPicks.length - unmet;
  const urgencyOf = (pos: Position): number => {
    if (!missing[pos] || slack >= URGENCY_BY_SLACK.length) return 1;
    return URGENCY_BY_SLACK[Math.max(0, slack)];
  };

  const byeCounts: Record<number, number> = {};
  for (const r of state.myRoster) {
    if (r.bye != null) byeCounts[r.bye] = (byeCounts[r.bye] ?? 0) + 1;
  }
  return available.map((p) => {
    const mult = positionMultiplier(strategy, p.pos, round);
    const need = needWeight(p.pos, myCounts, state);
    const injuryMult = p.injury ? INJURY_PENALTY[p.injury] ?? 1 : 1;
    let base = applyNeed(valueFn(p) * mult * injuryMult, need);
    const urg = urgencyOf(p.pos);
    if (urg > 1) {
      // Multiplicative when the player has value, additive floor so a weak
      // late-round TE still beats yet another surplus WR.
      base = (base > 0 ? base * urg : base) + (urg - 1) * 15;
    }

    // Stacking: QB + his own pass-catchers → correlated ceiling.
    if (stacking > 0) {
      const stacksWith = (a: BoardPlayer, b: BoardPlayer) =>
        a.team === b.team &&
        ((a.pos === "QB" && (b.pos === "WR" || b.pos === "TE")) ||
          (b.pos === "QB" && (a.pos === "WR" || a.pos === "TE")));
      if (state.myRoster.some((r) => stacksWith(p, r))) base += stacking * STACK_BONUS;
    }

    // Handcuff: late rounds, the direct backup of an RB I already roster.
    if (
      lateRounds &&
      p.pos === "RB" &&
      (p.depthOrder ?? 1) >= 2 &&
      state.myRoster.some((r) => r.pos === "RB" && r.team === p.team && (r.depthOrder ?? 2) === 1)
    ) {
      base += HANDCUFF_BONUS;
    }

    const reach = Math.max(0, p.adp - currentPick - 3); // small free slack
    // Bye congestion: same-position clash empties a lineup slot that week;
    // roster-wide pile-ups forfeit the whole week.
    const samePosClash = state.myRoster.some(
      (r) => r.pos === p.pos && r.bye != null && r.bye === p.bye
    );
    const sameBye = p.bye != null ? byeCounts[p.bye] ?? 0 : 0;
    const byePenalty =
      BYE_STACK_PENALTY[Math.min(sameBye, BYE_STACK_PENALTY.length - 1)] +
      (samePosClash ? BYE_COLLISION_PENALTY : 0);
    const quickScore =
      base - strategy.adpDiscipline * REACH_PENALTY_PER_PICK * reach - byePenalty;
    return { player: p, quickScore, baseValue: base };
  });
}

/**
 * Construction floors: how many players at each position a roster NEEDS
 * before anything else is a luxury. Redraft: the starting lineup. Best ball:
 * the minimum count targets — a best-ball roster with zero TEs scores a
 * guaranteed 0 in that slot every week; the floor makes that impossible.
 */
export function requiredFloor(
  pos: Position,
  config: EngineState["config"]
): number {
  const starters = config.rosterSlots[pos] ?? 0;
  if (config.leagueType !== "bestball") return starters;
  if (starters === 0) return 0; // formats without K/DST need none
  const minF = BESTBALL_TARGETS[pos]?.[0] ?? 0;
  return Math.max(starters, Math.round(minF * config.rounds));
}

/** Per-position shortfall vs the floor, plus total unmet count. */
function shortfalls(
  state: EngineState,
  myCounts: Partial<Record<Position, number>>
): { missing: Partial<Record<Position, number>>; unmet: number } {
  const missing: Partial<Record<Position, number>> = {};
  let unmet = 0;
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const m = Math.max(0, requiredFloor(pos, state.config) - (myCounts[pos] ?? 0));
    if (m > 0) missing[pos] = m;
    unmet += m;
  }
  return { missing, unmet };
}

/** Escalating urgency multiplier as spare picks run out, by slack. */
const URGENCY_BY_SLACK = [2.5, 2.0, 1.6, 1.3, 1.12];

function hardFilter(
  available: BoardPlayer[],
  state: EngineState,
  myCounts: Partial<Record<Position, number>>,
  round: number
): BoardPlayer[] {
  const { config, strategy, myPicks } = state;
  const bestball = config.leagueType === "bestball";
  const lastTwoRounds = round > config.rounds - 2;

  // If my remaining picks are only enough to fill the construction floors,
  // recommend nothing but the unmet positions.
  const { missing, unmet } = shortfalls(state, myCounts);
  const required = Object.keys(missing) as Position[];
  const mustFill = myPicks.length <= unmet;

  const qbSlots = config.rosterSlots.QB ?? 0;
  return available.filter((p) => {
    // Players stashed on season-long lists are dead weight in any format.
    if (p.injury && INJURY_EXCLUDE.has(p.injury)) return false;
    // Positions this league doesn't roster (best-ball formats drop K/DST).
    if ((config.rosterSlots[p.pos] ?? 0) === 0 && (p.pos === "K" || p.pos === "DST")) return false;
    if (mustFill && !required.includes(p.pos)) return false;
    if (
      !mustFill &&
      (p.pos === "K" || p.pos === "DST") &&
      (config.rosterSlots[p.pos] ?? 0) > 0 &&
      !lastTwoRounds
    )
      return false;
    const cap = strategy.positionCaps[p.pos];
    if (cap != null && (myCounts[p.pos] ?? 0) >= cap) return false;

    // ---- Football-sense pacing rules ------------------------------------
    // Round windows every competent human drafter follows. When the value
    // math wants to break one of these, the math is wrong, not the rule.
    // Skipped under mustFill: filling a required slot always wins.
    if (!mustFill) {
      // No QB in the first two rounds of any 1-QB format. Ever.
      if (p.pos === "QB" && qbSlots <= 1 && round <= 2) return false;
      if (bestball) {
        // Best ball wants 2-3 QBs and 2-3 TEs — but SPACED, not hoarded.
        if (p.pos === "QB" && (myCounts.QB ?? 0) >= 1 && round < 6) return false;
        if (p.pos === "QB" && (myCounts.QB ?? 0) >= 2 && round < 10) return false;
        if (p.pos === "TE" && (myCounts.TE ?? 0) >= 1 && round < 6) return false;
        if (p.pos === "TE" && (myCounts.TE ?? 0) >= 2 && round < 10) return false;
      } else {
        // Redraft: a second QB or TE is a bench statue before the late rounds.
        if (p.pos === "QB" && qbSlots <= 1 && (myCounts.QB ?? 0) >= 1 && round < 12) return false;
        if (p.pos === "TE" && (config.rosterSlots.TE ?? 0) <= 1 && (myCounts.TE ?? 0) >= 1 && round < 10)
          return false;
      }
    }
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

  const bestball = config.leagueType === "bestball";
  const valueFn = makeValueFn(board, strategy, bestball);
  const pool = hardFilter(available, state, myCounts, round);
  const scored = quickScoreAll(pool, state, strategy, myCounts, round, valueFn).sort(
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
    value: Math.max(0, valueFn(a)),
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
  if (top[0]) top[0].reason = buildReason(top[0], available, nextPick);
  for (const rec of top.slice(1)) {
    // Alternates explain why you might take them INSTEAD — comparative.
    rec.reason = buildAlternateReason(rec, top[0], nextPick);
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
    round,
    makeValueFn(state.board, neutral, state.config.leagueType === "bestball")
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
