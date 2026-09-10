// Rest-of-season simulation for a whole league. Pure and seeded.
//
// Every roster's remaining weeks are drawn from the season outcome model
// (lib/engine/outcome.ts — byes, injury status, skill error, team correlation),
// each week's lineup is the optimal one on that week's draw, and the league's
// real pairings decide who beat whom. Standings are wins, then points for.
//
// Why the season model and not Leg A's weekly sampler: there is no WeekOutlook
// for week W+3. The two meet through `leverage`, which the current week's
// start/sit reads when the risk dial is on.
import type { BoardPlayer, LeagueConfig } from "../../types";
import { makeRng } from "../montecarlo";
import { makeTeamShocks, sampleSeason } from "../outcome";
import { optimalLineupTotal } from "../season";
import type { OutcomeParams } from "../outcomeModel";
import outcomeJson from "../../../config/outcome-model.json";

const DEFAULT_OUTCOME = outcomeJson as OutcomeParams;
const DEFAULT_SIMS = 500;

export interface LeagueTeamInput {
  rosterId: number;
  name: string;
  players: BoardPlayer[];
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

export interface PlayoffInput {
  teams: LeagueTeamInput[];
  /** week -> [rosterId, rosterId] pairs. A week absent here is simulated against a random opponent. */
  schedule: Record<number, [number, number][]>;
  /** First week not yet played. */
  currentWeek: number;
  /** The regular season ends the week before this. */
  playoffWeekStart: number;
  playoffTeams: number;
  config: LeagueConfig;
  myRosterId: number;
  sims?: number;
  seed?: number;
  params?: OutcomeParams;
}

export interface TeamOdds {
  rosterId: number;
  name: string;
  playoffOdds: number;
  /** P(finishing seed k), index 0 = first seed. Sums to playoffOdds. */
  seedDist: number[];
  expectedWins: number;
}

export interface PlayoffOdds {
  teams: TeamOdds[];
  mine: TeamOdds;
  /** P(playoffs | I win this week) / lose. Null when this week's pairing is unknown or a branch never occurred. */
  oddsIfWin: number | null;
  oddsIfLose: number | null;
  /** oddsIfWin - oddsIfLose in [0, 1]; null when unknown. Feeds the start/sit risk dial. */
  leverage: number | null;
  /** Wins the team holding the last spot needs to lock me out; 0 = already out; null = cannot be eliminated. */
  eliminationNumber: number | null;
  /** Last week whose pairings are known; weeks after it used random opponents. currentWeek - 1 when none are. */
  scheduleKnownThrough: number;
  remainingWeeks: number;
}

/**
 * Classic elimination number. My ceiling is myWins + remaining; the team that
 * would hold the LAST playoff spot without me (the playoffTeams-th best rival)
 * eliminates me once its wins exceed that ceiling. Null when there are fewer
 * rivals than spots, because then I am in regardless.
 *
 * Wins are counted as the standings count them — a tie is half a win — so the
 * caller passes `wins + ties / 2`. The rival needs the smallest whole number
 * of wins n with cut + n > ceiling, i.e. floor(ceiling - cut) + 1.
 */
export function eliminationNumber(myWins: number, othersWins: number[], remainingWeeks: number, playoffTeams: number): number | null {
  const sorted = [...othersWins].sort((a, b) => b - a);
  const cut = sorted[playoffTeams - 1];
  if (cut === undefined) return null;
  return Math.max(0, Math.floor(myWins + remainingWeeks - cut) + 1);
}

/** Fisher-Yates on a copy, from the seeded stream. */
function shuffle<T>(xs: T[], rng: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function playoffOdds(input: PlayoffInput): PlayoffOdds {
  const { teams, schedule, currentWeek, playoffWeekStart, playoffTeams, config, myRosterId } = input;
  const params = input.params ?? DEFAULT_OUTCOME;
  const sims = input.sims ?? DEFAULT_SIMS;
  const seed = input.seed ?? 1;
  const lastWeek = Math.min(playoffWeekStart - 1, params.weeks);
  const weeks: number[] = [];
  for (let w = currentWeek; w <= lastWeek; w++) weeks.push(w);
  const T = teams.length;
  const idxOf = new Map(teams.map((t, i) => [t.rosterId, i] as const));
  const me = idxOf.get(myRosterId);
  if (me === undefined) throw new Error(`playoffOdds: roster ${myRosterId} is not in the league`);

  let knownThrough = currentWeek - 1;
  for (const w of weeks) if (schedule[w]?.length) knownThrough = w; else break;
  const thisWeekKnown = (schedule[currentWeek]?.length ?? 0) > 0 && weeks.length > 0;

  const madeIt = new Array<number>(T).fill(0);
  const seeds = teams.map(() => new Array<number>(playoffTeams).fill(0));
  const winsSum = new Array<number>(T).fill(0);
  let winWeekIn = 0, winWeekN = 0, loseWeekIn = 0, loseWeekN = 0;

  for (let s = 0; s < sims; s++) {
    const rng = makeRng((seed * 7919 + s * 104729) >>> 0);
    const shocks = makeTeamShocks(rng, params.weeks);
    // Every player's remaining weeks, in a shared correlated season.
    const weekly = teams.map((t) => t.players.map((p) => sampleSeason(p, params, rng, shocks).weekly));
    const wins = teams.map((t) => t.wins + t.ties / 2);
    const pts = teams.map((t) => t.pointsFor);
    let myWeekResult: "win" | "lose" | null = null;

    for (const w of weeks) {
      const totals = teams.map((t, i) => optimalLineupTotal(t.players.map((p, k) => ({ pos: p.pos, score: weekly[i][k][w - 1] })), config));
      for (let i = 0; i < T; i++) pts[i] += totals[i];
      let pairs: [number, number][];
      if (schedule[w]?.length) {
        // A pairing naming a roster that is not in `teams` is dropped: nothing
        // honest can be simulated for it, and the caller's snapshot is the
        // source of truth for who is in the league.
        pairs = [];
        for (const [a, b] of schedule[w]) {
          const ia = idxOf.get(a);
          const ib = idxOf.get(b);
          if (ia !== undefined && ib !== undefined) pairs.push([ia, ib]);
        }
      } else {
        // Unknown pairings: a random opponent this week. Stated in scheduleKnownThrough.
        const order = shuffle(teams.map((_, i) => i), rng);
        pairs = [];
        for (let i = 0; i + 1 < order.length; i += 2) pairs.push([order[i], order[i + 1]]);
      }
      for (const [a, b] of pairs) {
        if (totals[a] > totals[b]) wins[a] += 1;
        else if (totals[b] > totals[a]) wins[b] += 1;
        else { wins[a] += 0.5; wins[b] += 0.5; }
        if (w === currentWeek && thisWeekKnown && (a === me || b === me)) {
          const mine = a === me ? totals[a] : totals[b];
          const theirs = a === me ? totals[b] : totals[a];
          myWeekResult = mine > theirs ? "win" : mine < theirs ? "lose" : null;
        }
      }
    }

    // Standings: wins, then points for. Deterministic index tiebreak last.
    const order = teams.map((_, i) => i).sort((i, j) => wins[j] - wins[i] || pts[j] - pts[i] || i - j);
    for (let rank = 0; rank < Math.min(playoffTeams, T); rank++) {
      const i = order[rank];
      madeIt[i]++;
      seeds[i][rank]++;
    }
    for (let i = 0; i < T; i++) winsSum[i] += wins[i] - teams[i].wins - teams[i].ties / 2;
    const iAmIn = order.indexOf(me) < playoffTeams ? 1 : 0;
    if (myWeekResult === "win") { winWeekN++; winWeekIn += iAmIn; }
    else if (myWeekResult === "lose") { loseWeekN++; loseWeekIn += iAmIn; }
  }

  const out: TeamOdds[] = teams.map((t, i) => ({
    rosterId: t.rosterId,
    name: t.name,
    playoffOdds: madeIt[i] / sims,
    seedDist: seeds[i].map((c) => c / sims),
    expectedWins: winsSum[i] / sims,
  }));
  const mine = out[me];
  const oddsIfWin = winWeekN > 0 ? winWeekIn / winWeekN : null;
  const oddsIfLose = loseWeekN > 0 ? loseWeekIn / loseWeekN : null;
  let leverage: number | null = null;
  if (mine.playoffOdds === 1 || mine.playoffOdds === 0) leverage = 0; // clinched or eliminated: this week cannot move it
  else if (oddsIfWin !== null && oddsIfLose !== null) leverage = Math.min(1, Math.max(0, oddsIfWin - oddsIfLose));

  return {
    teams: out,
    mine,
    oddsIfWin,
    oddsIfLose,
    leverage,
    eliminationNumber: eliminationNumber(
      teams[me].wins + teams[me].ties / 2,
      teams.filter((_, i) => i !== me).map((t) => t.wins + t.ties / 2),
      weeks.length,
      playoffTeams
    ),
    scheduleKnownThrough: knownThrough,
    remainingWeeks: weeks.length,
  };
}
