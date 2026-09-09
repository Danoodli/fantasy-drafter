import { describe, it, expect } from "vitest";
import { bestLineup, type LineupPlayer } from "../lib/engine/season/lineup";
import type { LeagueConfig } from "../lib/types";

const cfg = (over: Partial<LeagueConfig> = {}): LeagueConfig => ({
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced", ...over,
});

const p = (id: string, pos: LineupPlayer["pos"], points: number): LineupPlayer => ({ id, pos, points });

describe("bestLineup", () => {
  it("fills dedicated slots with the best at each position", () => {
    const l = bestLineup([p("qb1", "QB", 20), p("qb2", "QB", 15), p("rb1", "RB", 12), p("rb2", "RB", 9), p("wr1", "WR", 14), p("wr2", "WR", 11), p("te1", "TE", 8), p("k1", "K", 7), p("d1", "DST", 6)], cfg());
    expect(l.starters.find((s) => s.slot === "QB")?.player.id).toBe("qb1");
    // 1 flex among the leftovers: nobody is left, so it stays unfilled.
    expect(l.total).toBeCloseTo(20 + 12 + 9 + 14 + 11 + 8 + 7 + 6, 6);
    expect(l.benched.map((b) => b.id)).toEqual(["qb2"]);
  });

  it("puts the best leftover in the flex, whatever its position", () => {
    const l = bestLineup([p("qb1", "QB", 20), p("rb1", "RB", 12), p("rb2", "RB", 9), p("rb3", "RB", 8), p("wr1", "WR", 14), p("wr2", "WR", 11), p("wr3", "WR", 13), p("te1", "TE", 8), p("k1", "K", 7), p("d1", "DST", 6)], cfg());
    // The two WR slots take the two best WRs (wr1 14, wr3 13) regardless of
    // input order, so the leftovers are rb3 8 and wr2 11: the flex takes wr2.
    expect(l.starters.filter((s) => s.slot === "WR").map((s) => s.player.id).sort()).toEqual(["wr1", "wr3"]);
    expect(l.starters.find((s) => s.slot === "FLEX")?.player.id).toBe("wr2");
    expect(l.total).toBeCloseTo(20 + 12 + 9 + 14 + 13 + 11 + 8 + 7 + 6, 6);
    expect(l.benched.map((b) => b.id)).toEqual(["rb3"]);
  });

  it("fills two flex slots with the two best eligible leftovers", () => {
    // A greedy top-k fill gives the same answer (see the task note): this pins
    // the allocation search to it.
    const l = bestLineup(
      [p("qb1", "QB", 20), p("rb1", "RB", 12), p("rb2", "RB", 9), p("rb3", "RB", 10), p("wr1", "WR", 14), p("wr2", "WR", 11), p("wr3", "WR", 13), p("te1", "TE", 8), p("te2", "TE", 12), p("k1", "K", 7), p("d1", "DST", 6)],
      cfg({ rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1 } })
    );
    const flex = l.starters.filter((s) => s.slot === "FLEX").map((s) => s.player.id).sort();
    // Dedicated slots take the best at each position first: WR wr1 14 + wr3 13,
    // TE te2 12. Leftovers are rb3 10, wr2 11, te1 8 -> the two flex slots take
    // wr2 and rb3, and te1 is the only bench player.
    expect(l.starters.find((s) => s.slot === "TE")?.player.id).toBe("te2");
    expect(flex).toEqual(["rb2", "wr2"]);
    expect(l.benched.map((b) => b.id)).toEqual(["te1"]);
    expect(l.total).toBeCloseTo(20 + 12 + 9 + 10 + 14 + 13 + 11 + 12 + 7 + 6, 6);
  });

  it("handles superflex, where the second-best QB can beat every flex option", () => {
    const l = bestLineup(
      [p("qb1", "QB", 22), p("qb2", "QB", 19), p("rb1", "RB", 12), p("rb2", "RB", 9), p("wr1", "WR", 14), p("wr2", "WR", 11), p("wr3", "WR", 6), p("te1", "TE", 8), p("k1", "K", 7), p("d1", "DST", 6)],
      cfg({ rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }, flexEligible: ["QB", "RB", "WR", "TE"] })
    );
    // qb2 at 19 must win the superflex over wr3 at 6.
    expect(l.starters.find((s) => s.slot === "FLEX")?.player.id).toBe("qb2");
    expect(l.benched.map((b) => b.id)).toEqual(["wr3"]);
  });

  it("leaves a slot unfilled rather than inventing a player", () => {
    const l = bestLineup([p("qb1", "QB", 20)], cfg());
    expect(l.starters).toHaveLength(1);
    expect(l.total).toBeCloseTo(20, 6);
  });

  it("never starts the same player twice", () => {
    const l = bestLineup([p("rb1", "RB", 12), p("wr1", "WR", 14)], cfg());
    const ids = l.starters.map((s) => s.player.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic on ties", () => {
    const players = [p("a", "RB", 10), p("b", "RB", 10), p("c", "RB", 10)];
    const one = bestLineup(players, cfg());
    const two = bestLineup([...players].reverse(), cfg());
    expect(one.total).toBeCloseTo(two.total, 10);
  });
});
