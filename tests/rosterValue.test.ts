import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineupPointsWeek, evaluateCompletions, marginalGainNow, positionGainTable } from "../lib/engine/rosterValue";
import type { OutcomeParams } from "../lib/engine/outcomeModel";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const params: OutcomeParams = JSON.parse(readFileSync(join(process.cwd(), "config", "outcome-model.json"), "utf8"));
// Same parameters at every position: isolates the structure of the objective from calibrated football differences.
const neutral: OutcomeParams = { ...params, byPos: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((p) => [p, params.byPos.RB])) as OutcomeParams["byPos"] };
const redraft: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: 1, teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }, flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
const bestball: LeagueConfig = { ...redraft, rounds: 20, leagueType: "bestball", rosterSlots: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, K: 0, DST: 0 } };
let n = 0;
const p = (pos: Position, proj: number, bye: number | null = 7, team = "T" + (n % 8)): BoardPlayer =>
  ({ id: `${pos}${proj}-${n++}`, name: "x", pos, team, bye, projPoints: proj, projImputed: false, adp: 50, adpStdev: 5, adpHigh: 40,
     adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1, injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {} }) as BoardPlayer;
const empty = (iters: number) => Array.from({ length: iters }, () => [] as BoardPlayer[]);

describe("lineupPointsWeek", () => {
  it("fills an empty starting slot from the wire in redraft and not in best ball", () => {
    const entries = [{ pos: "QB" as Position, pts: 20 }, { pos: "RB" as Position, pts: 10 }]; // RB2, WR1, WR2, TE, FLEX, K, DST empty
    const withWire = lineupPointsWeek(entries, redraft, { RB: 6, WR: 7, TE: 5, K: 7, DST: 6 });
    const noWire = lineupPointsWeek(entries, redraft, {});
    expect(noWire).toBe(30);
    // ONE streamer per position per week (matches the backtest harness): RB2 ← 6,
    // one WR slot ← 7 and the other stays empty, TE ← 5, K ← 7, DST ← 6, FLEX has
    // no leftover body. Depth at two-slot positions stays valuable for that reason.
    expect(withWire).toBeCloseTo(30 + 6 + 7 + 5 + 7 + 6, 6);
  });
});

describe("marginalGainNow", () => {
  const base = [p("QB", 330, 5), p("RB", 260, 6), p("RB", 220, 8), p("WR", 250, 5), p("WR", 210, 10), p("TE", 150, 9)];
  it("values a 3rd WR above a surplus RB on a roster already stacked with RBs", () => {
    // RB3 (200) already holds the FLEX; a 150-point RB would be the 8th RB and never start.
    const stacked = [...base, p("RB", 200, 4), p("RB", 190, 11), p("RB", 180, 12), p("RB", 175, 13), p("RB", 172, 14)];
    const wr3 = marginalGainNow(p("WR", 170, 3), stacked, params, redraft, { WR: 7, RB: 5 });
    const rb8 = marginalGainNow(p("RB", 150, 3), stacked, params, redraft, { WR: 7, RB: 5 });
    expect(wr3).toBeGreaterThan(rb8);
    expect(rb8).toBeLessThan(1);
    // Expected values only see BYE cover (a starter is never "out" in expectation);
    // the insurance-aware table sees injury cover too and ranks WR far above RB.
    const t = positionGainTable(stacked, params, redraft, { WR: 7, RB: 5 });
    expect(t.WR(9)).toBeGreaterThan(t.RB(9) * 4);
  });
  it("values an open starting slot by the full expected rate above the wire", () => {
    const gain = marginalGainNow(p("WR", 200, 3), [p("QB", 330, 5), p("RB", 260, 6), p("RB", 220, 8), p("WR", 250, 5)], params, redraft, { WR: 7 });
    expect(gain).toBeGreaterThan(40); // ~16 weeks × (expected weekly ≈ 10 − 7)
  });
  it("has no structural position bias: equal parameters, same rate, same hole → same value", () => {
    const rbHole = [p("QB", 330, 5), p("RB", 260, 6), p("WR", 250, 5), p("WR", 210, 10), p("TE", 150, 9)];
    const wrHole = [p("QB", 330, 5), p("RB", 260, 6), p("RB", 220, 8), p("WR", 250, 5), p("TE", 150, 9)];
    const rb = marginalGainNow(p("RB", 200, 3), rbHole, neutral, redraft, { RB: 6, WR: 6 });
    const wr = marginalGainNow(p("WR", 200, 3), wrHole, neutral, redraft, { RB: 6, WR: 6 });
    expect(Math.abs(rb - wr) / Math.max(rb, wr)).toBeLessThan(0.05);
  });
});

describe("positionGainTable", () => {
  it("returns a per-position gain function that decays with bodies", () => {
    const roster = [p("RB", 260, 6), p("RB", 220, 8), p("RB", 150, 4)];
    const t = positionGainTable(roster, params, redraft, { RB: 6 });
    expect(t.RB(12)).toBeLessThan(t.WR(12)); // RB is deep, WR is empty
    expect(t.K(8)).toBeLessThan(t.WR(12));
  });
});

describe("evaluateCompletions", () => {
  it("ranks a roster with bye coverage above the same roster without it, with paired draws", () => {
    // Four RBs already (FLEX taken, RB depth covered); two WRs sharing bye week 5 and no cover.
    const base = [p("QB", 330, 5), p("RB", 260, 6), p("RB", 220, 8), p("RB", 200, 9), p("RB", 190, 12), p("WR", 250, 5), p("WR", 210, 5), p("TE", 150, 9), p("K", 140, 7), p("DST", 120, 7)];
    const a = p("WR", 170, 11); // covers the week-5 double WR bye and WR injuries
    const b = p("RB", 170, 11); // 5th RB: nothing left to cover
    const [sa, sb] = evaluateCompletions(base, [a, b], [empty(300), empty(300)], neutral, redraft, {}, 9);
    expect(sa.mean).toBeGreaterThan(sb.mean);
    expect(sa.samples.length).toBe(300);
    expect(sa.sd).toBeGreaterThan(0);
  });
  it("best ball: a stacked QB+WR roster has a fatter ceiling than an unstacked one of equal mean rate", () => {
    // Season-level skill/availability variance dwarfs weekly correlation in a season
    // total, so isolate the weekly mechanism: no skill error, no missed games.
    const weeklyOnly: OutcomeParams = { ...params, byPos: Object.fromEntries(Object.entries(params.byPos).map(([k, v]) => [k, { ...v, projLogSigma: 1e-3, seasonEndingProb: 0, healthyMissProb: 0 }])) as OutcomeParams["byPos"] };
    const qb = p("QB", 330, 5, "KC");
    const stackedRest = [p("WR", 250, 5, "KC"), p("WR", 210, 6, "KC"), p("RB", 260, 6, "A"), p("RB", 220, 8, "B"), p("TE", 150, 9, "C")];
    const spreadRest = [p("WR", 250, 5, "X"), p("WR", 210, 6, "Y"), p("RB", 260, 6, "A"), p("RB", 220, 8, "B"), p("TE", 150, 9, "C")];
    const [s1, s2] = evaluateCompletions([], [qb, qb], [Array.from({ length: 2000 }, () => stackedRest), Array.from({ length: 2000 }, () => spreadRest)], weeklyOnly, bestball, {}, 21);
    expect(Math.abs(s1.mean - s2.mean) / s1.mean).toBeLessThan(0.03);
    expect(s1.sd).toBeGreaterThan(s2.sd * 1.04);
  });
  it("is deterministic", () => {
    const base = [p("QB", 330, 5), p("RB", 260, 6)];
    const r1 = evaluateCompletions(base, [p("WR", 200, 3)], [empty(50)], params, redraft, {}, 4);
    const r2 = evaluateCompletions(base, [p("WR", 200, 3)], [empty(50)], params, redraft, {}, 4);
    expect(r1[0].mean).toBe(r2[0].mean);
  });
});
