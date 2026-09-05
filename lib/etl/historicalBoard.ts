// Rebuild the board as it would have looked on draft day of a past season,
// and pair every player with what he actually scored.
//
// Pure: snapshot + crosswalk in, board + realized points out. The join mirrors
// scripts/build-board.ts (FFC ADP as the spine, ESPN by crosswalk id then by
// normalized name) so a historical board behaves like a live one.

import { baselines } from "../engine/baselines";
import { assignTiers } from "../engine/tiers";
import type { ProjRow } from "../engine/evaluate";
import { SCORING_PRESETS, scoreStatLine } from "../scoring";
import { mergeName, looseName } from "./names";
import type { SeasonPlayer } from "./espn";
import type { SeasonSnapshot } from "./seasonSnapshot";
import type { BoardPlayer, LeagueConfig, Position, ScoringFormat, ScoringSettings } from "../types";

export interface CrossRow {
  sleeper_id: string;
  espn_id: string;
  merge_name: string;
  name: string;
  position: string;
  team: string;
}

export interface RealizedLine {
  /** Realized season points under the league's scoring. */
  season: number;
  /** Realized points by week (index 0 = week 1); null when the player had no line. */
  weekly: (number | null)[];
}

export interface HistoricalBoard {
  board: BoardPlayer[];
  realized: Map<string, RealizedLine>;
  /** Players with a genuine (non-imputed) draft-day projection AND a realized line. */
  projRows: ProjRow[];
  join: {
    ffc: number;
    matched: number;
    imputed: number;
    deepPool: number;
    unmatched: string[];
  };
}

const SKILL: Position[] = ["QB", "RB", "WR", "TE"];
const ALL: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];
const DEEP_POOL_TARGET_SKILL = 480;

function normalizePos(ffcPos: string): Position | null {
  const pos = ffcPos === "PK" ? "K" : ffcPos === "DEF" ? "DST" : ffcPos;
  return (ALL as string[]).includes(pos) ? (pos as Position) : null;
}

function projFor(sp: SeasonPlayer, scoring: ScoringSettings): number {
  if (sp.pos === "K" || sp.pos === "DST") return sp.projApplied;
  return sp.proj ? scoreStatLine(sp.proj, scoring, sp.pos === "TE") : 0;
}

function realizedFor(sp: SeasonPlayer, scoring: ScoringSettings): RealizedLine {
  if (sp.pos === "K" || sp.pos === "DST") {
    return { season: sp.actualApplied, weekly: sp.weeklyApplied };
  }
  return {
    season: sp.actual ? scoreStatLine(sp.actual, scoring, sp.pos === "TE") : 0,
    weekly: sp.weekly.map((w) => (w ? scoreStatLine(w, scoring, sp.pos === "TE") : null)),
  };
}

/** Same neighbor interpolation as the live ETL, so imputed players behave alike. */
function imputeProjections(players: BoardPlayer[]): number {
  let imputed = 0;
  for (const pos of ALL) {
    const group = players.filter((p) => p.pos === pos).sort((a, b) => a.adp - b.adp);
    for (let i = 0; i < group.length; i++) {
      const p = group[i];
      if (p.projPoints > 0) continue;
      const prev = group.slice(0, i).reverse().find((g) => g.projPoints > 0);
      const next = group.slice(i + 1).find((g) => g.projPoints > 0);
      if (prev && next) p.projPoints = (prev.projPoints + next.projPoints) / 2;
      else if (prev) p.projPoints = prev.projPoints * 0.95;
      else if (next) p.projPoints = next.projPoints * 1.05;
      p.projImputed = true;
      imputed++;
    }
  }
  return imputed;
}

export function buildHistoricalBoard(
  snapshot: SeasonSnapshot,
  cross: CrossRow[],
  format: ScoringFormat,
  config: LeagueConfig
): HistoricalBoard {
  const ffc = snapshot.ffc[format];
  if (!ffc) throw new Error(`snapshot ${snapshot.year} has no FFC ADP for ${format}`);
  const scoring = SCORING_PRESETS[format];

  // ---- indexes --------------------------------------------------------
  const espnById = new Map(snapshot.espn.map((e) => [e.espnId, e]));
  const espnByMerge = new Map<string, SeasonPlayer>();
  const espnByLoose = new Map<string, SeasonPlayer>();
  const espnDstByTeam = new Map<string, SeasonPlayer>();
  for (const e of snapshot.espn) {
    if (e.pos === "DST") espnDstByTeam.set(e.team, e);
    espnByMerge.set(`${mergeName(e.name)}|${e.pos}`, e);
    if (!espnByLoose.has(`${looseName(e.name)}|${e.pos}`)) espnByLoose.set(`${looseName(e.name)}|${e.pos}`, e);
  }
  const crossByMerge = new Map<string, CrossRow[]>();
  for (const r of cross) {
    const key = r.merge_name || mergeName(r.name);
    const list = crossByMerge.get(key) ?? [];
    list.push(r);
    crossByMerge.set(key, list);
  }

  const players: BoardPlayer[] = [];
  const realized = new Map<string, RealizedLine>();
  const espnMatched = new Set<string>();
  const unmatched: string[] = [];

  const push = (
    id: string,
    sp: SeasonPlayer | undefined,
    base: Pick<BoardPlayer, "name" | "pos" | "team" | "bye" | "adp" | "adpStdev" | "adpHigh" | "adpLow" | "ids"> & {
      deepPool?: boolean;
    }
  ) => {
    if (sp) {
      espnMatched.add(sp.espnId);
      realized.set(id, realizedFor(sp, scoring));
    }
    players.push({
      id,
      ...base,
      projPoints: sp ? Math.round(projFor(sp, scoring) * 10) / 10 : 0,
      projImputed: false,
      stats: sp?.proj ?? undefined,
      ecr: null,
      ecrStdev: null,
      vorp: 0,
      vols: 0,
      tier: 0,
      injury: null,
      depthOrder: null,
      sosSeason: null,
      sosPlayoff: null,
      adpSources: { ffc: base.deepPool ? null : base.adp, espn: sp?.adpEspn ?? null, sleeper: null },
    });
  };

  // ---- FFC spine ------------------------------------------------------
  for (const f of ffc.players) {
    const pos = normalizePos(f.position);
    if (!pos) continue;
    let sp: SeasonPlayer | undefined;
    let id: string;
    const ids: BoardPlayer["ids"] = { ffc: String(f.player_id) };

    if (pos === "DST") {
      id = f.team;
      sp = espnDstByTeam.get(f.team);
    } else {
      const merge = mergeName(f.name);
      const rows = (crossByMerge.get(merge) ?? []).filter(
        (c) => !c.position || c.position === pos || (pos === "K" && c.position === "PK")
      );
      const row = rows.length > 1 ? rows.find((c) => c.team === f.team) ?? rows[0] : rows[0];
      id = row?.sleeper_id && row.sleeper_id !== "NA" ? row.sleeper_id : `ffc-${f.player_id}`;
      if (row?.espn_id && row.espn_id !== "NA") {
        ids.espn = row.espn_id;
        sp = espnById.get(row.espn_id);
      }
      sp ??= espnByMerge.get(`${merge}|${pos}`) ?? espnByLoose.get(`${looseName(f.name)}|${pos}`);
      if (sp) ids.espn = sp.espnId;
    }
    if (!sp) unmatched.push(`${f.name} (${pos}, ADP ${f.adp})`);
    push(id, sp, {
      name: f.name,
      pos,
      team: f.team,
      bye: f.bye ?? null,
      adp: f.adp,
      adpStdev: f.stdev,
      adpHigh: f.high,
      adpLow: f.low,
      ids,
    });
  }

  // ---- deep pool ------------------------------------------------------
  // FFC stops around pick 180. Every ESPN player it doesn't list goes on the
  // tail, ordered by ESPN's own ADP where it has one, so a 20-round best ball
  // can finish and the room can take real fliers rather than nothing.
  const ffcTail = Math.max(0, ...players.filter((p) => SKILL.includes(p.pos)).map((p) => p.adp));
  let budget = DEEP_POOL_TARGET_SKILL - players.filter((p) => SKILL.includes(p.pos)).length;
  let deepPool = 0;
  const teamBye = new Map<string, number>();
  for (const p of players) if (p.bye != null && !teamBye.has(p.team)) teamBye.set(p.team, p.bye);
  const tail = snapshot.espn
    .filter((e) => SKILL.includes(e.pos) && !espnMatched.has(e.espnId) && e.team)
    .sort((a, b) => (a.adpEspn ?? 9999) - (b.adpEspn ?? 9999) || b.projApplied - a.projApplied);
  for (const e of tail) {
    if (budget-- <= 0) break;
    const adp = Math.max(ffcTail + 1 + deepPool * 0.5, e.adpEspn ?? 0);
    push(`espn-${e.espnId}`, e, {
      name: e.name,
      pos: e.pos,
      team: e.team,
      bye: teamBye.get(e.team) ?? null,
      adp: Math.round(adp * 10) / 10,
      adpStdev: 24,
      adpHigh: Math.max(1, Math.round(adp - 36)),
      adpLow: Math.round(adp + 36),
      ids: { espn: e.espnId },
      deepPool: true,
    });
    players[players.length - 1].deepPool = true;
    deepPool++;
  }

  // ---- projections → value → tiers -----------------------------------
  const imputed = imputeProjections(players);
  const byPos = new Map<Position, number[]>();
  for (const pos of ALL) {
    byPos.set(pos, players.filter((p) => p.pos === pos).map((p) => p.projPoints).sort((a, b) => b - a));
  }
  const base = baselines(byPos, config);
  for (const p of players) {
    const b = base.get(p.pos)!;
    p.vorp = Math.round((p.projPoints - b.vorp) * 10) / 10;
    p.vols = Math.round((p.projPoints - b.vols) * 10) / 10;
  }
  for (const pos of ALL) {
    const group = players.filter((p) => p.pos === pos).sort((a, b) => b.projPoints - a.projPoints);
    const tiers = assignTiers(group.map((p) => p.projPoints));
    group.forEach((p, i) => (p.tier = tiers[i]));
  }
  players.sort((a, b) => a.adp - b.adp);

  const projRows: ProjRow[] = players
    .filter((p) => !p.projImputed && p.projPoints > 0 && realized.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, pos: p.pos, proj: p.projPoints, actual: realized.get(p.id)!.season, adp: p.adp }));

  return {
    board: players,
    realized,
    projRows,
    join: { ffc: ffc.players.length, matched: espnMatched.size, imputed, deepPool, unmatched },
  };
}
