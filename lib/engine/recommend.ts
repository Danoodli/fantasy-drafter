// The recommendation engine's front door. Pure — zero I/O, deterministic
// given the seed, so it unit-tests and backtests offline.

import type { BoardPlayer, EngineOutput, EngineState, Position, Recommendation, Strategy, LeagueConfig } from "../types";
import { survivalProb } from "./survival";
import { vona, expectedBestAtPick } from "./vona";
import { coverageValue, REG_SEASON_WEEKS, coverageSlotWeeks } from "./coverage";
import outcomeJson from "../../config/outcome-model.json";
import type { OutcomeParams } from "./outcomeModel";
import { expectedWeekly, reliabilityShrunkProjection } from "./outcome";
import { evaluateCompletions, marginalGainNow, positionGainTable, WAIVER_FRICTION, type WaiverLine } from "./rosterValue";
import { completeRosters, type CompletionPlayer, type CompletionShared } from "./completion";
import { FLEX_SHARE } from "./baselines";
import { simulateAll, type SimShared, type SimCandidate, type SimPlayer } from "./montecarlo";
import { buildReason, buildAlternateReason } from "./reasons";
import { slotOnClock, pickOwner } from "../draft/snake";

const MC_ITERATIONS = 400;
const MC_CANDIDATES = 12;
/** Unified model: candidates scored by full roster completion. */
const UNIFIED_SHORTLIST = 10;
/** Once this few picks remain, candidates sit within a few points of each other; a smaller shortlist keeps latency flat. */
const UNIFIED_SHORTLIST_LATE = 6;
const LATE_PICKS = 6;
/**
 * Iterations at the start of a draft. The budget grows as picks run out, but
 * evaluation cost per iteration is roughly constant (sampling + 17 lineups per
 * candidate), so the growth is capped at 2× to hold the 50 ms budget at every pick.
 */
const UNIFIED_ITERATIONS = 80;
const UNIFIED_ITERATIONS_MAX = 120;
/**
 * When the top two scores sit inside this many standard errors of their paired
 * difference, re-run the top few with more iterations — only once the draft is
 * past halfway, where completions are cheap and margins are small.
 */
const REFINE_SE = 1.0;
const REFINE_TOP = 2;
const REFINE_MULT = 2;
const REFINE_MAX_FUTURE = 8;
/** The closed-form EV proxy is computed for this many table-ranked players only. */
const UNIFIED_EV_SCAN = 40;
const DEFAULT_OUTCOME = outcomeJson as OutcomeParams;
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
/** needWeight at or above this means the player fills a starting or flex slot. */
const STARTER_NEED_MIN = 0.85;
/**
 * "lineup" value model: share of a starter's value that comes from VONA
 * (board-adaptive: what taking him now adds over waiting for my next pick)
 * versus VOLS (absolute quality against the league's last starter). Pure VONA
 * is myopic — with a one-pick horizon a TE1 looks like an RB1.
 */
const LINEUP_VONA_WEIGHT = 0.5;
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

/**
 * Redraft construction floors: bodies per position needed to cover byes and
 * one injury, beyond the starting lineup. The coverage math in
 * ./coverage.ts should make these rarely bind — they are the backstop that
 * guarantees a roster can field its own lineup in week 6. TE/K/DST are
 * exempt; a second TE is a luxury the bye math can still argue for on its own.
 */
export const REDRAFT_FLOORS: Partial<Record<Position, number>> = { QB: 2, RB: 3, WR: 3 };

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
  // A surplus body only claims the FLEX as often as his position realistically
  // does (FLEX_SHARE: RB/WR 0.45, TE 0.10). Treating every flex-eligible 2nd
  // TE as a 0.85 starter made the engine draft exactly 2 TE in 288 of 288
  // backtest seats — the TE cap, not a choice. Below the starter threshold
  // the player is valued as bench insurance instead.
  if (flexEligible.includes(pos) && surplus < flexSlots) {
    const share = FLEX_SHARE[pos] ?? 0;
    const maxShare = Math.max(...flexEligible.map((fp) => FLEX_SHARE[fp] ?? 0), 1e-9);
    return STARTER_NEED_MIN * (share / maxShare);
  }
  // Bench depth
  const depth = have - starters - (flexEligible.includes(pos) ? 1 : 0);
  const benchBase = pos === "RB" || pos === "WR" ? BENCH_INSURANCE.skill : BENCH_INSURANCE.other;
  return benchBase * Math.pow(BENCH_INSURANCE.decay, Math.max(0, depth));
}

/**
 * Redraft bench weights. A bench player only scores when a starter at his
 * position misses time, so his value is insurance, not production: roughly
 * P(he starts) x (points over what I'd otherwise plug in).
 *
 * These used to be 0.55 / 0.30 with 0.6 decay. Against RB VORP that runs
 * 2-3x WR VORP, that let a 5th bench RB (0.55 x 110 = 60) outbid a WR3 headed
 * for the FLEX (0.85 x 40 = 34) -- the 2024/2025 season backtests showed
 * "balanced" drafting 6.8 RBs and 2.2 WRs into a 2-RB/2-WR/FLEX lineup, and
 * losing to a plain ADP bot in 2024. First bench spot ~25%, then halving.
 */
export const BENCH_INSURANCE = { skill: 0.25, other: 0.12, decay: 0.4 };

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

/**
 * "lineup" value model (redraft). Measures a player by what he does for MY
 * roster instead of by league-wide scarcity:
 *
 * - A starter (open starting or flex slot) is worth what taking him now adds
 *   over the best I can expect at his position at my next pick (VONA), blended
 *   with his quality against the league's last starter (VOLS). Two players who
 *   would fill the same FLEX slot with the same projection are worth the same,
 *   whatever their positions' replacement levels look like.
 * - A bench player only scores in weeks a starting slot at his position
 *   would otherwise be empty — so his value is the expected slot-weeks he
 *   covers (byes exactly, injuries probabilistically) times his weekly rate.
 *   See ./coverage.ts. Position-neutral: no replacement baseline involved.
 *
 * The blend model priced Javonte Williams (217 proj) 84 value-points above
 * Keenan Allen (213 proj) for the same FLEX slot, because RB58 projects 80 and
 * WR58 projects 161. That is why "balanced" drafted 6.8 RBs and 2.2 WRs.
 */
function makeLineupValueFn(
  available: BoardPlayer[],
  nextPick: number,
  drift: Partial<Record<Position, number>>,
  roster: BoardPlayer[],
  config: LeagueConfig
): (p: BoardPlayer, need: number) => number {
  const expBest = new Map<Position, number>();
  // Waiver level: the best player expected to go UNDRAFTED at each position,
  // as a weekly rate. Redraft insurance is only worth its margin over that —
  // a backup who barely beats the streaming option is not worth a roster spot.
  const lastPick = config.teams * config.rounds;
  const waiverPerWeek = new Map<Position, number>();
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const atPos = available.filter((p) => p.pos === pos);
    expBest.set(pos, atPos.length ? expectedBestAtPick(atPos, nextPick, drift) : 0);
    waiverPerWeek.set(
      pos,
      atPos.length ? expectedBestAtPick(atPos, lastPick + 1, drift) / (REG_SEASON_WEEKS - 1) : 0
    );
  }
  return (p, need) => {
    if (need >= STARTER_NEED_MIN) {
      const vonaNow = p.projPoints - (expBest.get(p.pos) ?? 0);
      return LINEUP_VONA_WEIGHT * vonaNow + (1 - LINEUP_VONA_WEIGHT) * p.vols + sosAdjust(p, false);
    }
    // Bench: the slot-weeks he fills that this roster would leave EMPTY (byes
    // are certain, injuries probabilistic), times his scoring rate. Already
    // has diminishing returns built in, so the caller must not also apply the
    // bench need weight. The first version of this model returned raw VORP
    // here — the steep RB curve made an 8th RB outbid a 3rd WR and produced
    // 7-RB / 2-WR rosters with no bye cover at all.
    return coverageValue(p, roster, config, waiverPerWeek.get(p.pos) ?? 0);
  };
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
  valueFn: (p: BoardPlayer) => number,
  lineupValue?: (p: BoardPlayer, need: number) => number
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
    // Lineup model: starters still take the 0.85/1.0 slot weight; bench value
    // already encodes diminishing returns (coverage), so it is NOT re-weighted.
    let base = lineupValue
      ? lineupValue(p, need) * mult * injuryMult * (need >= STARTER_NEED_MIN ? need : 1)
      : applyNeed(valueFn(p) * mult * injuryMult, need);
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
  if (config.leagueType !== "bestball") {
    // Only when every floor fits: a 10-round draft cannot carry 2 QB / 3 RB /
    // 3 WR plus starters, so it falls back to the lineup itself.
    const all = ["QB", "RB", "WR", "TE", "K", "DST"] as Position[];
    const total = all.reduce(
      (a, q) => a + Math.max(config.rosterSlots[q] ?? 0, REDRAFT_FLOORS[q] ?? 0),
      0
    ) + (config.rosterSlots.FLEX ?? 0);
    if (total > config.rounds) return starters;
    return Math.max(starters, REDRAFT_FLOORS[pos] ?? 0);
  }
  if (starters === 0) return 0; // formats without K/DST need none
  const minF = BESTBALL_TARGETS[pos]?.[0] ?? 0;
  return Math.max(starters, Math.round(minF * config.rounds));
}

/** Per-position shortfall vs the floor, plus total unmet count. */
function shortfalls(
  state: EngineState,
  myCounts: Partial<Record<Position, number>>,
  startersOnly = false
): { missing: Partial<Record<Position, number>>; unmet: number } {
  const missing: Partial<Record<Position, number>> = {};
  let unmet = 0;
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const floor = startersOnly ? (state.config.rosterSlots[pos] ?? 0) : requiredFloor(pos, state.config);
    const m = Math.max(0, floor - (myCounts[pos] ?? 0));
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

  // Must-fill, in two tiers. An empty STARTING slot always outranks a depth
  // floor: with two picks left and K + DST unfilled, the answer is K and DST,
  // not a second QB for bye cover. Only when every starter can still be
  // filled do the depth floors (2 QB / 3 RB / 3 WR) get to force a pick.
  const starters = shortfalls(state, myCounts, true);
  const floors = shortfalls(state, myCounts);
  let required: Position[] = [];
  let mustFill = false;
  if (myPicks.length <= starters.unmet) {
    required = Object.keys(starters.missing) as Position[];
    mustFill = true;
  } else if (myPicks.length <= floors.unmet) {
    required = Object.keys(floors.missing) as Position[];
    mustFill = true;
  }

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

/**
 * Format legality is the only hard constraint in the unified model: no pacing
 * rules, no caps, no floors. A player on a season-long list is not draftable,
 * a position the league does not roster is not draftable, and when the picks
 * I have left equal the STARTING slots I have not filled, I fill them.
 */
function legalPool(available: BoardPlayer[], state: EngineState): BoardPlayer[] {
  const { config, myPicks } = state;
  const counts: Partial<Record<Position, number>> = {};
  for (const p of state.myRoster) counts[p.pos] = (counts[p.pos] ?? 0) + 1;
  let unmetStarters = 0;
  const required: Position[] = [];
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const short = Math.max(0, (config.rosterSlots[pos] ?? 0) - (counts[pos] ?? 0));
    if (short > 0) { unmetStarters += short; required.push(pos); }
  }
  const mustFill = myPicks.length <= unmetStarters;
  return available.filter((p) => {
    if (p.injury && INJURY_EXCLUDE.has(p.injury)) return false;
    if ((config.rosterSlots[p.pos] ?? 0) === 0 && (p.pos === "K" || p.pos === "DST")) return false;
    if (mustFill && !required.includes(p.pos)) return false;
    return true;
  });
}

/**
 * The unified decision model. Score(c) = U(LineupPoints(FinalRoster(c))):
 * complete my roster from the live board (need-aware opponents, greedy me),
 * sample each completed roster's season from the calibrated outcome model,
 * and rank by mean − λ·sd. See docs/superpowers/specs/2026-09-04-unified-decision-model.md.
 */
export function unifiedRecommend(state: EngineState, seed = 42): EngineOutput {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const { board, draftedIds, config, strategy, currentPick, myPicks, drift } = state;
  const params = state.outcome ?? DEFAULT_OUTCOME;
  const bestball = config.leagueType === "bestball";
  const lambda = bestball ? strategy.lambdaBestBall ?? -0.3 : strategy.lambda;
  // Regression to the mean by calibrated reliability (see outcome.ts). Market
  // shrinkage measured no benefit (w = 0) and is not applied.
  const projOf = reliabilityShrunkProjection(board, params);
  const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

  const available = board.filter((p) => !draftedIds.has(p.id));
  const future = myPicks.filter((n) => n > currentPick);
  const legal = legalPool(available, state);
  if (legal.length === 0) return { recommendations: [], strategyWarning: null, computeMs: 0 };

  // Waiver wire (redraft only). A pickup is made on projections, not hindsight,
  // and the wire is contested by eleven other teams: model it as the 3rd-best
  // player BY PROJECTION likely to go undrafted at each position — the same
  // definition the season backtest scores with. Expected weekly points.
  const lastPick = config.teams * config.rounds;
  const waiver: WaiverLine = {};
  if (!bestball) {
    for (const pos of POSITIONS) {
      if ((config.rosterSlots[pos] ?? 0) === 0) continue;
      const atPos = available.filter((p) => p.pos === pos);
      let pool = atPos.filter((p) => survivalProb(p, lastPick + 1, drift) > 0.5);
      // The wire always has someone. When the board runs out before the draft
      // does (FFC lists ~23 kickers for 12 teams), the deepest-ADP players are
      // the ones most likely to be left.
      if (pool.length < 3) {
        const deepest = [...atPos].sort((a, b) => b.adp - a.adp);
        for (const p of deepest) { if (pool.length >= 3) break; if (!pool.includes(p)) pool.push(p); }
      }
      pool = pool.sort((a, b) => projOf(b) - projOf(a));
      const pick = pool[Math.min(2, pool.length - 1)];
      if (pick) waiver[pos] = Math.max(0, expectedWeekly(pick, params, projOf(pick)) - WAIVER_FRICTION);
    }
  }

  // Shortlist: two proxies, because each is blind to something. The closed-form
  // lineup delta sees FLEX upgrades but only BYE cover (in expectation a starter
  // is never "out"); the insurance-aware gain table sees injury cover but
  // approximates FLEX. Take the top of both, plus the best at every position so
  // a cross-position comparison always happens. The completed-roster simulation decides.
  const table = positionGainTable(state.myRoster, params, config, waiver);
  const rateOf = new Map(legal.map((p) => [p.id, expectedWeekly(p, params, projOf(p))]));
  const byTable = [...legal].sort((a, b) => table[b.pos](rateOf.get(b.id)!) - table[a.pos](rateOf.get(a.id)!));
  const evPool = byTable.slice(0, UNIFIED_EV_SCAN);
  const gains = new Map(evPool.map((p) => [p.id, marginalGainNow(p, state.myRoster, params, config, waiver, projOf)]));
  const byEv = [...evPool].sort((a, b) => gains.get(b.id)! - gains.get(a.id)!);
  const shortlist: BoardPlayer[] = [];
  const add = (p: BoardPlayer | undefined) => { if (p && !shortlist.includes(p)) shortlist.push(p); };
  const shortlistSize = future.length <= LATE_PICKS ? UNIFIED_SHORTLIST_LATE : UNIFIED_SHORTLIST;
  for (let i = 0; i < shortlistSize / 2; i++) { add(byTable[i]); add(byEv[i]); }
  // The best at every position, so a cross-position comparison always happens —
  // unless the position cannot add lineup points at all (its best available is
  // worth nothing over the wire on this roster), in which case it cannot win.
  for (const pos of POSITIONS) {
    const best = byTable.find((p) => p.pos === pos);
    if (best && table[pos](rateOf.get(best.id)!) > 0) add(best);
  }

  // Roster completion from the live board: every remaining pick of the draft.
  const nextPick = myPicks.find((n) => n > currentPick) ?? currentPick + 2 * config.teams;
  const simEnd = future.length ? future[future.length - 1] : currentPick;
  const schedule: CompletionShared["schedule"] = [];
  for (let n = currentPick + 1; n <= simEnd; n++) {
    schedule.push({ pickNo: n, slot: pickOwner(n, config.teams, []), mine: future.includes(n) });
  }
  const toCp = (p: BoardPlayer): CompletionPlayer => ({
    id: p.id, pos: p.pos, adp: p.adp + (drift[p.pos] ?? 0), stdev: p.adpStdev, bye: p.bye,
    weeklyRate: expectedWeekly(p, params, projOf(p)),
  });
  const players = available.map(toCp);
  const indexById = new Map(players.map((p, i) => [p.id, i]));
  // Opponent rosters: real ones when the client/backtest supplies them, else
  // reconstructed from position counts (no byes → treated as never off).
  const opponentRosters: Record<number, { pos: Position; bye: number | null }[]> = {};
  if (state.opponentRosters) {
    for (const [slot, r] of Object.entries(state.opponentRosters)) opponentRosters[Number(slot)] = r.map((p) => ({ pos: p.pos, bye: p.bye }));
  } else {
    for (const [slot, counts] of Object.entries(state.opponentCounts ?? {})) {
      const r: { pos: Position; bye: number | null }[] = [];
      for (const [pos, c] of Object.entries(counts)) for (let i = 0; i < (c ?? 0); i++) r.push({ pos: pos as Position, bye: null });
      opponentRosters[Number(slot)] = r;
    }
  }
  const shared: CompletionShared = {
    players, myRoster: state.myRoster.map(toCp), opponentRosters,
    schedule, teams: config.teams, rounds: config.rounds, config, waiver, params,
  };
  // Late picks are cheap to complete and their margins are small, so spend
  // more iterations on them: budget ∝ 1 / remaining picks, capped.
  const iterations = Math.min(
    UNIFIED_ITERATIONS_MAX,
    Math.max(UNIFIED_ITERATIONS, Math.round((UNIFIED_ITERATIONS * 14) / Math.max(1, future.length)))
  );
  const evaluate = (cands: BoardPlayer[], iters: number, seedOffset: number) => {
    const completions = completeRosters(shared, cands.map((c) => indexById.get(c.id)!), iters, seed + seedOffset);
    const fp = completions.map((perIt) => perIt.map((idxs) => idxs.map((i) => available[i])));
    return evaluateCompletions(state.myRoster, cands, fp, params, config, waiver, seed + seedOffset, projOf);
  };
  let samples = evaluate(shortlist, iterations, 0);
  const scoreOf = (i: number) => samples[i].mean - lambda * samples[i].sd;

  // Refine close calls: if the two leaders are within noise of each other,
  // re-simulate the top few with several times the iterations and merge.
  const ranked = shortlist.map((_, i) => i).sort((a, b) => scoreOf(b) - scoreOf(a));
  if (ranked.length >= 2) {
    const a = samples[ranked[0]].samples, b = samples[ranked[1]].samples;
    let m = 0;
    for (let k = 0; k < a.length; k++) m += a[k] - b[k];
    m /= a.length;
    let v = 0;
    for (let k = 0; k < a.length; k++) v += (a[k] - b[k] - m) ** 2;
    const seDiff = Math.sqrt(v / Math.max(1, a.length - 1) / a.length);
    if (future.length <= REFINE_MAX_FUTURE && Math.abs(scoreOf(ranked[0]) - scoreOf(ranked[1])) < REFINE_SE * seDiff) {
      const topIdx = ranked.slice(0, REFINE_TOP);
      const more = evaluate(topIdx.map((i) => shortlist[i]), iterations * REFINE_MULT, 7919);
      samples = samples.map((s0, i) => {
        const j = topIdx.indexOf(i);
        if (j < 0) return s0;
        const merged = new Float64Array(s0.samples.length + more[j].samples.length);
        merged.set(s0.samples, 0);
        merged.set(more[j].samples, s0.samples.length);
        let sum = 0;
        for (const x of merged) sum += x;
        const mean = sum / merged.length;
        let vv = 0;
        for (const x of merged) vv += (x - mean) ** 2;
        return { mean, sd: Math.sqrt(vv / (merged.length - 1)), samples: merged };
      });
    }
  }

  const recs: Recommendation[] = shortlist.map((p, i) => ({
    player: p,
    reason: "",
    score: samples[i].mean - lambda * samples[i].sd,
    vona: vona(p, available, nextPick, drift),
    survivalToNextPick: survivalProb(p, nextPick, drift),
    simMean: samples[i].mean,
    simStdev: samples[i].sd,
    expectedPoints: samples[i].mean,
    pointsSd: samples[i].sd,
    byeCoverWeeks: coverageSlotWeeks(p.pos, p.bye, state.myRoster, config),
  }));
  recs.sort((a, b) => b.score - a.score);
  for (let i = 0; i < recs.length; i++) {
    const other = recs[i === 0 ? 1 : 0];
    recs[i].gainOverNext = recs[i].expectedPoints! - (other?.expectedPoints ?? recs[i].expectedPoints!);
  }
  const top = recs.slice(0, 3);
  if (top[0]) top[0].reason = buildReason(top[0], available, nextPick);
  for (const rec of top.slice(1)) rec.reason = buildAlternateReason(rec, top[0], nextPick);
  const t1 = typeof performance !== "undefined" ? performance.now() : 0;
  return { recommendations: top, scored: recs, strategyWarning: null, computeMs: t1 - t0 };
}

export function recommend(state: EngineState, seed = 42): EngineOutput {
  if ((state.strategy.valueModel ?? "lineup") === "unified") return unifiedRecommend(state, seed);
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { board, draftedIds, config, strategy, currentPick, myPicks, drift } = state;

  const available = board.filter((p) => !draftedIds.has(p.id));
  const myCounts: Partial<Record<Position, number>> = {};
  for (const p of state.myRoster) myCounts[p.pos] = (myCounts[p.pos] ?? 0) + 1;
  const round = slotOnClock(currentPick, config.teams).round;

  const bestball = config.leagueType === "bestball";
  const valueFn = makeValueFn(board, strategy, bestball);
  const nextPick = myPicks.find((n) => n > currentPick) ?? currentPick + 2 * config.teams;
  // Best ball keeps its market-curve model; "lineup" is a redraft concept and
  // the default there. "blend" is the legacy league-wide-scarcity model, kept
  // as an explicit opt-in for comparison.
  const lineupValue =
    !bestball && (strategy.valueModel ?? "lineup") === "lineup"
      ? makeLineupValueFn(available, nextPick, drift, state.myRoster, config)
      : undefined;
  const pool = hardFilter(available, state, myCounts, round);
  const scored = quickScoreAll(pool, state, strategy, myCounts, round, valueFn, lineupValue).sort(
    (a, b) => b.quickScore - a.quickScore
  );
  const candidates = scored.slice(0, MC_CANDIDATES);

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
    // Under the lineup model the sim's greedy future picks are valued by
    // starter quality (VOLS), not RB-inflated replacement scarcity.
    value: Math.max(0, lineupValue ? a.vols : valueFn(a)),
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
