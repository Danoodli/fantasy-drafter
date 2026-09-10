// lib/engine/season/trade.ts
// Three-axis trade evaluation. Pure.
//
//   points  — delta rest-of-season lineup points (rosValue.ts)
//   odds    — delta playoff odds, when the league is known (playoffOdds.ts),
//             with the partner's roster changed too so the league they play
//             in is the league after the trade
//   cover   — delta empty slot-weeks (byes and season-long designations)
//
// The verdict is three words and a sentence, never one number.
import type { BoardPlayer } from "../../types";
import { emptySlotWeeks, meansFor, rosLineupValue, type RosContext } from "./rosValue";
import { playoffOdds, type LeagueTeamInput } from "./playoffOdds";

export interface TradeAxis {
  delta: number;
  verdict: "up" | "down" | "flat";
}

export interface TradeLeagueContext {
  teams: LeagueTeamInput[];
  schedule: Record<number, [number, number][]>;
  currentWeek: number;
  playoffWeekStart: number;
  playoffTeams: number;
  myRosterId: number;
  /** The other side of the deal, when known; their roster is updated too. */
  partnerRosterId?: number;
  sims?: number;
  seed?: number;
}

export interface TradeInput extends RosContext {
  roster: BoardPlayer[];
  /** Ids leaving my roster. */
  give: string[];
  /** Players arriving. */
  receive: BoardPlayer[];
  league?: TradeLeagueContext;
}

export interface TradeVerdict {
  points: TradeAxis;
  playoffOdds: TradeAxis | null;
  cover: TradeAxis;
  rosterAfter: BoardPlayer[];
  summary: string;
}

// Presentation thresholds — below these a change reads as "flat". They are
// not model levers (nothing is fitted against them), so they stay here.
const FLAT_POINTS = 2;
const FLAT_ODDS = 0.01;
const FLAT_COVER = 0.5;
/**
 * Fewer sims than playoffOdds' own default (500): a trade check runs twice
 * (before/after) on a click, and the two runs share a seed, so the DELTA is far
 * less noisy than either absolute number.
 */
const TRADE_SIMS = 200;

function axis(delta: number, flat: number): TradeAxis {
  return { delta, verdict: delta > flat ? "up" : delta < -flat ? "down" : "flat" };
}

function summarize(points: TradeAxis, odds: TradeAxis | null, cover: TradeAxis, weeks: number): string {
  const parts: string[] = [];
  const span = `over the remaining ${weeks} week${weeks === 1 ? "" : "s"}`;
  if (points.verdict === "up") parts.push(`adds ${points.delta.toFixed(0)} lineup points ${span}`);
  else if (points.verdict === "down") parts.push(`costs ${(-points.delta).toFixed(0)} lineup points ${span}`);
  else parts.push(`leaves lineup points about even ${span}`);
  if (odds) {
    const pp = Math.abs(Math.round(odds.delta * 100));
    const unit = pp === 1 ? "point" : "points";
    if (odds.verdict === "up") parts.push(`raises playoff odds ${pp} ${unit}`);
    else if (odds.verdict === "down") parts.push(`lowers playoff odds ${pp} ${unit}`);
    else parts.push(`barely moves playoff odds`);
  }
  if (cover.verdict === "down") parts.push(`costs ${(-cover.delta).toFixed(0)} slot-week${cover.delta <= -1.5 ? "s" : ""} of bye/injury cover`);
  else if (cover.verdict === "up") parts.push(`adds ${cover.delta.toFixed(0)} slot-week${cover.delta >= 1.5 ? "s" : ""} of cover`);
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

export function evaluateTrade(input: TradeInput): TradeVerdict {
  const { roster, give, receive } = input;
  const ctx: RosContext = { weeks: input.weeks, config: input.config, params: input.params, outlooks: input.outlooks, currentWeek: input.currentWeek };
  const giving = new Set(give);
  const rosterAfter = [...roster.filter((p) => !giving.has(p.id)), ...receive];
  const means = meansFor([...roster, ...receive], ctx);

  const points = axis(rosLineupValue(rosterAfter, ctx, means) - rosLineupValue(roster, ctx, means), FLAT_POINTS);
  // Cover: fewer empty slot-weeks is better, so the delta is before minus after.
  const cover = axis(emptySlotWeeks(roster, ctx) - emptySlotWeeks(rosterAfter, ctx), FLAT_COVER);

  let odds: TradeAxis | null = null;
  if (input.league) {
    const L = input.league;
    const given = roster.filter((p) => giving.has(p.id));
    const receivedIds = new Set(receive.map((p) => p.id));
    const before = L.teams;
    const after = L.teams.map((t) => {
      if (t.rosterId === L.myRosterId) return { ...t, players: rosterAfter };
      if (L.partnerRosterId !== undefined && t.rosterId === L.partnerRosterId) {
        return { ...t, players: [...t.players.filter((p) => !receivedIds.has(p.id)), ...given] };
      }
      return t;
    });
    const common = { schedule: L.schedule, currentWeek: L.currentWeek, playoffWeekStart: L.playoffWeekStart, playoffTeams: L.playoffTeams, config: input.config, myRosterId: L.myRosterId, sims: L.sims ?? TRADE_SIMS, seed: L.seed ?? 1, params: input.params };
    const a = playoffOdds({ ...common, teams: before }).mine.playoffOdds;
    const b = playoffOdds({ ...common, teams: after }).mine.playoffOdds;
    odds = axis(b - a, FLAT_ODDS);
  }

  return { points, playoffOdds: odds, cover, rosterAfter, summary: summarize(points, odds, cover, input.weeks.length) };
}
