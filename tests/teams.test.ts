import { describe, it, expect, beforeEach } from "vitest";
import { loadTeams, saveTeam, deleteTeam, applyRoster, type SavedTeam } from "../lib/client/teams";
import type { LeagueConfig } from "../lib/types";

const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

const team = (over: Partial<SavedTeam> = {}): SavedTeam => ({
  id: "t1", name: "Main league", config, source: "manual",
  roster: [], savedAt: "2026-09-09T00:00:00.000Z", ...over,
});

// jsdom is not configured for this suite; stub localStorage directly.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe("teams registry", () => {
  it("starts empty and survives a round trip", () => {
    expect(loadTeams()).toEqual([]);
    saveTeam(team());
    expect(loadTeams()).toHaveLength(1);
    expect(loadTeams()[0].name).toBe("Main league");
  });

  it("holds several leagues at once, newest first", () => {
    saveTeam(team({ id: "a", name: "A", savedAt: "2026-09-01T00:00:00.000Z" }));
    saveTeam(team({ id: "b", name: "B", savedAt: "2026-09-08T00:00:00.000Z" }));
    expect(loadTeams().map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("upserts by id rather than duplicating", () => {
    saveTeam(team({ id: "a", name: "First" }));
    saveTeam(team({ id: "a", name: "Renamed" }));
    const all = loadTeams();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Renamed");
  });

  it("deletes by id", () => {
    saveTeam(team({ id: "a" }));
    saveTeam(team({ id: "b" }));
    expect(deleteTeam("a").map((t) => t.id)).toEqual(["b"]);
  });

  it("survives corrupt storage rather than throwing", () => {
    localStorage.setItem("draft-cockpit-teams-v1", "{not json");
    expect(loadTeams()).toEqual([]);
  });

  it("applyRoster is the single funnel: it replaces the roster and stamps the source", () => {
    const t = applyRoster(team({ source: "manual" }), ["1", "2", "3"], "paste");
    expect(t.roster.map((r) => r.playerId)).toEqual(["1", "2", "3"]);
    expect(t.source).toBe("paste");
    // Every ingestion path lands here, so slots default consistently.
    expect(new Set(t.roster.map((r) => r.slot))).toEqual(new Set(["bench"]));
  });

  it("applyRoster drops duplicate ids, keeping the first", () => {
    const t = applyRoster(team(), ["1", "2", "1", "3"], "manual");
    expect(t.roster.map((r) => r.playerId)).toEqual(["1", "2", "3"]);
  });

  it("applyRoster preserves the slot of a player already on the roster", () => {
    const base = team({ roster: [{ playerId: "1", slot: "starter" }, { playerId: "9", slot: "ir" }] });
    const t = applyRoster(base, ["1", "2"], "sleeper");
    expect(t.roster.find((r) => r.playerId === "1")?.slot).toBe("starter");
    expect(t.roster.find((r) => r.playerId === "2")?.slot).toBe("bench");
    // 9 is no longer on the roster, so it is gone.
    expect(t.roster.find((r) => r.playerId === "9")).toBeUndefined();
  });

  it("applyRoster takes explicit slots from a platform that knows them", () => {
    const base = team({ roster: [{ playerId: "1", slot: "bench" }] });
    const t = applyRoster(base, ["1", "2", "3"], "sleeper", { "1": "starter", "3": "ir" });
    expect(t.roster.map((r) => r.slot)).toEqual(["starter", "bench", "ir"]);
  });
});
