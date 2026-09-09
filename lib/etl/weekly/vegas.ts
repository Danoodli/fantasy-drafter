// Game environment inputs: the closing-ish spread and total per game.
//
// Live: ESPN's scoreboard endpoint carries `competitions[].odds` keylessly
// (verified 2026-09-09). Historical: nflverse nfldata games.csv carries
// spread_line and total_line for every game back to 1999, which is what makes
// the environment coefficients fittable rather than guessed.
//
// Convention: `homeSpread` is negative when the home team is favored (betting
// convention). nflverse's spread_line is the OPPOSITE sign, so it is flipped
// on read — getting this backwards silently inverts every favorite in the fit.
import { parseCsv } from "../csv";
import { canonicalTeam } from "../nflverse";
import type { FetchOpts, SourceResult } from "../fetchers";
import { fetchSlim } from "./cache";

export interface GameLine {
  week: number;
  home: string;
  away: string;
  total: number;
  /** Negative = home favored. */
  homeSpread: number;
}

interface EspnCompetitor { homeAway?: string; team?: { abbreviation?: string } }
interface EspnOdds { provider?: { priority?: number }; spread?: number; overUnder?: number }
interface EspnEvent { week?: { number?: number }; competitions?: { competitors?: EspnCompetitor[]; odds?: EspnOdds[] }[] }

export function parseEspnScoreboard(json: unknown): GameLine[] {
  const doc = json as { week?: { number?: number }; events?: EspnEvent[] };
  const out: GameLine[] = [];
  for (const ev of doc?.events ?? []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const home = canonicalTeam(comp.competitors?.find((c) => c.homeAway === "home")?.team?.abbreviation);
    const away = canonicalTeam(comp.competitors?.find((c) => c.homeAway === "away")?.team?.abbreviation);
    if (!home || !away) continue;
    // Prefer the highest-priority provider that actually published both numbers.
    const odds = (comp.odds ?? [])
      .filter((o) => typeof o.spread === "number" && typeof o.overUnder === "number")
      .sort((a, b) => (a.provider?.priority ?? 99) - (b.provider?.priority ?? 99))[0];
    // No line means no line. Defaulting to a pick'em would feed the model a
    // fabricated environment for exactly the games it knows least about.
    if (!odds) continue;
    out.push({
      week: ev.week?.number ?? doc.week?.number ?? 0,
      home,
      away,
      total: odds.overUnder as number,
      homeSpread: odds.spread as number,
    });
  }
  return out;
}

export function parseHistoricalLines(csv: string, season: number): GameLine[] {
  const out: GameLine[] = [];
  for (const r of parseCsv(csv)) {
    if (r.season !== String(season) || r.game_type !== "REG") continue;
    const total = Number(r.total_line);
    const spread = Number(r.spread_line);
    if (!Number.isFinite(total) || !Number.isFinite(spread)) continue;
    out.push({
      week: Number(r.week),
      home: canonicalTeam(r.home_team),
      away: canonicalTeam(r.away_team),
      total,
      homeSpread: -spread, // nflverse: positive = home favored. We invert.
    });
  }
  return out;
}

/** One team's view of its own game. Null when the team is not playing (bye). */
export function lineFor(
  lines: GameLine[],
  team: string
): { total: number; ownSpread: number; opp: string } | null {
  for (const l of lines) {
    if (l.home === team) return { total: l.total, ownSpread: l.homeSpread, opp: l.away };
    if (l.away === team) return { total: l.total, ownSpread: -l.homeSpread, opp: l.home };
  }
  return null;
}

export function fetchVegasWeek(
  season: number,
  week: number,
  opts: FetchOpts = {}
): Promise<SourceResult<GameLine[]>> {
  return fetchSlim<GameLine[]>(
    `vegas-${season}-${week}.json`,
    async () => {
      const url =
        `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` +
        `?seasontype=2&week=${week}&dates=${season}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lines = parseEspnScoreboard(await res.json());
      // A bye-heavy week still has at least 8 games; fewer means the feed is
      // partial, which would feed the model a fabricated environment.
      if (lines.length < 8) throw new Error(`only ${lines.length} games with odds`);
      return lines;
    },
    opts,
    // The engine runs neutral without lines (envMult and scriptMult fall to 1),
    // so a missing fixture degrades rather than fails.
    () => []
  );
}
