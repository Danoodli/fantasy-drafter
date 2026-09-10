import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseLeague, parseRosters, parseMatchups, parseUsers, rosterSlotsFromPositions, formatFromScoring,
  opponentOf, pairings, teamNameFor, parseLeagueId, teamFromSleeper,
} from "../lib/season/sleeperLeague";
import type { LeagueConfig } from "../lib/types";

const fx = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "sleeper-league", name), "utf8"));
const league = parseLeague(fx("league.json"));
const rosters = parseRosters(fx("rosters.json"));
const matchups = parseMatchups(fx("matchups-1.json"));
const users = parseUsers(fx("users.json"));

const base: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

describe("parseLeague", () => {
  it("reads the league's name, size and playoff format", () => {
    expect(league.name).toBe("Sleeper Friends League");
    expect(league.season).toBe(2018);
    expect(league.teams).toBe(12);
    expect(league.playoffTeams).toBe(6);
    expect(league.playoffWeekStart).toBe(14);
    expect(league.rosterPositions[0]).toBe("QB");
  });
  it("rejects a payload that is not a league rather than returning zeros", () => {
    expect(() => parseLeague({})).toThrow(/league/i);
    expect(() => parseLeague(null)).toThrow(/league/i);
  });
});

describe("rosterSlotsFromPositions", () => {
  it("counts starting slots and ignores bench, IR and taxi", () => {
    const { rosterSlots, flexEligible } = rosterSlotsFromPositions(league.rosterPositions);
    expect(rosterSlots).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 0, DST: 1 });
    expect(flexEligible).toEqual(["RB", "WR", "TE"]);
  });
  it("makes a SUPER_FLEX a QB-eligible flex", () => {
    const { rosterSlots, flexEligible } = rosterSlotsFromPositions(["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF", "BN"]);
    expect(rosterSlots.FLEX).toBe(2);
    expect(flexEligible).toEqual(["QB", "RB", "WR", "TE"]);
  });
  it("treats REC_FLEX as a WR/TE flex", () => {
    const { rosterSlots, flexEligible } = rosterSlotsFromPositions(["QB", "RB", "WR", "TE", "REC_FLEX", "BN"]);
    expect(rosterSlots.FLEX).toBe(1);
    expect(flexEligible).toEqual(["WR", "TE"]);
  });
});

describe("formatFromScoring", () => {
  it("maps rec 1 / 0.5 / 0 to the board formats", () => {
    expect(formatFromScoring({ rec: 1 }, ["QB"])).toBe("ppr");
    expect(formatFromScoring({ rec: 0.5 }, ["QB"])).toBe("half-ppr");
    expect(formatFromScoring({ rec: 0 }, ["QB"])).toBe("standard");
  });
  it("calls a two-QB or superflex league 2qb", () => {
    expect(formatFromScoring({ rec: 1 }, ["QB", "QB", "RB"])).toBe("2qb");
    expect(formatFromScoring({ rec: 1 }, ["QB", "SUPER_FLEX"])).toBe("2qb");
  });
  it("defaults to ppr when rec is missing", () => {
    expect(formatFromScoring({}, ["QB"])).toBe("ppr");
  });
});

describe("parseRosters", () => {
  it("reads every roster with its record and points to two decimals", () => {
    expect(rosters).toHaveLength(12);
    const r1 = rosters.find((r) => r.rosterId === 1)!;
    expect(r1.players).toHaveLength(15);
    expect(r1.starters).toHaveLength(9);
    expect(r1.starters[8]).toBe("CLE"); // DEF ids are team codes, same as the board's DST ids
    expect(r1.reserve).toEqual([]); // null in the payload
    expect(r1).toMatchObject({ wins: 7, losses: 6, ties: 0 });
    expect(r1.pointsFor).toBeCloseTo(1776.06, 6);
  });
  it("drops empty-slot markers from starters", () => {
    const [r] = parseRosters([{ roster_id: 3, owner_id: null, players: ["1"], starters: ["1", "0", ""], reserve: null, settings: {} }]);
    expect(r.starters).toEqual(["1"]);
    expect(r).toMatchObject({ wins: 0, losses: 0, ties: 0, pointsFor: 0 });
  });
});

describe("parseMatchups / opponentOf / pairings", () => {
  it("reads week 1", () => {
    expect(matchups).toHaveLength(12);
    const m1 = matchups.find((m) => m.rosterId === 1)!;
    expect(m1.matchupId).toBe(2);
    expect(m1.points).toBeCloseTo(148.04, 6);
    expect(m1.starters).toHaveLength(9);
  });
  it("finds the opponent as the other roster sharing the matchup id", () => {
    const opp = opponentOf(matchups, 1)!;
    expect(opp.rosterId).not.toBe(1);
    expect(opp.matchupId).toBe(2);
    expect(opponentOf(matchups, 99)).toBeNull();
  });
  it("returns null when the roster is idle (null matchup id)", () => {
    expect(opponentOf([{ rosterId: 1, matchupId: null, points: 0, starters: [] }], 1)).toBeNull();
  });
  it("pairs every matchup id exactly once, lower roster id first", () => {
    const p = pairings(matchups);
    expect(p).toHaveLength(6);
    for (const [a, b] of p) expect(a).toBeLessThan(b);
    expect(new Set(p.flat()).size).toBe(12);
  });
});

describe("parseUsers / teamNameFor", () => {
  it("reads users with their team name when set", () => {
    expect(users.length).toBeGreaterThanOrEqual(12);
    const u = users.find((x) => x.userId === "457511950237696")!;
    expect(u.displayName).toBe("2KSports");
    expect(u.teamName).toBe("Giant Dolphins");
  });
  it("names a roster by team name, then display name, then roster id", () => {
    const owned = rosters.find((r) => r.ownerId)!;
    expect(teamNameFor(owned, users)).toMatch(/\S/);
    expect(teamNameFor({ ...owned, ownerId: "nobody" }, users)).toBe(`Roster ${owned.rosterId}`);
    expect(teamNameFor({ ...owned, ownerId: "u" }, [{ userId: "u", displayName: "dan", teamName: null }])).toBe("dan");
  });
});

describe("parseLeagueId", () => {
  it("accepts a bare id or any sleeper URL carrying one", () => {
    expect(parseLeagueId("289646328504385536")).toBe("289646328504385536");
    expect(parseLeagueId("https://sleeper.com/leagues/289646328504385536/team")).toBe("289646328504385536");
    expect(parseLeagueId("  https://sleeper.app/leagues/289646328504385536 ")).toBe("289646328504385536");
  });
});

describe("teamFromSleeper", () => {
  const schedule = { 1: pairings(matchups) };
  const team = teamFromSleeper({ league, rosters, users, myRosterId: 1, schedule, base, now: "2026-09-09T00:00:00.000Z" });

  it("builds a SavedTeam through applyRoster with Sleeper's slots", () => {
    expect(team.source).toBe("sleeper");
    expect(team.sleeper).toEqual({ leagueId: league.leagueId, rosterId: 1 });
    expect(team.roster).toHaveLength(15);
    expect(team.roster.filter((r) => r.slot === "starter")).toHaveLength(9);
    expect(team.roster.find((r) => r.playerId === "CLE")?.slot).toBe("starter");
  });
  it("carries the league's real format, slots and size into the config", () => {
    expect(team.config.platform).toBe("sleeper");
    expect(team.config.leagueId).toBe(league.leagueId);
    expect(team.config.teams).toBe(12);
    expect(team.config.rosterSlots).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 0, DST: 1 });
    expect(team.config.rounds).toBe(15); // roster size, from roster_positions
  });
  it("snapshots every roster, the record, the schedule and the opponent", () => {
    expect(team.record).toEqual({ w: 7, l: 6, t: 0 });
    expect(team.league?.rosters).toHaveLength(12);
    expect(team.league?.playoffTeams).toBe(6);
    expect(team.league?.schedule[1]).toHaveLength(6);
    const opp = opponentOf(matchups, 1)!;
    expect(team.schedule?.[1]?.oppRosterId).toBe(opp.rosterId);
    expect(team.schedule?.[1]?.oppName).toMatch(/\S/);
  });
  it("keeps the existing team's id and name on re-sync", () => {
    const again = teamFromSleeper({ league, rosters, users, myRosterId: 1, schedule, base, now: "2026-09-10T00:00:00.000Z", existing: { ...team, id: "keep", name: "My name" } });
    expect(again.id).toBe("keep");
    expect(again.name).toBe("My name");
    expect(again.savedAt).toBe("2026-09-10T00:00:00.000Z");
  });
});
