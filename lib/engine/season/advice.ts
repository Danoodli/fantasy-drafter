// Start/sit advice ranked by the probability you win THIS matchup. Pure.
//
// Expected points is the wrong objective in a head-to-head league, and it is
// what every free tool optimises. If you are a 19-point underdog the correct
// play is the volatile flier whose ceiling is your only path, even though he
// projects lower; if you are a 25-point favourite the correct play is the
// boring floor. Same roster, same week, opposite advice — and it falls
// directly out of the correlated sampler.
//
// Mechanics: ONE joint simulateWeek over my roster and the opponent's
// starters, then every candidate lineup is scored against those same draws by
// index. Paired comparisons, so 2,000 sims resolve swap deltas of a fraction
// of a percent.
import type { LeagueConfig, Position } from "../../types";
import type { WeekOutlook } from "../weekly/outlook";
import type { WeeklyModelParams } from "../weekly/model";
import { simulateWeek, type WeekSimPlayer } from "../weekSim";
import { gaussian } from "../outcome";
import { makeRng } from "../montecarlo";
import { bestLineup, winProbability, type Lineup, type LineupPlayer } from "./lineup";
import { DEFAULT_SEASON_LEVERS, type SeasonLevers } from "./levers";

export interface AdvicePlayer {
  id: string;
  pos: Position;
  team: string;
  outlook: WeekOutlook;
}

/**
 * Who you are playing. Sleeper gives their starters; a manual league gives a
 * projected total, which is modelled as a lognormal with that mean and the
 * same relative spread as your own lineup total. The UI must say which one it
 * is showing.
 */
export type Opponent =
  | { kind: "roster"; players: AdvicePlayer[] }
  | { kind: "total"; projectedTotal: number };

export interface AdviceInput {
  players: (AdvicePlayer & { name: string })[];
  opponent: Opponent;
  config: LeagueConfig;
  params: WeeklyModelParams;
  /** Your locked starters when the platform knows them. Default: best lineup on projected points. */
  starterIds?: string[];
  /**
   * P(playoffs | win this week) - P(playoffs | lose), from playoffOdds. Only
   * read when levers.riskFromPlayoffOdds > 0. null/undefined = unknown, which
   * is treated as full leverage (this week matters).
   */
  leverage?: number | null;
  levers?: SeasonLevers;
  sims?: number;
  seed?: number;
}

export interface Swap {
  inId: string;
  outId: string;
  inName: string;
  outName: string;
  deltaWin: number;
  deltaPoints: number;
  reason: string;
}

export interface ForcedSwap {
  outId: string;
  outName: string;
  why: "bye" | "out" | "no-projection";
  bestReplacementId: string | null;
  bestReplacementName: string | null;
}

export interface TotalSummary {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface Advice {
  /** With the CURRENT lineup. */
  winProbability: number;
  forced: ForcedSwap[];
  /** Ranked; each is measured against the current lineup. */
  swaps: Swap[];
  lineup: Lineup;
  /** The current lineup with swaps applied greedily while each still clears minDeltaWin. */
  recommended: Lineup;
  recommendedWinProbability: number;
  myTotal: TotalSummary;
  oppTotal: TotalSummary;
}

/**
 * A game key both teams in a matchup share, so the sampler correlates them.
 * Sorted so DET-CHI and CHI-DET are the same game.
 */
export function toSimPlayer(p: AdvicePlayer): WeekSimPlayer {
  const gameId = p.outlook.opp ? [p.team, p.outlook.opp].sort().join("-") : `${p.team}-BYE`;
  return {
    id: p.id,
    pos: p.pos,
    team: p.team,
    gameId,
    opp: p.outlook.opp ?? "",
    meanIfPlays: p.outlook.meanIfPlays,
    sigma: p.outlook.sigma,
    pPlay: p.outlook.pPlay,
    stats: p.outlook.stats,
  };
}

const DEFAULT_SIMS = 2000;
const DEFAULT_SEED = 20260909;
/** Offset for the manual-opponent stream so it never overlaps the player draws. */
const OPP_STREAM_SALT = 424243;

function summary(values: Float64Array): TotalSummary {
  const sorted = Float64Array.from(values).sort();
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] ?? 0;
  let s = 0;
  for (const v of values) s += v;
  return { mean: values.length ? s / values.length : 0, p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

function reasonFor(swap: { deltaWin: number; deltaPoints: number }, wp: number, inO: WeekOutlook, outO: WeekOutlook): string {
  const pts = swap.deltaPoints;
  const pct = (swap.deltaWin * 100).toFixed(1);
  if (swap.deltaWin <= 0) {
    // Only reachable with the risk dial on: this week cannot move the season.
    return `+${pts.toFixed(1)} projected points — this week's result cannot change your playoff odds, so points and seeding decide`;
  }
  // Order matters: the favourite's floor case usually ALSO costs points (the
  // safe player projects lower), so it must be recognised before the generic
  // "despite the points" branch or a 96% favourite gets told he is behind.
  if (wp > 0.7 && inO.sigma < outO.sigma) {
    const cost = pts < -0.05 ? ` even at ${pts.toFixed(1)} projected points` : "";
    return `+${pct}% to win: you are ahead, so the safer floor (${inO.p10.toFixed(0)} vs ${outO.p10.toFixed(0)}) protects the lead${cost}`;
  }
  if (pts < -0.05) {
    // The counter-intuitive case, which is the whole point of the feature.
    return wp < 0.5
      ? `+${pct}% to win despite ${pts.toFixed(1)} projected points — you are behind, and his ${inO.p90.toFixed(0)}-point ceiling is the path`
      : `+${pct}% to win despite ${pts.toFixed(1)} projected points — his range fits this matchup better than the points cost`;
  }
  return `+${pct}% to win and +${pts.toFixed(1)} projected points`;
}

export function startSitAdvice(input: AdviceInput): Advice {
  const { players, config, params } = input;
  const levers = input.levers ?? DEFAULT_SEASON_LEVERS;
  const sims = input.sims ?? DEFAULT_SIMS;
  const seed = input.seed ?? DEFAULT_SEED;
  const byId = new Map(players.map((p) => [p.id, p] as const));
  const asLineupPlayer = (id: string): LineupPlayer => {
    const p = byId.get(id)!;
    return { id, pos: p.pos, points: p.outlook.mean };
  };

  // --- one joint draw over everyone involved ---------------------------------
  const oppPlayers = input.opponent.kind === "roster" ? input.opponent.players : [];
  const all: WeekSimPlayer[] = [...players.map(toSimPlayer), ...oppPlayers.map(toSimPlayer)];
  const draws = simulateWeek(all, params, sims, seed);
  const index = new Map(players.map((p, i) => [p.id, i] as const));
  const n = all.length;

  // --- current lineup ---------------------------------------------------------
  /** The best assignment over `ids`, with EVERY other roster player on the bench (not just the startable ones). */
  const toLineup = (ids: string[]): Lineup => {
    const l = bestLineup(ids.map(asLineupPlayer), config);
    const started = new Set(l.starters.map((s) => s.player.id));
    return {
      ...l,
      benched: players.filter((p) => !started.has(p.id)).map((p) => asLineupPlayer(p.id))
        .sort((a, b) => b.points - a.points || a.id.localeCompare(b.id)),
    };
  };
  const startable = players.filter((p) => p.outlook.projected && p.outlook.pPlay > 0);
  const lineup = input.starterIds && input.starterIds.length > 0
    ? toLineup(input.starterIds.filter((id) => byId.has(id)))
    // Only players who can score are candidates; the rest are benched.
    : toLineup(startable.map((p) => p.id));
  const currentSet = lineup.starters.map((s) => s.player.id);

  // --- my total per draw for the current lineup, and the opponent's ---------
  const myTotals = new Float64Array(sims);
  for (let s = 0; s < sims; s++) {
    let t = 0;
    for (const id of currentSet) t += draws[s][index.get(id)!];
    myTotals[s] = t;
  }
  const oppTotals = new Float64Array(sims);
  if (input.opponent.kind === "roster") {
    for (let s = 0; s < sims; s++) {
      let t = 0;
      for (let j = players.length; j < n; j++) t += draws[s][j];
      oppTotals[s] = t;
    }
  } else {
    // Lognormal with the requested mean and my lineup's relative spread, from
    // its own seeded stream. Mean-preserving: E[exp(sL z - sL^2/2)] = 1.
    const mine = summary(myTotals);
    let cv = levers.fallbackTotalCv;
    if (mine.mean > 0) {
      let ss = 0;
      for (const v of myTotals) ss += (v - mine.mean) ** 2;
      const sd = Math.sqrt(ss / sims);
      if (sd > 0) cv = sd / mine.mean;
    }
    const sL = Math.sqrt(Math.log(1 + cv * cv));
    const rng = makeRng((seed * 7919 + OPP_STREAM_SALT) >>> 0);
    const total = Math.max(0, input.opponent.projectedTotal);
    for (let s = 0; s < sims; s++) oppTotals[s] = total * Math.exp(sL * gaussian(rng) - (sL * sL) / 2);
  }

  // Append the opponent total as one extra column so every lineup is scored
  // with the same winProbability(draws, mine, theirs) — one code path.
  const rows = draws.map((d, s) => {
    const e = new Float64Array(n + 1);
    e.set(d);
    e[n] = oppTotals[s];
    return e;
  });
  const OPP = [n];
  const wpOf = (ids: string[]) => winProbability(rows, ids.map((id) => index.get(id)!), OPP);
  const baseWin = wpOf(currentSet);

  // --- objective: delta P(win), blended toward points only when the dial is on
  const r = levers.riskFromPlayoffOdds;
  const leverage = input.leverage == null ? 1 : Math.min(1, Math.max(0, input.leverage));
  const wPts = r > 0 ? r * (1 - leverage) : 0;
  const objective = (deltaWin: number, deltaPoints: number) =>
    (1 - wPts) * deltaWin + wPts * (deltaPoints / levers.pointsScale);

  /** Every legal single swap out of `set`, scored against the same draws. */
  const swapsFrom = (set: string[], setWin: number) => {
    const out: Swap[] = [];
    const inSet = new Set(set);
    for (const inP of players) {
      if (inSet.has(inP.id) || !inP.outlook.projected || inP.outlook.pPlay <= 0) continue;
      for (const outId of set) {
        const next = set.map((id) => (id === outId ? inP.id : id));
        // Legal iff every player in the new set still gets a slot.
        if (bestLineup(next.map(asLineupPlayer), config).starters.length !== next.length) continue;
        const wp = wpOf(next);
        const deltaWin = wp - setWin;
        const deltaPoints = inP.outlook.mean - byId.get(outId)!.outlook.mean;
        if (objective(deltaWin, deltaPoints) < levers.minDeltaWin) continue;
        const outP = byId.get(outId)!;
        const swap: Swap = { inId: inP.id, outId, inName: inP.name, outName: outP.name, deltaWin, deltaPoints, reason: "" };
        swap.reason = reasonFor(swap, setWin, inP.outlook, outP.outlook);
        out.push(swap);
      }
    }
    out.sort((a, b) => objective(b.deltaWin, b.deltaPoints) - objective(a.deltaWin, a.deltaPoints) || a.inId.localeCompare(b.inId));
    return out;
  };

  const swaps = swapsFrom(currentSet, baseWin);

  // --- recommended: apply the best swap while one still clears the bar ------
  let set = currentSet;
  let setWin = baseWin;
  for (let iter = 0; iter < players.length; iter++) {
    const best = swapsFrom(set, setWin)[0];
    if (!best) break;
    set = set.map((id) => (id === best.outId ? best.inId : id));
    setWin = wpOf(set);
  }
  const recommended = toLineup(set);

  // --- forced swaps: a starter who cannot or is not expected to play ---------
  const forced: ForcedSwap[] = [];
  for (const s of lineup.starters) {
    const p = byId.get(s.player.id);
    if (!p) continue;
    const o = p.outlook;
    let why: ForcedSwap["why"] | null = null;
    if (!o.projected) why = "no-projection";
    else if (o.opp === null) why = "bye";
    else if (o.pPlay <= levers.forcedPlayThreshold) why = "out";
    if (!why) continue;
    // Best available replacement: highest projection among bench players who
    // can play and keep the lineup legal in his place.
    const replacement = lineup.benched
      .map((b) => byId.get(b.id)!)
      .filter((b) => b.outlook.projected && b.outlook.pPlay > levers.forcedPlayThreshold)
      .filter((b) => {
        const next = currentSet.map((id) => (id === p.id ? b.id : id));
        return bestLineup(next.map(asLineupPlayer), config).starters.length === next.length;
      })
      .sort((a, b) => b.outlook.mean - a.outlook.mean || a.id.localeCompare(b.id))[0];
    forced.push({
      outId: p.id,
      outName: p.name,
      why,
      bestReplacementId: replacement?.id ?? null,
      bestReplacementName: replacement?.name ?? null,
    });
  }

  return {
    winProbability: baseWin,
    forced,
    swaps,
    lineup,
    recommended,
    recommendedWinProbability: setWin,
    myTotal: summary(myTotals),
    oppTotal: summary(oppTotals),
  };
}
