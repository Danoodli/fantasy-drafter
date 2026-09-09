// Our own second opinion, independent of any market projection: recent share
// of team volume × expected team volume × shrunk efficiency.
//
// The asymmetry here is deliberate and is the whole reason this module exists.
// Volume is signal — target share is stable and predictive. Efficiency is
// mostly noise — a three-game 22% touchdown rate is not a skill, and a model
// that treats it as one is confidently wrong. So shares carry through nearly
// intact while efficiency is shrunk hard toward a position prior by
// `usage.effReliability`.
import type { Position, StatLine } from "../../types";
import type { WeeklyModelParams } from "./model";

export interface UsageWeek {
  week: number;
  team: string;
  targets: number;
  carries: number;
  attempts: number;
  recYds: number;
  rushYds: number;
  passYds: number;
  teamTargets: number;
  teamCarries: number;
  teamAttempts: number;
}

export type UsageHistory = Record<string, UsageWeek[]>;

export interface Shares {
  targetShare: number;
  carryShare: number;
  attemptShare: number;
  /** Weeks of usage actually observed — drives the prior blend. */
  games: number;
}

export interface Efficiency {
  ydsPerTarget: number;
  ydsPerCarry: number;
  ydsPerAttempt: number;
  tdPerTarget: number;
  tdPerCarry: number;
  tdPerAttempt: number;
  catchRate: number;
}

/** Exponentially-weighted share of team volume. lambda = 1 is a flat mean. */
export function rollingShares(weeks: UsageWeek[], lambda: number): Shares {
  if (weeks.length === 0) {
    return { targetShare: 0, carryShare: 0, attemptShare: 0, games: 0 };
  }
  const latest = weeks[weeks.length - 1].week;
  let wSum = 0;
  let t = 0;
  let c = 0;
  let a = 0;
  for (const w of weeks) {
    const weight = Math.pow(lambda, latest - w.week);
    wSum += weight;
    t += weight * (w.teamTargets > 0 ? w.targets / w.teamTargets : 0);
    c += weight * (w.teamCarries > 0 ? w.carries / w.teamCarries : 0);
    a += weight * (w.teamAttempts > 0 ? w.attempts / w.teamAttempts : 0);
  }
  return {
    targetShare: t / wSum,
    carryShare: c / wSum,
    attemptShare: a / wSum,
    games: weeks.length,
  };
}

/**
 * Blend observed share toward a preseason prior by n/(n+k). With zero games
 * observed this is exactly the prior — which is what stops week 1 from reading
 * three snaps as a breakout.
 */
export function blendWithPrior(observed: Shares, prior: Shares, priorGames: number): Shares {
  const n = observed.games;
  const w = n / (n + priorGames);
  const mix = (o: number, p: number) => p + w * (o - p);
  return {
    targetShare: mix(observed.targetShare, prior.targetShare),
    carryShare: mix(observed.carryShare, prior.carryShare),
    attemptShare: mix(observed.attemptShare, prior.attemptShare),
    games: n,
  };
}

export interface UsageProjectionInput {
  pos: Position;
  shares: Shares;
  teamVolume: { targets: number; carries: number; attempts: number };
  efficiency: Efficiency;
  priorEfficiency: Efficiency;
}

export function projectUsageStatLine(
  input: UsageProjectionInput,
  p: WeeklyModelParams
): StatLine {
  const r = p.usage.effReliability;
  const shrink = (obs: number, prior: number) => prior + r * (obs - prior);
  const e = input.efficiency;
  const pe = input.priorEfficiency;

  const targets = input.shares.targetShare * input.teamVolume.targets;
  const carries = input.shares.carryShare * input.teamVolume.carries;
  const attempts = input.pos === "QB" ? input.shares.attemptShare * input.teamVolume.attempts : 0;

  const out: StatLine = {};
  const set = (k: keyof StatLine, v: number) => {
    if (v > 0) out[k] = v;
  };

  if (targets > 0) {
    set("receptions", targets * shrink(e.catchRate, pe.catchRate));
    set("recYds", targets * shrink(e.ydsPerTarget, pe.ydsPerTarget));
    set("recTD", targets * shrink(e.tdPerTarget, pe.tdPerTarget));
  }
  if (carries > 0) {
    set("rushYds", carries * shrink(e.ydsPerCarry, pe.ydsPerCarry));
    set("rushTD", carries * shrink(e.tdPerCarry, pe.tdPerCarry));
  }
  if (attempts > 0) {
    set("passYds", attempts * shrink(e.ydsPerAttempt, pe.ydsPerAttempt));
    set("passTD", attempts * shrink(e.tdPerAttempt, pe.tdPerAttempt));
  }
  return out;
}
