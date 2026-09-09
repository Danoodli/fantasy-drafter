// Player and team volume per week, from nflverse's weekly box scores.
// Keyed by gsis id (nflverse's player_id); remapped to sleeper ids via the
// DynastyProcess crosswalk, which carries both for all 12,492 of its rows.
//
// Node-only in the sense that it reads CSV rows, but the aggregation is pure
// and unit-tested — no fetch happens here.
import { canonicalTeam, num, type Row } from "../nflverse";
import type { UsageHistory } from "../../engine/weekly/usageModel";

/**
 * @param throughWeek weeks strictly BEFORE this are included. Passing the week
 *   being predicted keeps the backtest free of leakage.
 */
export function buildUsageHistory(
  rows: Row[],
  opts: { season: number; throughWeek: number }
): UsageHistory {
  const { season, throughWeek } = opts;
  // First pass: team totals per week.
  const team: Record<string, { targets: number; carries: number; attempts: number }> = {};
  const keyOf = (t: string, w: number) => `${t}|${w}`;
  const inScope = (r: Row) => {
    if (r.season !== String(season) || r.season_type !== "REG") return false;
    const w = Number(r.week);
    return Number.isFinite(w) && w < throughWeek;
  };
  for (const r of rows) {
    if (!inScope(r)) continue;
    const t = canonicalTeam(r.team);
    if (!t) continue;
    const k = keyOf(t, Number(r.week));
    const cell = (team[k] ??= { targets: 0, carries: 0, attempts: 0 });
    cell.targets += num(r.targets);
    cell.carries += num(r.carries);
    cell.attempts += num(r.attempts);
  }
  // Second pass: per-player rows carrying their team's totals.
  const out: UsageHistory = {};
  for (const r of rows) {
    if (!inScope(r)) continue;
    const id = r.player_id;
    const t = canonicalTeam(r.team);
    if (!id || !t) continue;
    const week = Number(r.week);
    const tt = team[keyOf(t, week)] ?? { targets: 0, carries: 0, attempts: 0 };
    (out[id] ??= []).push({
      week,
      team: t,
      targets: num(r.targets),
      carries: num(r.carries),
      attempts: num(r.attempts),
      recYds: num(r.receiving_yards),
      rushYds: num(r.rushing_yards),
      passYds: num(r.passing_yards),
      teamTargets: tt.targets,
      teamCarries: tt.carries,
      teamAttempts: tt.attempts,
    });
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.week - b.week);
  return out;
}

/** gsis-keyed history → sleeper-keyed. Unmapped players are dropped. */
export function remapToSleeper(
  history: UsageHistory,
  gsisToSleeper: Record<string, string>
): UsageHistory {
  const out: UsageHistory = {};
  for (const [gsis, weeks] of Object.entries(history)) {
    const sleeper = gsisToSleeper[gsis];
    if (sleeper) out[sleeper] = weeks;
  }
  return out;
}
