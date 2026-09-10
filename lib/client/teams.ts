// Saved teams — every league you track, on-device (localStorage: bigger and
// cheaper than cookies, never sent over the wire, no expiry). Modelled on
// lib/client/history.ts, which does the same for drafts.
//
// Holds MANY leagues at once: a redraft league, a best ball, a friend's
// league. Each carries its own scoring and roster slots, so the engine reads
// the right settings per team without you re-entering anything.
import type { LeagueConfig } from "../types";

export interface RosterEntry {
  playerId: string;
  slot: "starter" | "bench" | "ir";
}

/** One roster in the league, as of the last sync. Player ids are board ids. */
export interface LeagueRosterSnapshot {
  rosterId: number;
  name: string;
  players: string[];
  starters: string[];
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

/**
 * The whole league as of the last Sleeper sync: every roster (so the
 * free-agent pool is the board minus all of them, and playoff odds can
 * simulate everyone), the playoff format, and the known pairings per
 * remaining week. Absent for manual/paste/OCR teams.
 */
export interface LeagueSnapshot {
  rosters: LeagueRosterSnapshot[];
  playoffTeams: number;
  playoffWeekStart: number;
  /** week -> [rosterId, rosterId] pairs. A week absent here is unknown. */
  schedule: Record<number, [number, number][]>;
  syncedAt: string; // ISO
}

export interface SavedTeam {
  id: string;
  name: string;
  config: LeagueConfig;
  /** Which ingestion path last populated this roster. */
  source: "sleeper" | "manual" | "paste" | "ocr";
  sleeper?: { leagueId: string; rosterId: number };
  roster: RosterEntry[];
  /** Opponent per week, when the platform tells us. */
  schedule?: Record<number, { oppRosterId?: number; oppName?: string }>;
  record?: { w: number; l: number; t: number };
  league?: LeagueSnapshot;
  /** Manual leagues: last regular-season week. Sleeper teams read league.playoffWeekStart instead. */
  regularSeasonEnd?: number;
  /** Manual leagues: the opponent's projected total the user typed for this week, if any. */
  oppProjectedTotal?: number;
  savedAt: string; // ISO
}

const KEY = "draft-cockpit-teams-v1";
const MAX_TEAMS = 20;

export function loadTeams(): SavedTeam[] {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? (JSON.parse(raw) as SavedTeam[]) : [];
    return Array.isArray(all) ? all : [];
  } catch {
    // Corrupt or unavailable storage must not take the page down.
    return [];
  }
}

function write(teams: SavedTeam[]): SavedTeam[] {
  const sorted = [...teams].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, MAX_TEAMS);
  try {
    localStorage.setItem(KEY, JSON.stringify(sorted));
  } catch {
    // Quota or private-mode failure: the in-memory result is still correct.
  }
  return sorted;
}

/** Insert or replace by id. Newest first. */
export function saveTeam(team: SavedTeam): SavedTeam[] {
  return write([...loadTeams().filter((t) => t.id !== team.id), team]);
}

export function deleteTeam(id: string): SavedTeam[] {
  return write(loadTeams().filter((t) => t.id !== id));
}

/**
 * THE funnel. Sleeper sync, manual entry, paste and OCR all end here, so
 * there is exactly one kind of roster change and every consumer sees the same
 * shape — the same discipline as useDraft.applyImport for draft picks.
 *
 * Slots of players already on the roster are preserved, so re-syncing does not
 * silently un-start your lineup. Players no longer present are dropped.
 */
export function applyRoster(
  team: SavedTeam,
  ids: string[],
  source: SavedTeam["source"],
  slots?: Record<string, RosterEntry["slot"]>
): SavedTeam {
  const previous = new Map(team.roster.map((r) => [r.playerId, r.slot] as const));
  const seen = new Set<string>();
  const roster: RosterEntry[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    roster.push({ playerId: id, slot: slots?.[id] ?? previous.get(id) ?? "bench" });
  }
  return { ...team, roster, source };
}
