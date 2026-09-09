// Weekly ETL: fetch → join → project → emit public/data/week-{season}-{week}.json
//
// Run by the `weekly` CI lane Thursday through Monday in season, and manually
// via `pnpm build:week -- --week=3`. Falls back to committed fixtures loudly,
// exactly like build-board.ts.
//
// FantasyPros is deliberately absent: ~10 requests/day of free quota cannot
// survive a lane that runs several times a week.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/etl/csv";
import { parseLane } from "../lib/etl/lane";
import { fetchSleeperWeekly } from "../lib/etl/weekly/sleeperWeekly";
import { fetchEspnWeekly } from "../lib/etl/weekly/espnWeekly";
import { fetchNflverseWeekly } from "../lib/etl/weekly/nflverseWeekly";
import { fetchVegasWeek, lineFor } from "../lib/etl/weekly/vegas";
import { fetchPlayerIds } from "../lib/etl/fetchers";
import { buildDvp } from "../lib/etl/weekly/dvp";
import { buildUsageHistory, remapToSleeper } from "../lib/etl/weekly/usage";
import {
  rollingShares,
  blendWithPrior,
  projectUsageStatLine,
  type Efficiency,
  type Shares,
} from "../lib/engine/weekly/usageModel";
import { buildWeekOutlooks, type WeekLine, type WeekPlayerInput } from "../lib/engine/weekly/outlook";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import { SCORING_PRESETS } from "../lib/scoring";
import { canonicalTeam, num } from "../lib/etl/nflverse";
import type { Board, Position, ScoringFormat, WeekBoard } from "../lib/types";

const SEASON = 2026;
const OUT_DIR = join(process.cwd(), "public", "data");
const FORMATS: ScoringFormat[] = ["standard", "half-ppr", "ppr", "2qb"];

/** League-average per-position efficiency priors. Deliberately coarse: the
 *  usage model shrinks observed efficiency toward these, and the calibration
 *  measures whether that shrinkage is set right. */
const EFF_PRIOR: Record<string, Efficiency> = {
  QB: { ydsPerTarget: 0, ydsPerCarry: 4.4, ydsPerAttempt: 7.1, tdPerTarget: 0, tdPerCarry: 0.05, tdPerAttempt: 0.048, catchRate: 0 },
  RB: { ydsPerTarget: 6.3, ydsPerCarry: 4.3, ydsPerAttempt: 0, tdPerTarget: 0.04, tdPerCarry: 0.032, tdPerAttempt: 0, catchRate: 0.75 },
  WR: { ydsPerTarget: 8.3, ydsPerCarry: 5.5, ydsPerAttempt: 0, tdPerTarget: 0.055, tdPerCarry: 0.05, tdPerAttempt: 0, catchRate: 0.64 },
  TE: { ydsPerTarget: 7.6, ydsPerCarry: 0, ydsPerAttempt: 0, tdPerTarget: 0.062, tdPerCarry: 0, tdPerAttempt: 0, catchRate: 0.69 },
};

function weekArg(argv: string[]): number | null {
  const a = argv.find((x) => x.startsWith("--week="));
  const v = a ? Number(a.slice("--week=".length)) : NaN;
  return Number.isInteger(v) && v >= 1 && v <= 18 ? v : null;
}

async function main() {
  const lane = parseLane(process.argv);
  const week = weekArg(process.argv);
  if (week == null) {
    throw new Error("build-week needs --week=N (1-18). The current week is not inferred, so a rerun is reproducible.");
  }
  const warnings: string[] = [];
  const sources: WeekBoard["meta"]["sources"] = [];
  const track = <T extends { fetchedAt: string; fromFixture: boolean }>(name: string, r: T): T => {
    sources.push({ name, fetchedAt: r.fetchedAt, fromFixture: r.fromFixture });
    if (r.fromFixture) warnings.push(`${name} came from a committed fixture (${r.fetchedAt})`);
    return r;
  };

  const [sleeper, espn, vegas, nfl, ids] = await Promise.all([
    fetchSleeperWeekly(SEASON, week).then((r) => track("sleeper-weekly", r)),
    fetchEspnWeekly(SEASON, week).then((r) => track("espn-weekly", r)),
    fetchVegasWeek(SEASON, week).then((r) => track("vegas", r)),
    fetchNflverseWeekly(SEASON).then((r) => track("nflverse-weekly", r)),
    fetchPlayerIds({ fixtureOnly: true }).then((r) => track("player-ids", r)),
  ]);

  // --- crosswalks -----------------------------------------------------------
  // fetchPlayerIds returns the raw CSV body (verified in lib/etl/fetchers.ts:135).
  const cross = parseCsv(ids.data);
  const gsisToSleeper: Record<string, string> = {};
  const espnToSleeper: Record<string, string> = {};
  for (const r of cross) {
    if (r.sleeper_id && r.gsis_id) gsisToSleeper[r.gsis_id] = r.sleeper_id;
    if (r.sleeper_id && r.espn_id) espnToSleeper[r.espn_id] = r.sleeper_id;
  }

  // --- defense vs position, through the week being predicted ---------------
  const dvpRes = buildDvp(nfl.data, {
    season: SEASON,
    throughWeek: week,
    lambda: DEFAULT_WEEKLY_MODEL.matchup.dvpLambda,
  });
  const dvpLookup = (defense: string, pos: Position) => ({
    allowed: dvpRes.table[defense]?.[pos],
    leagueAvg: dvpRes.leagueAvg[pos],
    games: dvpRes.gamesByTeam[defense] ?? 0,
  });

  // --- usage history --------------------------------------------------------
  const usageBySleeper = remapToSleeper(
    buildUsageHistory(nfl.data, { season: SEASON, throughWeek: week }),
    gsisToSleeper
  );

  // Team volume for the week: the team's own recent mean, a stable starting
  // point. The environment multiplier in the engine does the Vegas scaling, so
  // baking it in here too would double-count it.
  const teamVol = teamVolumes(nfl.data, SEASON, week);

  // --- one board per scoring format ----------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  for (const format of FORMATS) {
    const seasonBoard: Board = JSON.parse(
      readFileSync(join(OUT_DIR, `board-${format}.json`), "utf8")
    );
    const scoring = seasonBoard.meta.scoring ?? SCORING_PRESETS[format];
    const byeOf = new Map(seasonBoard.players.map((p) => [p.id, p.bye]));

    const espnBySleeper: Record<string, { stats: import("../lib/types").StatLine }> = {};
    for (const [espnId, v] of Object.entries(espn.data)) {
      const sid = espnToSleeper[espnId];
      if (sid) espnBySleeper[sid] = { stats: v.stats };
    }

    const linesByTeam: Record<string, WeekLine> = {};
    for (const p of seasonBoard.players) {
      if (linesByTeam[p.team]) continue;
      const l = lineFor(vegas.data, p.team);
      if (l) linesByTeam[p.team] = l;
    }

    const players: WeekPlayerInput[] = seasonBoard.players.map((p) => {
      const s = sleeper.data[p.id];
      const hist = usageBySleeper[p.id] ?? [];
      let usage: import("../lib/types").StatLine | undefined;
      if (hist.length > 0 && EFF_PRIOR[p.pos]) {
        const observed = rollingShares(hist, DEFAULT_WEEKLY_MODEL.usage.lambda);
        const prior = priorShares(p, seasonBoard, teamVol);
        const shares = blendWithPrior(observed, prior, DEFAULT_WEEKLY_MODEL.usage.priorGames);
        usage = projectUsageStatLine(
          {
            pos: p.pos,
            shares,
            teamVolume: teamVol[p.team] ?? { targets: 32, carries: 25, attempts: 32 },
            efficiency: observedEfficiency(hist, EFF_PRIOR[p.pos]),
            priorEfficiency: EFF_PRIOR[p.pos],
          },
          DEFAULT_WEEKLY_MODEL
        );
      }
      return {
        id: p.id,
        pos: p.pos,
        team: p.team,
        bye: byeOf.get(p.id) ?? p.bye,
        status: s?.status ?? p.injury,
        sleeper: s?.stats && Object.keys(s.stats).length > 0 ? s.stats : undefined,
        sleeperPoints: s?.points,
        espn: espnBySleeper[p.id]?.stats,
        usage,
      };
    });

    const outlooks = buildWeekOutlooks({
      week,
      players,
      linesByTeam,
      dvp: dvpLookup,
      scoring,
      params: DEFAULT_WEEKLY_MODEL,
    });

    const board: WeekBoard = {
      meta: { season: SEASON, week, builtAt: new Date().toISOString(), lane, scoring: format, sources, warnings },
      outlooks,
    };
    writeFileSync(join(OUT_DIR, `week-${SEASON}-${week}-${format}.json`), JSON.stringify(board));
    console.log(`week-${SEASON}-${week}-${format}.json — ${outlooks.length} outlooks`);
  }

  if (DEFAULT_WEEKLY_MODEL.fittedOn.length === 0) {
    console.warn(
      "\n⚠️  weekly-model.json is still in its OFF state (nothing fitted). " +
        "These outlooks are raw Sleeper projections re-scored — the baseline, not the model. " +
        "Run `pnpm calibrate:weekly` and `pnpm backtest:weekly`.\n"
    );
  }
  for (const w of warnings) console.warn(`⚠️  ${w}`);
}

/** Mean team volume per game so far this season, per team. */
function teamVolumes(
  rows: Record<string, string>[],
  season: number,
  throughWeek: number
): Record<string, { targets: number; carries: number; attempts: number }> {
  const acc: Record<string, { targets: number; carries: number; attempts: number; weeks: Set<number> }> = {};
  for (const r of rows) {
    if (r.season !== String(season) || r.season_type !== "REG") continue;
    const w = Number(r.week);
    if (!Number.isFinite(w) || w >= throughWeek) continue;
    const t = canonicalTeam(r.team);
    if (!t) continue;
    const cell = (acc[t] ??= { targets: 0, carries: 0, attempts: 0, weeks: new Set() });
    cell.targets += num(r.targets);
    cell.carries += num(r.carries);
    cell.attempts += num(r.attempts);
    cell.weeks.add(w);
  }
  const out: Record<string, { targets: number; carries: number; attempts: number }> = {};
  for (const [t, c] of Object.entries(acc)) {
    const n = Math.max(1, c.weeks.size);
    out[t] = { targets: c.targets / n, carries: c.carries / n, attempts: c.attempts / n };
  }
  return out;
}

/**
 * Preseason prior share: the player's season projection as a fraction of his
 * team's, converted into a share of team volume. Crude but the right shape —
 * it is what week 1 leans on, and it is shrunk out by week 8.
 */
function priorShares(
  p: Board["players"][number],
  board: Board,
  teamVol: Record<string, { targets: number; carries: number; attempts: number }>
): Shares {
  const mates = board.players.filter((x) => x.team === p.team && x.pos === p.pos);
  const posTotal = mates.reduce((s, x) => s + Math.max(0, x.projPoints), 0);
  const frac = posTotal > 0 ? Math.max(0, p.projPoints) / posTotal : 0;
  // Rough per-position slice of team volume that the whole position group owns.
  const groupShare: Record<string, { t: number; c: number; a: number }> = {
    QB: { t: 0, c: 0.08, a: 1 },
    RB: { t: 0.2, c: 0.9, a: 0 },
    WR: { t: 0.58, c: 0.04, a: 0 },
    TE: { t: 0.2, c: 0, a: 0 },
    K: { t: 0, c: 0, a: 0 },
    DST: { t: 0, c: 0, a: 0 },
  };
  const g = groupShare[p.pos] ?? { t: 0, c: 0, a: 0 };
  return { targetShare: frac * g.t, carryShare: frac * g.c, attemptShare: frac * g.a, games: 0 };
}

/** Observed per-touch efficiency over the history we have. */
function observedEfficiency(
  hist: import("../lib/engine/weekly/usageModel").UsageWeek[],
  prior: Efficiency
): Efficiency {
  let targets = 0, carries = 0, attempts = 0, recYds = 0, rushYds = 0, passYds = 0;
  for (const w of hist) {
    targets += w.targets;
    carries += w.carries;
    attempts += w.attempts;
    recYds += w.recYds;
    rushYds += w.rushYds;
    passYds += w.passYds;
  }
  // Touchdown rates are NOT estimated from a handful of games — that is the
  // single loudest source of false confidence in weekly projections. They stay
  // at the prior and the model's effReliability never touches them.
  return {
    ydsPerTarget: targets > 0 ? recYds / targets : prior.ydsPerTarget,
    ydsPerCarry: carries > 0 ? rushYds / carries : prior.ydsPerCarry,
    ydsPerAttempt: attempts > 0 ? passYds / attempts : prior.ydsPerAttempt,
    tdPerTarget: prior.tdPerTarget,
    tdPerCarry: prior.tdPerCarry,
    tdPerAttempt: prior.tdPerAttempt,
    catchRate: prior.catchRate,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
