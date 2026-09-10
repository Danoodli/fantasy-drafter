// Sleeper league sync for the in-season cockpit. Read-only, keyless, free.
//
// Everything that parses is pure and fixture-tested (tests/fixtures/
// sleeper-league/*, a real public league). The fetchers are thin and live at
// the bottom. Browser-safe: no Node imports.
//
// Player ids are Sleeper ids, which are this board's canonical ids; Sleeper's
// DEF ids are team codes ("CLE"), which are this board's DST ids. No crosswalk.
import type { LeagueConfig, Position, RosterSlots, ScoringFormat } from "../types";
import { applyRoster, type LeagueSnapshot, type SavedTeam } from "../client/teams";

const BASE = "https://api.sleeper.app/v1";

export interface SleeperLeagueInfo {
  leagueId: string;
  name: string;
  season: number;
  status: string;
  teams: number;
  playoffTeams: number;
  /** First playoff week; the regular season ends the week before. */
  playoffWeekStart: number;
  rosterPositions: string[];
  scoringSettings: Record<string, number>;
}

export interface SleeperRoster {
  rosterId: number;
  ownerId: string | null;
  players: string[];
  starters: string[];
  reserve: string[];
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

export interface SleeperMatchup {
  rosterId: number;
  /** Null when this roster has no game that week (idle in the playoffs). */
  matchupId: number | null;
  points: number;
  starters: string[];
}

export interface SleeperUser {
  userId: string;
  displayName: string;
  teamName: string | null;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);
const num = (v: unknown, def = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : def);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** Sleeper marks an empty lineup slot as "0" or ""; neither is a player. */
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter((s) => s && s !== "0") : []);

export function parseLeague(raw: unknown): SleeperLeagueInfo {
  const r = obj(raw);
  const leagueId = r && str(r.league_id);
  if (!r || !leagueId) throw new Error("Sleeper league: payload has no league_id");
  const settings = obj(r.settings) ?? {};
  const positions = Array.isArray(r.roster_positions) ? r.roster_positions.map(String) : [];
  return {
    leagueId,
    name: str(r.name) ?? `League ${leagueId}`,
    season: Number(r.season) || 0,
    status: str(r.status) ?? "unknown",
    teams: num(settings.num_teams, num(r.total_rosters, 12)),
    playoffTeams: num(settings.playoff_teams, 6),
    playoffWeekStart: num(settings.playoff_week_start, 15),
    rosterPositions: positions,
    scoringSettings: (obj(r.scoring_settings) as Record<string, number> | null) ?? {},
  };
}

/** Sleeper's slot names -> our RosterSlots. Bench/IR/taxi are not starting slots. */
export function rosterSlotsFromPositions(positions: string[]): { rosterSlots: RosterSlots; flexEligible: Position[] } {
  const rosterSlots: RosterSlots = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, K: 0, DST: 0 };
  const eligible = new Set<Position>();
  for (const slot of positions) {
    switch (slot) {
      case "QB": case "RB": case "WR": case "TE": case "K":
        rosterSlots[slot]++;
        break;
      case "DEF":
        rosterSlots.DST++;
        break;
      case "FLEX":
        rosterSlots.FLEX++;
        for (const p of ["RB", "WR", "TE"] as Position[]) eligible.add(p);
        break;
      case "SUPER_FLEX":
        rosterSlots.FLEX++;
        for (const p of ["QB", "RB", "WR", "TE"] as Position[]) eligible.add(p);
        break;
      case "REC_FLEX":
        rosterSlots.FLEX++;
        for (const p of ["WR", "TE"] as Position[]) eligible.add(p);
        break;
      case "WRRB_FLEX":
        rosterSlots.FLEX++;
        for (const p of ["RB", "WR"] as Position[]) eligible.add(p);
        break;
      default:
        // BN, IR, TAXI, IDP slots: not a lineup slot this engine models.
        break;
    }
  }
  // The engine has ONE flex kind with one eligibility set, so several flex
  // kinds are unioned. Exact for the common leagues; a league mixing FLEX and
  // REC_FLEX is modelled slightly loose (an RB could fill the REC_FLEX).
  const order: Position[] = ["QB", "RB", "WR", "TE"];
  return { rosterSlots, flexEligible: order.filter((p) => eligible.has(p)) };
}

/** Which of the four board formats this league's scoring is closest to. */
export function formatFromScoring(scoring: Record<string, number>, positions: string[]): ScoringFormat {
  const qbSlots = positions.filter((p) => p === "QB").length + (positions.includes("SUPER_FLEX") ? 1 : 0);
  if (qbSlots >= 2) return "2qb";
  const rec = typeof scoring.rec === "number" ? scoring.rec : 1;
  if (rec >= 0.75) return "ppr";
  if (rec >= 0.25) return "half-ppr";
  return "standard";
}

export function parseRosters(raw: unknown): SleeperRoster[] {
  if (!Array.isArray(raw)) throw new Error("Sleeper rosters: expected an array");
  return raw.map((x) => {
    const r = obj(x) ?? {};
    const s = obj(r.settings) ?? {};
    return {
      rosterId: num(r.roster_id),
      ownerId: str(r.owner_id),
      players: ids(r.players),
      starters: ids(r.starters),
      reserve: ids(r.reserve),
      wins: num(s.wins),
      losses: num(s.losses),
      ties: num(s.ties),
      // Sleeper splits points into an integer and hundredths.
      pointsFor: num(s.fpts) + num(s.fpts_decimal) / 100,
    };
  });
}

export function parseMatchups(raw: unknown): SleeperMatchup[] {
  if (!Array.isArray(raw)) throw new Error("Sleeper matchups: expected an array");
  return raw.map((x) => {
    const m = obj(x) ?? {};
    return {
      rosterId: num(m.roster_id),
      matchupId: typeof m.matchup_id === "number" ? m.matchup_id : null,
      points: num(m.points),
      starters: ids(m.starters),
    };
  });
}

export function parseUsers(raw: unknown): SleeperUser[] {
  if (!Array.isArray(raw)) throw new Error("Sleeper users: expected an array");
  return raw.map((x) => {
    const u = obj(x) ?? {};
    const meta = obj(u.metadata) ?? {};
    return { userId: str(u.user_id) ?? "", displayName: str(u.display_name) ?? "", teamName: str(meta.team_name) };
  });
}

export function opponentOf(matchups: SleeperMatchup[], rosterId: number): SleeperMatchup | null {
  const mine = matchups.find((m) => m.rosterId === rosterId);
  if (!mine || mine.matchupId === null) return null;
  return matchups.find((m) => m.matchupId === mine.matchupId && m.rosterId !== rosterId) ?? null;
}

/** [rosterId, rosterId] per matchup id, lower id first, sorted. Idle rosters are omitted. */
export function pairings(matchups: SleeperMatchup[]): [number, number][] {
  const byId = new Map<number, number[]>();
  for (const m of matchups) {
    if (m.matchupId === null) continue;
    const list = byId.get(m.matchupId) ?? [];
    list.push(m.rosterId);
    byId.set(m.matchupId, list);
  }
  const out: [number, number][] = [];
  for (const list of byId.values()) {
    if (list.length !== 2) continue; // a malformed pairing is dropped, not guessed
    const [a, b] = list.sort((x, y) => x - y);
    out.push([a, b]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

export function teamNameFor(roster: SleeperRoster, users: SleeperUser[]): string {
  const u = roster.ownerId ? users.find((x) => x.userId === roster.ownerId) : undefined;
  return u?.teamName ?? (u?.displayName || `Roster ${roster.rosterId}`);
}

/** A league id from a pasted URL or a bare id. */
export function parseLeagueId(input: string): string {
  const m = input.match(/leagues?\/(\d{6,})/) ?? input.match(/(\d{6,})/);
  return m ? m[1] : input.trim();
}

/**
 * Build (or re-sync) a SavedTeam from a league. Ends in applyRoster, like
 * every other ingestion path, with Sleeper's own starter/IR slots applied.
 */
export function teamFromSleeper(args: {
  league: SleeperLeagueInfo;
  rosters: SleeperRoster[];
  users: SleeperUser[];
  myRosterId: number;
  schedule: Record<number, [number, number][]>;
  base: LeagueConfig;
  existing?: SavedTeam;
  now: string;
}): SavedTeam {
  const { league, rosters, users, myRosterId, schedule, base, existing, now } = args;
  const mine = rosters.find((r) => r.rosterId === myRosterId);
  if (!mine) throw new Error(`Sleeper league ${league.leagueId}: no roster ${myRosterId}`);
  const { rosterSlots, flexEligible } = rosterSlotsFromPositions(league.rosterPositions);
  const config: LeagueConfig = {
    ...base,
    platform: "sleeper",
    leagueId: league.leagueId,
    teams: league.teams,
    // Roster size = every slot including bench; the waiver engine uses it as the cap.
    rounds: league.rosterPositions.filter((p) => p !== "IR" && p !== "TAXI").length || base.rounds,
    scoring: formatFromScoring(league.scoringSettings, league.rosterPositions),
    rosterSlots,
    flexEligible,
  };
  const names = new Map(rosters.map((r) => [r.rosterId, teamNameFor(r, users)] as const));
  const weekly: SavedTeam["schedule"] = {};
  for (const [week, pairs] of Object.entries(schedule)) {
    const pair = pairs.find(([a, b]) => a === myRosterId || b === myRosterId);
    if (!pair) continue;
    const opp = pair[0] === myRosterId ? pair[1] : pair[0];
    weekly[Number(week)] = { oppRosterId: opp, oppName: names.get(opp) };
  }
  const snapshot: LeagueSnapshot = {
    rosters: rosters.map((r) => ({
      rosterId: r.rosterId, name: names.get(r.rosterId) ?? `Roster ${r.rosterId}`,
      players: r.players, starters: r.starters, wins: r.wins, losses: r.losses, ties: r.ties, pointsFor: r.pointsFor,
    })),
    playoffTeams: league.playoffTeams,
    playoffWeekStart: league.playoffWeekStart,
    schedule,
    syncedAt: now,
  };
  const shell: SavedTeam = {
    id: existing?.id ?? `sleeper-${league.leagueId}-${myRosterId}`,
    name: existing?.name ?? `${names.get(myRosterId)} · ${league.name}`,
    config,
    source: "sleeper",
    sleeper: { leagueId: league.leagueId, rosterId: myRosterId },
    roster: existing?.roster ?? [],
    schedule: weekly,
    record: { w: mine.wins, l: mine.losses, t: mine.ties },
    league: snapshot,
    savedAt: now,
  };
  const slots: Record<string, "starter" | "bench" | "ir"> = {};
  for (const id of mine.players) slots[id] = "bench";
  for (const id of mine.starters) slots[id] = "starter";
  for (const id of mine.reserve) slots[id] = "ir";
  return applyRoster(shell, [...mine.players, ...mine.reserve], "sleeper", slots);
}

// ---------------------------------------------------------------------------
// Fetchers. Sleeper sits behind a CDN that happily serves a stale body; the
// cache-buster and no-store are what make a re-sync actually re-sync (same
// lesson as lib/draft/sleeper.ts).
async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}?_=${Date.now()}`, { cache: "no-store", headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`Sleeper ${path}: HTTP ${res.status}`);
  return res.json();
}

export async function fetchLeague(leagueId: string): Promise<{ league: SleeperLeagueInfo; rosters: SleeperRoster[]; users: SleeperUser[] }> {
  const [league, rosters, users] = await Promise.all([
    get(`/league/${leagueId}`).then(parseLeague),
    get(`/league/${leagueId}/rosters`).then(parseRosters),
    get(`/league/${leagueId}/users`).then(parseUsers),
  ]);
  return { league, rosters, users };
}

export async function fetchMatchups(leagueId: string, week: number): Promise<SleeperMatchup[]> {
  return parseMatchups(await get(`/league/${leagueId}/matchups/${week}`));
}

/**
 * Pairings for weeks fromWeek..toWeek. Two different absences, kept apart:
 * a week Sleeper answered with no pairings (not published yet) is simply
 * omitted from `schedule`; a week whose REQUEST failed (network, 5xx) is
 * listed in `failedWeeks` so the UI can say the schedule is incomplete
 * rather than quietly treating a transient error as "unpublished".
 */
export async function fetchSchedule(
  leagueId: string,
  fromWeek: number,
  toWeek: number
): Promise<{ schedule: Record<number, [number, number][]>; failedWeeks: number[] }> {
  const weeks: number[] = [];
  for (let w = fromWeek; w <= toWeek; w++) weeks.push(w);
  const results = await Promise.allSettled(weeks.map((w) => fetchMatchups(leagueId, w)));
  const schedule: Record<number, [number, number][]> = {};
  const failedWeeks: number[] = [];
  weeks.forEach((w, i) => {
    const r = results[i];
    if (r.status === "rejected") {
      failedWeeks.push(w);
      return;
    }
    const p = pairings(r.value);
    if (p.length > 0) schedule[w] = p;
  });
  return { schedule, failedWeeks };
}

export async function fetchNflState(): Promise<{ season: number; week: number; seasonType: string }> {
  const s = obj(await get(`/state/nfl`)) ?? {};
  return { season: Number(s.season) || new Date().getFullYear(), week: num(s.week, 1), seasonType: str(s.season_type) ?? "regular" };
}
