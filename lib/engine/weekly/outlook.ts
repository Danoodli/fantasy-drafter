// Assembles one WeekOutlook per player: the market ensemble blended with our
// usage model, scaled by environment / script / matchup, with a
// volume-dependent lognormal spread and an availability probability.
//
// Deliberately decoupled from the ETL: this takes a per-team line record and a
// DvP LOOKUP FUNCTION, never the ETL's file shapes. The engine does not know
// where the numbers came from, which is what keeps it pure and its tests
// fixture-free.
import type { Position, ScoringSettings, StatLine } from "../../types";
import { scoreStatLine } from "../../scoring";
import type { WeeklyModelParams } from "./model";
import { envMult, impliedTeamPoints, scriptMult } from "./environment";
import { matchMult } from "./matchup";
import { pPlay } from "./availability";
import { lognormalQuantile, projectedVolume, weeklySigma } from "./spread";

export interface WeekLine {
  total: number;
  /** Negative = this team is favored. */
  ownSpread: number;
  opp: string;
}

export type DvpLookup = (
  defense: string,
  pos: Position
) => { allowed?: number; leagueAvg?: number; games: number };

export interface WeekPlayerInput {
  id: string;
  pos: Position;
  team: string;
  bye: number | null;
  status: string | null;
  /** Projected stat lines per market source. DK publishes a total, not a line. */
  sleeper?: StatLine;
  /**
   * K and DST only: Sleeper's published total, used when there is no
   * re-scorable stat line (see lib/etl/weekly/sleeperWeekly.ts). Ignored
   * whenever `sleeper` is present.
   */
  sleeperPoints?: number;
  espn?: StatLine;
  dk?: number;
  /** Our own usage model's projected stat line, when we have usage for him. */
  usage?: StatLine;
}

export interface WeekOutlook {
  playerId: string;
  week: number;
  opp: string | null;
  meanIfPlays: number;
  mean: number;
  sigma: number;
  p10: number;
  p50: number;
  p90: number;
  pPlay: number;
  /**
   * False when NO source had an opinion on this player, weighted or not.
   * Such a player's `mean` is 0, which is otherwise indistinguishable from a
   * bye or an Out designation — very different things for a start/sit call.
   * A UI must render this as "no projection", never as 0.0.
   */
  projected: boolean;
  stats: StatLine;
  drivers: {
    baseMarket: number;
    baseUsage: number;
    matchMult: number;
    envMult: number;
    scriptMult: number;
    status: string | null;
  };
}

/**
 * Weighted mean of the market sources that actually have an opinion, with the
 * weights renormalized over those present. Without renormalization a player
 * ESPN has never heard of would be quietly projected 50% low.
 */
export function blendMarket(
  input: WeekPlayerInput,
  scoring: ScoringSettings,
  p: WeeklyModelParams
): number {
  const isTE = input.pos === "TE";
  const parts: { w: number; v: number }[] = [];
  if (p.sourceWeights.sleeper > 0) {
    // A stat line is preferred because it can be re-scored under league
    // settings; `sleeperPoints` is the K/DST fallback, which cannot.
    const v = input.sleeper
      ? scoreStatLine(input.sleeper, scoring, isTE)
      : input.sleeperPoints;
    if (typeof v === "number") parts.push({ w: p.sourceWeights.sleeper, v });
  }
  if (input.espn && p.sourceWeights.espn > 0) {
    parts.push({ w: p.sourceWeights.espn, v: scoreStatLine(input.espn, scoring, isTE) });
  }
  // DK gives a point total under DK scoring, not a stat line. Used as-is; the
  // calibration decides how much that mismatch is worth.
  if (typeof input.dk === "number" && p.sourceWeights.dk > 0) {
    parts.push({ w: p.sourceWeights.dk, v: input.dk });
  }
  const wSum = parts.reduce((s, x) => s + x.w, 0);
  if (wSum > 0) return parts.reduce((s, x) => s + x.w * x.v, 0) / wSum;

  // No WEIGHTED source has an opinion on this player. Fall back to any source
  // that does, in a fixed order, rather than returning 0 — because a 0 here is
  // not "we project zero points", it is "we have nothing", and downstream that
  // reads as "bench him".
  //
  // This is not hypothetical. In the shipped off state ESPN sits at weight 0,
  // and 179 of 526 board players (34%) had no weighted source for 2026 week 1,
  // including Brock Bowers at ADP 34.5. ESPN had 48 of them, covering every
  // high-ADP name.
  //
  // It does not break the off-state contract either: for a player Sleeper has
  // no opinion on, "raw re-scored Sleeper" is undefined, so there is nothing to
  // reproduce. The baseline is Sleeper WHERE SLEEPER HAS AN OPINION.
  if (input.sleeper) return scoreStatLine(input.sleeper, scoring, isTE);
  if (typeof input.sleeperPoints === "number") return input.sleeperPoints;
  if (input.espn) return scoreStatLine(input.espn, scoring, isTE);
  if (typeof input.dk === "number") return input.dk;
  return 0;
}

export function buildWeekOutlooks(args: {
  week: number;
  players: WeekPlayerInput[];
  linesByTeam: Record<string, WeekLine>;
  dvp: DvpLookup;
  scoring: ScoringSettings;
  params: WeeklyModelParams;
}): WeekOutlook[] {
  const { week, players, linesByTeam, dvp, scoring, params: p } = args;
  const out: WeekOutlook[] = [];

  for (const player of players) {
    const isTE = player.pos === "TE";
    const baseMarket = blendMarket(player, scoring, p);
    const baseUsage = player.usage ? scoreStatLine(player.usage, scoring, isTE) : 0;

    // Renormalize when usage has no opinion, so a missing usage history does
    // not read as "we project him for 70% of the market number".
    let base: number;
    if (player.usage && p.modelWeights.usage > 0) {
      base = p.modelWeights.market * baseMarket + p.modelWeights.usage * baseUsage;
    } else {
      base = baseMarket;
    }

    const line = linesByTeam[player.team];
    // No line means no game: a bye, or a team the odds feed did not carry.
    // Either way he does not play, and inventing an environment for him would
    // be fabricating exactly the input we know least about.
    const isBye = player.bye === week || !line;

    let mMatch = 1;
    let mEnv = 1;
    let mScript = 1;
    if (line) {
      const itpOwn = impliedTeamPoints(line.total, line.ownSpread);
      const itpOpp = impliedTeamPoints(line.total, -line.ownSpread);
      mEnv = envMult(player.pos, itpOwn, itpOpp, p);
      mScript = scriptMult(player.pos, line.ownSpread, p);
      const d = dvp(line.opp, player.pos);
      mMatch = matchMult(player.pos, d.allowed, d.leagueAvg, d.games, p);
    }

    const meanIfPlays = base * mEnv * mScript * mMatch;
    const play = pPlay(player.status, isBye, p);
    const projected =
      Boolean(player.sleeper) ||
      typeof player.sleeperPoints === "number" ||
      Boolean(player.espn) ||
      typeof player.dk === "number" ||
      Boolean(player.usage);
    const stats = player.sleeper ?? player.usage ?? player.espn ?? {};
    const sigma = weeklySigma(player.pos, projectedVolume(player.pos, stats), p);

    out.push({
      playerId: player.id,
      week,
      opp: isBye ? null : line!.opp,
      meanIfPlays,
      mean: meanIfPlays * play,
      sigma,
      projected,
      p10: lognormalQuantile(meanIfPlays, sigma, 0.1),
      p50: lognormalQuantile(meanIfPlays, sigma, 0.5),
      p90: lognormalQuantile(meanIfPlays, sigma, 0.9),
      pPlay: play,
      stats,
      drivers: {
        baseMarket,
        baseUsage,
        matchMult: mMatch,
        envMult: mEnv,
        scriptMult: mScript,
        status: player.status,
      },
    });
  }
  return out;
}
