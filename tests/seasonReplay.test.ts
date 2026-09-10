import { describe, it, expect } from "vitest";
import { histRowToOutlook, realizedPoints, sampleRoster, histRowToBoardPlayer } from "../lib/engine/season/replay";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import { SCORING_PRESETS, scoreStatLine } from "../lib/scoring";
import { makeRng } from "../lib/engine/montecarlo";
import type { HistRow } from "../lib/etl/weekly/history";

const row = (over: Partial<HistRow> = {}): HistRow => ({
  id: "1", pos: "WR", team: "DET", wk: 5, opp: "CHI", stNow: "Out",
  proj: { receptions: 6, recYds: 80, recTD: 0.5 }, act: { receptions: 8, recYds: 110, recTD: 1 }, tot: 47.5, spr: -3, ...over,
});
const ppr = SCORING_PRESETS.ppr;

describe("histRowToOutlook", () => {
  it("re-scores the projection, spreads it with the fitted sigma, and ignores the non-contemporaneous status", () => {
    const o = histRowToOutlook(row(), DEFAULT_WEEKLY_MODEL, ppr);
    expect(o.meanIfPlays).toBeCloseTo(scoreStatLine(row().proj, ppr), 10); // 6 + 8 + 3 = 17
    expect(o.mean).toBe(o.meanIfPlays);
    expect(o.pPlay).toBe(1); // stNow is fetch-time, never the week's — deliberately unused
    expect(o.projected).toBe(true);
    expect(o.opp).toBe("CHI");
    expect(o.sigma).toBeGreaterThan(0.3);
    expect(o.p10).toBeLessThan(o.p50);
    expect(o.p50).toBeLessThan(o.p90);
    expect(o.drivers.status).toBeNull();
  });
});

describe("realizedPoints", () => {
  it("scores the actual line and treats a DNP as zero", () => {
    expect(realizedPoints(row(), ppr)).toBeCloseTo(8 + 11 + 6, 10);
    expect(realizedPoints(row({ act: null }), ppr)).toBe(0);
    expect(realizedPoints(row({ act: {} }), ppr)).toBe(0);
  });
});

describe("sampleRoster", () => {
  const pool: HistRow[] = [
    ...Array.from({ length: 6 }, (_, i) => row({ id: `q${i}`, pos: "QB" })),
    ...Array.from({ length: 10 }, (_, i) => row({ id: `r${i}`, pos: "RB" })),
    ...Array.from({ length: 10 }, (_, i) => row({ id: `w${i}`, pos: "WR" })),
    ...Array.from({ length: 4 }, (_, i) => row({ id: `t${i}`, pos: "TE" })),
  ];
  it("draws the requested counts without replacement", () => {
    const r = sampleRoster(pool, { QB: 2, RB: 4, WR: 4, TE: 2 }, makeRng(1));
    expect(r).toHaveLength(12);
    expect(new Set(r.map((x) => x.id)).size).toBe(12);
    expect(r.filter((x) => x.pos === "RB")).toHaveLength(4);
  });
  it("is seeded and respects exclusions", () => {
    const a = sampleRoster(pool, { QB: 1, RB: 2 }, makeRng(7)).map((x) => x.id);
    const b = sampleRoster(pool, { QB: 1, RB: 2 }, makeRng(7)).map((x) => x.id);
    expect(a).toEqual(b);
    const c = sampleRoster(pool, { QB: 1 }, makeRng(7), new Set(pool.filter((x) => x.pos === "QB").slice(0, 5).map((x) => x.id)));
    expect(c.map((x) => x.id)).toEqual(["q5"]);
  });
  it("takes what is there when a position runs short", () => {
    expect(sampleRoster(pool, { TE: 9 }, makeRng(1))).toHaveLength(4);
  });
});

describe("histRowToBoardPlayer", () => {
  it("is a season-rate proxy the rest-of-season value can price", () => {
    const p = histRowToBoardPlayer(row(), ppr);
    expect(p.id).toBe("1");
    expect(p.pos).toBe("WR");
    expect(p.projPoints).toBeCloseTo(17 * 16, 6);
    expect(p.bye).toBeNull();
    expect(p.injury).toBeNull();
  });
});
