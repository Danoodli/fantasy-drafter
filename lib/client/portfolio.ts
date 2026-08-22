// Portfolio exposure across every saved draft — the tool serious best-ball
// players live by: how concentrated am I in each player, team, and stack?
// Pure functions over draft history; the view resolves teams via the board.

import type { BoardPlayer, Position } from "../types";
import type { SavedDraft } from "./history";
import { pickOwner } from "../draft/snake";

export interface ExposureRow {
  id: string;
  name: string;
  pos: Position | null;
  team: string | null;
  count: number;
  pct: number; // share of drafts
}

export interface Portfolio {
  totalDrafts: number;
  players: ExposureRow[];
  teams: { team: string; count: number }[];
  stacks: { label: string; count: number }[];
}

export function computePortfolio(
  drafts: SavedDraft[],
  boardById: Map<string, BoardPlayer>
): Portfolio {
  const totalDrafts = drafts.length;
  const byPlayer = new Map<string, ExposureRow>();
  const teamCounts = new Map<string, number>();
  const stackCounts = new Map<string, number>();

  for (const d of drafts) {
    const mine = d.picks.filter(
      (pk) => pickOwner(pk.pickNo, d.config.teams, d.tradedPicks ?? []) === d.mySlot
    );
    const roster = mine.map((pk) => ({
      id: pk.playerId,
      name: pk.playerName,
      pos: (boardById.get(pk.playerId)?.pos ?? pk.pos) as Position | null,
      team: boardById.get(pk.playerId)?.team ?? null,
    }));
    const seenTeams = new Set<string>();
    for (const p of roster) {
      if (!p.id) continue;
      const row = byPlayer.get(p.id) ?? { ...p, count: 0, pct: 0 };
      row.count++;
      byPlayer.set(p.id, row);
      if (p.team && !seenTeams.has(p.team)) {
        seenTeams.add(p.team);
        // count team once per draft where I hold ≥2 of its players (real concentration)
      }
    }
    // Team concentration: teams where this roster holds 2+ players
    const perTeam = new Map<string, number>();
    for (const p of roster) if (p.team) perTeam.set(p.team, (perTeam.get(p.team) ?? 0) + 1);
    for (const [team, n] of perTeam) {
      if (n >= 2) teamCounts.set(team, (teamCounts.get(team) ?? 0) + 1);
    }
    // Stacks: QB + same-team pass catcher on this roster
    for (const qb of roster.filter((p) => p.pos === "QB" && p.team)) {
      for (const pc of roster.filter(
        (p) => (p.pos === "WR" || p.pos === "TE") && p.team === qb.team
      )) {
        const label = `${qb.name} + ${pc.name}`;
        stackCounts.set(label, (stackCounts.get(label) ?? 0) + 1);
      }
    }
  }

  const players = [...byPlayer.values()]
    .map((r) => ({ ...r, pct: totalDrafts ? r.count / totalDrafts : 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const teams = [...teamCounts.entries()]
    .map(([team, count]) => ({ team, count }))
    .sort((a, b) => b.count - a.count);
  const stacks = [...stackCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return { totalDrafts, players, teams, stacks };
}
