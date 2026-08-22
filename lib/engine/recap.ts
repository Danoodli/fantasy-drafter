// Post-draft recap: who actually won the draft. Pure functions — the UI
// layer just renders these.

import type { BoardPlayer, DraftPick, LeagueConfig, TradedPick } from "../types";
import { pickOwner } from "../draft/snake";
import { optimalLineupTotal } from "./season";

export interface TeamRecap {
  slot: number;
  roster: BoardPlayer[];
  /** Projected points of the best legal starting lineup (season totals). */
  starterProj: number;
  /** Projected points sitting on the bench. */
  benchProj: number;
  totalVorp: number;
  /** Ranking score: starters dominate; depth matters more in best ball. */
  score: number;
}

export function buildRecap(
  picks: DraftPick[],
  byId: Map<string, BoardPlayer>,
  config: LeagueConfig,
  tradedPicks: TradedPick[]
): TeamRecap[] {
  const rosters = new Map<number, BoardPlayer[]>();
  for (let s = 1; s <= config.teams; s++) rosters.set(s, []);
  for (const pick of picks) {
    const player = byId.get(pick.playerId);
    if (!player) continue;
    const owner = pickOwner(pick.pickNo, config.teams, tradedPicks);
    rosters.get(owner)?.push(player);
  }
  const benchWeight = config.leagueType === "bestball" ? 0.45 : 0.2;
  const out: TeamRecap[] = [];
  for (const [slot, roster] of rosters) {
    const starterProj = optimalLineupTotal(
      roster.map((p) => ({ pos: p.pos, score: p.projPoints })),
      config
    );
    const totalProj = roster.reduce((a, p) => a + p.projPoints, 0);
    const benchProj = totalProj - starterProj;
    out.push({
      slot,
      roster,
      starterProj: Math.round(starterProj),
      benchProj: Math.round(benchProj),
      totalVorp: Math.round(roster.reduce((a, p) => a + p.vorp, 0)),
      score: starterProj + benchWeight * benchProj,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Letter grade from finishing position (0-indexed rank of n teams). */
export function gradeFor(rank: number, n: number): string {
  const pct = n <= 1 ? 0 : rank / (n - 1);
  if (pct <= 0.08) return "A+";
  if (pct <= 0.25) return "A";
  if (pct <= 0.42) return "B+";
  if (pct <= 0.58) return "B";
  if (pct <= 0.75) return "C+";
  if (pct <= 0.9) return "C";
  return "D";
}

export interface Superlative {
  label: string;
  player: BoardPlayer;
  slot: number;
  pickNo: number;
  detail: string;
}

/** Steal and reach of the draft, from actual pick numbers vs ADP. */
export function superlatives(
  picks: DraftPick[],
  byId: Map<string, BoardPlayer>,
  teams: number,
  tradedPicks: TradedPick[]
): Superlative[] {
  let steal: { pick: DraftPick; p: BoardPlayer; delta: number } | null = null;
  let reach: { pick: DraftPick; p: BoardPlayer; delta: number } | null = null;
  for (const pick of picks) {
    if (pick.isKeeper) continue;
    const p = byId.get(pick.playerId);
    if (!p || p.adp > 180) continue; // deep fliers aren't steals or reaches
    const delta = pick.pickNo - p.adp; // + = fell past ADP (steal)
    if (!steal || delta > steal.delta) steal = { pick, p, delta };
    if (!reach || delta < reach.delta) reach = { pick, p, delta };
  }
  const out: Superlative[] = [];
  if (steal && steal.delta >= 6) {
    out.push({
      label: "Steal of the draft",
      player: steal.p,
      slot: pickOwner(steal.pick.pickNo, teams, tradedPicks),
      pickNo: steal.pick.pickNo,
      detail: `fell ${Math.round(steal.delta)} past ADP ${steal.p.adp.toFixed(0)}`,
    });
  }
  if (reach && reach.delta <= -6) {
    out.push({
      label: "Biggest reach",
      player: reach.p,
      slot: pickOwner(reach.pick.pickNo, teams, tradedPicks),
      pickNo: reach.pick.pickNo,
      detail: `taken ${Math.round(-reach.delta)} before ADP ${reach.p.adp.toFixed(0)}`,
    });
  }
  return out;
}
