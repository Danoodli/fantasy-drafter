// Correlated weekly sampler. Pure and seeded.
//
// Marginal distributions are not enough for either downstream leg. A QB and
// two of his receivers is a mediocre expected-value lineup and a strong
// tournament lineup precisely BECAUSE their good weeks arrive together; and a
// start/sit floor is worse than it looks when three starters share one game.
//
// Hierarchy, one draw set per iteration:
//   z_p = a_g·z_game[g] + a_t·z_team[t] + a_u·z_unit[t,unit] + a_i·z_i
// with the amplitudes derived from nested correlations in weekly-model.json.
// Setting game = 0 and unit = team reproduces the season model's single
// team-shock behaviour (lib/engine/outcome.ts makeTeamShocks).
//
// A DST loads NEGATIVELY on its opponent's team shock: a defense scores when
// the offense it faces does not.
import type { Position, StatLine } from "../types";
import { gaussian } from "./outcome";
import { makeRng } from "./montecarlo";
import { correlationAmplitudes, unitOf, type WeeklyModelParams } from "./weekly/model";
import { dkBonusPoints, scaleStatLine } from "./weekly/bonuses";

export interface WeekSimPlayer {
  id: string;
  pos: Position;
  team: string;
  /** Stable per-game key, e.g. "DET-CHI". Both teams in a game share it. */
  gameId: string;
  opp: string;
  meanIfPlays: number;
  sigma: number;
  pPlay: number;
  stats: StatLine;
}

/** Lazily-drawn, cached shocks for one iteration. */
function makeShocks(rng: () => number) {
  const cache = new Map<string, number>();
  return (key: string): number => {
    let v = cache.get(key);
    if (v === undefined) {
      v = gaussian(rng);
      cache.set(key, v);
    }
    return v;
  };
}

export interface WeekSimOpts {
  /**
   * Add DK threshold bonuses (+3 at 300 pass / 100 rush / 100 rec yards) by
   * scaling the projected stat line with the same draw that scaled the points.
   * The bonuses are flat, so no scoring settings are needed here — whatever
   * scoring built `meanIfPlays` already applies. For DFS, build the outlooks
   * with DK scoring in the first place.
   */
  dkBonuses?: boolean;
}

/** One correlated week. Returns points per player, in input order. */
export function sampleWeek(
  players: WeekSimPlayer[],
  p: WeeklyModelParams,
  rng: () => number,
  opts: WeekSimOpts = {}
): Float64Array {
  const a = correlationAmplitudes(p.correlation);
  const aDst = Math.sqrt(p.correlation.dstVsOppTeam);
  // Residual amplitude for a DST, so its variance still sums to one.
  const aDstOwn = Math.sqrt(Math.max(0, 1 - p.correlation.game - p.correlation.dstVsOppTeam));
  const shock = makeShocks(rng);
  const out = new Float64Array(players.length);

  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    if (pl.pPlay <= 0 || pl.meanIfPlays <= 0) continue;
    if (rng() > pl.pPlay) continue; // inactive this iteration: exactly zero

    let z: number;
    if (pl.pos === "DST") {
      z =
        a.game * shock(`g:${pl.gameId}`) -
        aDst * shock(`t:${pl.opp}`) +
        aDstOwn * gaussian(rng);
    } else {
      z =
        a.game * shock(`g:${pl.gameId}`) +
        a.team * shock(`t:${pl.team}`) +
        a.unit * shock(`u:${pl.team}:${unitOf(pl.pos)}`) +
        a.player * gaussian(rng);
    }

    // Lognormal with mean exactly meanIfPlays.
    const mult = Math.exp(pl.sigma * z - (pl.sigma * pl.sigma) / 2);
    let pts = pl.meanIfPlays * mult;
    if (opts.dkBonuses) {
      pts += dkBonusPoints(scaleStatLine(pl.stats, mult));
    }
    out[i] = pts;
  }
  return out;
}

/** `sims` independent correlated weeks. Deterministic given the seed. */
export function simulateWeek(
  players: WeekSimPlayer[],
  p: WeeklyModelParams,
  sims: number,
  seed: number,
  opts: WeekSimOpts = {}
): Float64Array[] {
  const draws: Float64Array[] = new Array(sims);
  for (let s = 0; s < sims; s++) {
    // Same seeding construction as simulateSeasons in lib/engine/season.ts:
    // a distinct, reproducible stream per iteration.
    draws[s] = sampleWeek(players, p, makeRng((seed * 7919 + s * 104729) >>> 0), opts);
  }
  return draws;
}
