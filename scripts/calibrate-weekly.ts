// Fits config/weekly-model.json from the committed weekly history.
//
// THE CENTRAL DISCIPLINE: every adjustment coefficient is fitted on the
// RESIDUAL log(actual / baseMarket), never on actual points. Sleeper's
// projection already embeds part of the Vegas line and part of the matchup;
// fitting on actuals would count that signal twice and produce a model that
// loses to the single API call it is built on. Expect small coefficients.
// Small and real beats large and double-counted.
//
// Usage: pnpm calibrate:weekly [--holdout=2025]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeHistory, type HistRow } from "../lib/etl/weekly/history";
import { olsFit, MIN_ABS_T, fitSigmaByVolume } from "../lib/engine/weekly/fit";
import { impliedTeamPoints } from "../lib/engine/weekly/environment";
import { projectedVolume } from "../lib/engine/weekly/spread";
import { SCORING_PRESETS, scoreStatLine } from "../lib/scoring";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";
import type { Position } from "../lib/types";

const HIST_DIR = join(process.cwd(), "data", "historical-data", "weekly");
const CONFIG = join(process.cwd(), "config", "weekly-model.json");
const ALL_SEASONS = [2021, 2022, 2023, 2024, 2025];
const POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];
const scoring = SCORING_PRESETS.ppr;

interface FitRow extends HistRow {
  season: number;
  base: number; // market projection, PPR
  actual: number; // realized points, PPR — only when he played
  played: boolean;
  itpOwn: number;
  itpOpp: number;
  volume: number;
}

function load(seasons: number[]): FitRow[] {
  const out: FitRow[] = [];
  for (const season of seasons) {
    const path = join(HIST_DIR, `${season}.json`);
    if (!existsSync(path)) throw new Error(`missing ${path} — run pnpm build:weekly-history first`);
    for (const r of decodeHistory(readFileSync(path, "utf8"))) {
      const base = scoreStatLine(r.proj, scoring, r.pos === "TE");
      if (!(base > 0)) continue;
      out.push({
        ...r,
        season,
        base,
        actual: r.act ? scoreStatLine(r.act, scoring, r.pos === "TE") : 0,
        played: r.act !== null,
        itpOwn: impliedTeamPoints(r.tot, r.spr),
        itpOpp: impliedTeamPoints(r.tot, -r.spr),
        volume: projectedVolume(r.pos, r.proj),
      });
    }
  }
  return out;
}

/**
 * Rolling points allowed per defense per position, computed strictly from
 * weeks BEFORE the row's week — the same leak-free construction buildDvp uses
 * at runtime. Fitting gamma against a table that includes the week being
 * predicted would produce a large, entirely fake coefficient.
 */
function dvpRatios(rows: FitRow[]): Map<FitRow, number> {
  const played = rows.filter((r) => r.played);
  // (season, defense, pos) → week → { pts, n }
  const acc = new Map<string, Map<number, { pts: number; n: number }>>();
  for (const r of played) {
    const k = `${r.season}|${r.opp}|${r.pos}`;
    const byWeek = acc.get(k) ?? new Map();
    const cell = byWeek.get(r.wk) ?? { pts: 0, n: 0 };
    cell.pts += r.actual;
    cell.n += 1;
    byWeek.set(r.wk, cell);
    acc.set(k, byWeek);
  }
  // League average allowed per position per season, for the ratio's denominator.
  const leagueAvg = new Map<string, number>();
  for (const pos of POSITIONS) {
    for (const season of ALL_SEASONS) {
      const vals: number[] = [];
      for (const [k, byWeek] of acc) {
        if (!k.startsWith(`${season}|`) || !k.endsWith(`|${pos}`)) continue;
        for (const c of byWeek.values()) vals.push(c.pts);
      }
      if (vals.length) leagueAvg.set(`${season}|${pos}`, vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  }
  const out = new Map<FitRow, number>();
  for (const r of rows) {
    const byWeek = acc.get(`${r.season}|${r.opp}|${r.pos}`);
    const avg = leagueAvg.get(`${r.season}|${r.pos}`);
    if (!byWeek || !avg || !(avg > 0)) continue;
    let pts = 0;
    let weeks = 0;
    for (const [wk, c] of byWeek) {
      if (wk >= r.wk) continue; // strictly prior weeks
      pts += c.pts;
      weeks++;
    }
    if (weeks < 2) continue;
    const allowed = pts / weeks;
    // Shrink exactly as matchMult will at runtime, so the fitted gamma is the
    // exponent on the SHRUNK ratio, not on the raw one.
    const k = DEFAULT_WEEKLY_MODEL.matchup.shrinkGames;
    const shrunk = 1 + (weeks / (weeks + k)) * (allowed / avg - 1);
    if (shrunk > 0) out.set(r, shrunk);
  }
  return out;
}

function main() {
  const holdoutArg = process.argv.find((a) => a.startsWith("--holdout="));
  const holdout = holdoutArg ? Number(holdoutArg.slice("--holdout=".length)) : null;
  const fitSeasons = holdout ? ALL_SEASONS.filter((s) => s !== holdout) : ALL_SEASONS;
  console.log(`fitting on ${fitSeasons.join(", ")}${holdout ? ` (holding out ${holdout})` : ""}`);

  const rows = load(fitSeasons);
  const active = rows.filter((r) => r.played && r.actual > 0);
  console.log(`${rows.length} player-weeks, ${active.length} with a realized score`);

  const params: WeeklyModelParams = JSON.parse(JSON.stringify(DEFAULT_WEEKLY_MODEL));
  params.fittedOn = fitSeasons;
  // params was deep-copied from DEFAULT_WEEKLY_MODEL, i.e. the config THIS
  // SCRIPT wrote last run — which may already carry non-zero alpha/beta/gamma
  // from a prior fit. `keep()` returning null only skips an assignment; it
  // does not clear a stale value already sitting in the copy. Reset all three
  // before fitting so a coefficient that is zeroed THIS run is actually
  // absent from the written config, not silently left over from last time.
  params.environment.alpha = {};
  params.environment.beta = {};
  params.matchup.gamma = {};

  // --- availability: DELIBERATELY NOT FITTED --------------------------------
  //
  // An earlier draft of this plan fitted availability.byStatus and
  // availability.healthy from the history's status field. That is unsound and
  // would have been actively dangerous.
  //
  // Sleeper serves historical weekly projections with a LIVE injury-status
  // field, not the week's. Two fetches of the same past week 2h45m apart
  // changed 12 of 325 statuses in both directions while changing 0 stat lines,
  // and in the assembled fit set players marked "Out" have a 0% did-not-play
  // rate — impossible if the designation were contemporaneous.
  //
  // Fitting it anyway would have learned "Out implies about a 95% chance of
  // playing", because Out-labelled rows in the set mostly did play. The engine
  // would then have told the user to start a player who is ruled out, from a
  // calibration that looked entirely successful.
  //
  // So availability keeps its hand-set FALLBACK_PLAY_PROB and its
  // availability.healthy default, and stays the one uncalibrated part of the
  // model. This is a data-source limitation, not a modelling choice, and it is
  // recorded as such in docs/backtest-gates.md.
  //
  // It is fixable going forward: the weekly lane commits
  // data/raw/weekly/sleeper-week-{season}-{week}.json with the status as of
  // build time, so from now on the repo accumulates CONTEMPORANEOUS statuses.
  // After a season of those, availability becomes calibratable from them.
  console.log("availability: NOT fitted (historical status is a live field — see comment)");

  // --- KEEP ONLY WHAT THE DATA CAN DISTINGUISH FROM ZERO -------------------
  //
  // Weekly fantasy residuals are enormously noisy: the log-residual standard
  // deviation is 0.57 to 0.84 by position. A regression over thousands of rows
  // can therefore produce a confident-looking coefficient that is pure noise,
  // and shipping it adds variance with no signal.
  //
  // Measured on 10,131 fitted player-weeks (2021-24, holding out 2025), EVERY
  // environment and matchup coefficient came out with |t| < 1.96:
  //   alpha  QB t=0.66  RB t=1.65  WR t=-0.61  TE t=-1.05
  //   gamma  QB t=-0.10 RB t=0.70  WR t=-1.62  TE t=-1.06
  // The negative WR/TE signs that look like "the market over-corrects" are not
  // a finding — they are noise, and their sign is arbitrary.
  //
  // So a coefficient is kept only when |t| >= MIN_ABS_T, and omitted
  // otherwise, which leaves that lever exactly neutral. Expect most or all of
  // alpha, beta and gamma to be omitted at this sample size. That is the
  // honest result, not a failure: it says Sleeper's projection already prices
  // in the environment and the matchup, and the value this engine adds is in
  // the DISTRIBUTION (fitted sigma, fitted correlation, availability, exact
  // byes) rather than in a better mean.
  const keep = (label: string, f: { slope: number; t: number; n: number }): number | null => {
    const ok = Math.abs(f.t) >= MIN_ABS_T;
    console.log(
      `  ${label}: ${f.slope.toFixed(4)} (t=${f.t.toFixed(2)}, n=${f.n}) ${ok ? "KEPT" : "zeroed — indistinguishable from 0"}`
    );
    return ok ? round3(f.slope) : null;
  };

  // --- environment: alpha on log(itp / leagueAvgItp) ------------------------
  const avgItp = active.reduce((s, r) => s + r.itpOwn, 0) / active.length;
  params.environment.leagueAvgItp = Math.round(avgItp * 10) / 10;
  for (const pos of POSITIONS) {
    const sub = active.filter((r) => r.pos === pos);
    const xs = sub.map((r) => Math.log(Math.max(0.2, r.itpOwn / avgItp)));
    const ys = sub.map((r) => Math.log(r.actual / r.base));
    const a = keep(`alpha.${pos}`, olsFit(xs, ys));
    if (a !== null) params.environment.alpha[pos] = a;
  }
  // DST reads the OPPONENT's implied total. No DST rows are in the history set
  // (Sleeper's DEF projections carry no yardage), so alpha.DST stays unfitted
  // and neutral until a DST history source exists. Stated, not silently zero.
  console.log("environment.alpha:", params.environment.alpha);

  // --- environment: beta on favoredness, AFTER removing alpha ---------------
  for (const pos of POSITIONS) {
    const sub = active.filter((r) => r.pos === pos);
    const a = params.environment.alpha[pos] ?? 0;
    // On ownSpread directly, matching scriptMult in lib/engine/weekly/environment.ts.
    // Regressing on -spr/7 here while the runtime applies +spr/7 would invert
    // every fitted game-script adjustment, silently and undetectably.
    const xs = sub.map((r) => r.spr / 7);
    const ys = sub.map(
      (r) => Math.log(r.actual / r.base) - a * Math.log(Math.max(0.2, r.itpOwn / avgItp))
    );
    const b = keep(`beta.${pos}`, olsFit(xs, ys));
    if (b !== null) params.environment.beta[pos] = b;
  }
  console.log("environment.beta:", params.environment.beta);

  // --- matchup: gamma on log(shrunk DvP ratio), after alpha and beta --------
  const ratios = dvpRatios(rows);
  for (const pos of POSITIONS) {
    const sub = active.filter((r) => r.pos === pos && ratios.has(r));
    const a = params.environment.alpha[pos] ?? 0;
    const b = params.environment.beta[pos] ?? 0;
    const xs = sub.map((r) => Math.log(ratios.get(r)!));
    const ys = sub.map(
      (r) =>
        Math.log(r.actual / r.base) -
        a * Math.log(Math.max(0.2, r.itpOwn / avgItp)) -
        Math.log(Math.max(0.4, 1 + b * (r.spr / 7)))
    );
    const g = keep(`gamma.${pos}`, olsFit(xs, ys));
    if (g !== null) params.matchup.gamma[pos] = g;
  }

  // --- sigma: fitted on the residual AFTER all adjustments -----------------
  //
  // NOT subject to the significance filter above, and the distinction is the
  // point. Alpha/beta/gamma are asking "is there a mean effect here at all",
  // which the data cannot answer. Sigma asks "how wide is the residual", which
  // is directly measured and extremely well determined — that spread is the
  // one thing 10,000 noisy rows tell you precisely. Same for the correlations
  // below: they are measured co-movement, not a hypothesis test.
  for (const pos of POSITIONS) {
    const sub = active.filter((r) => r.pos === pos);
    const v0 = DEFAULT_WEEKLY_MODEL.sigma.v0[pos] ?? 8;
    const points = sub.map((r) => ({
      volume: r.volume,
      logResidual: Math.log(r.actual / adjustedMean(r, params, avgItp, ratios)),
    }));
    const { sigma0, delta } = fitSigmaByVolume(points, v0);
    params.sigma.sigma0[pos] = round3(sigma0);
    // delta is shared across positions: per-position deltas fitted on this much
    // noise flip sign between seasons. One number, fitted on the pooled set.
    console.log(`  ${pos}: sigma0 ${sigma0.toFixed(3)}, delta ${delta.toFixed(3)}`);
  }
  const pooled = active.map((r) => ({
    volume: r.volume / (DEFAULT_WEEKLY_MODEL.sigma.v0[r.pos] ?? 8),
    logResidual: Math.log(r.actual / adjustedMean(r, params, avgItp, ratios)),
  }));
  params.sigma.delta = round3(Math.max(0, fitSigmaByVolume(pooled, 1).delta));
  console.log("sigma.delta (pooled):", params.sigma.delta);

  // --- correlation: within-team and within-unit residual co-movement --------
  params.correlation = fitCorrelations(active, params, avgItp, ratios);
  console.log("correlation:", params.correlation);

  // NOTE: sourceWeights and modelWeights are NOT fitted here. They need
  // ESPN/DK weekly history and a usage backfill, neither of which the history
  // set carries yet. They stay at their off-state values (sleeper 1, usage 0)
  // and Task 17's gate 1 measures the model against exactly that baseline.
  // Fitting them is the first follow-up once weekly ESPN snapshots accumulate.

  writeFileSync(CONFIG, JSON.stringify(params, null, 2) + "\n");
  console.log(`\nwrote ${CONFIG}`);
}

function adjustedMean(
  r: FitRow,
  p: WeeklyModelParams,
  avgItp: number,
  ratios: Map<FitRow, number>
): number {
  const a = p.environment.alpha[r.pos] ?? 0;
  const b = p.environment.beta[r.pos] ?? 0;
  const g = p.matchup.gamma[r.pos] ?? 0;
  const ratio = ratios.get(r);
  const mEnv = a ? Math.pow(Math.max(0.2, r.itpOwn / avgItp), a) : 1;
  const mScript = b ? Math.max(0.4, 1 + b * (r.spr / 7)) : 1;
  const mMatch = g && ratio ? Math.pow(Math.max(0.2, ratio), g) : 1;
  return Math.max(0.1, r.base * mEnv * mScript * mMatch);
}

/**
 * Empirical correlation of log residuals for pairs sharing a game, a team, and
 * a unit. Nesting is enforced by construction (each level is at least the one
 * above it) so correlationAmplitudes never sees an invalid set.
 */
function fitCorrelations(
  active: FitRow[],
  p: WeeklyModelParams,
  avgItp: number,
  ratios: Map<FitRow, number>
): WeeklyModelParams["correlation"] {
  const resid = new Map<FitRow, number>();
  for (const r of active) resid.set(r, Math.log(r.actual / adjustedMean(r, p, avgItp, ratios)));

  const byKey = <K>(keyOf: (r: FitRow) => K) => {
    const groups = new Map<K, FitRow[]>();
    for (const r of active) {
      const k = keyOf(r);
      const list = groups.get(k) ?? [];
      list.push(r);
      groups.set(k, list);
    }
    // Mean pairwise correlation, estimated as the ratio of between-group
    // variance to total variance (an intraclass correlation).
    let grand = 0, n = 0;
    for (const r of active) { grand += resid.get(r)!; n++; }
    grand /= n;
    let ssBetween = 0, ssTotal = 0;
    for (const r of active) ssTotal += (resid.get(r)! - grand) ** 2;
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const m = list.reduce((s, r) => s + resid.get(r)!, 0) / list.length;
      ssBetween += list.length * (m - grand) ** 2;
    }
    return ssTotal > 0 ? Math.max(0, Math.min(0.9, ssBetween / ssTotal)) : 0;
  };

  const game = byKey((r) => `${r.season}|${r.wk}|${[r.team, r.opp].sort().join("-")}`);
  const teamRaw = byKey((r) => `${r.season}|${r.wk}|${r.team}`);
  const unitRaw = byKey((r) => `${r.season}|${r.wk}|${r.team}|${r.pos === "RB" ? "run" : "pass"}`);
  // Enforce nesting rather than shipping a set loadWeeklyModel would reject.
  const team = Math.max(game, teamRaw);
  const unit = Math.max(team, unitRaw);
  return {
    game: round3(game),
    team: round3(team),
    unit: round3(unit),
    // No DST rows in the history set, so this stays at its off value.
    dstVsOppTeam: DEFAULT_WEEKLY_MODEL.correlation.dstVsOppTeam,
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

main();
