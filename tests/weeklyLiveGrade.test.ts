import { describe, it, expect } from "vitest";
import { gradeOutlooks } from "../lib/engine/weekly/liveGrade";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import { FALLBACK_PLAY_PROB, HEALTHY_PLAY_PROB } from "../lib/engine/weekly/availability";
import type { WeekOutlook } from "../lib/engine/weekly/outlook";

const ol = (id: string, over: Partial<WeekOutlook> = {}): WeekOutlook => {
  const p = over.pPlay ?? 0.97;
  return {
    playerId: id, week: 3, opp: "CHI", meanIfPlays: 12, mean: 12 * p, sigma: 0.6, p10: 5, p50: 10, p90: 22, pPlay: p, projected: true,
    stats: {}, drivers: { baseMarket: 12, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: null }, ...over,
  };
};
const map = (...os: WeekOutlook[]) => new Map(os.map((o) => [o.playerId, o] as const));
const healthy = DEFAULT_WEEKLY_MODEL.availability.healthy ?? HEALTHY_PLAY_PROB;

describe("gradeOutlooks", () => {
  it("returns the same Map when nothing changes", () => {
    const m = map(ol("a"));
    expect(gradeOutlooks(m, new Map(), new Map(), DEFAULT_WEEKLY_MODEL)).toBe(m);
  });

  it("an Out from the table drops pPlay and mean, and records the status", () => {
    const out = gradeOutlooks(map(ol("a")), new Map([["a", { status: "Out" as const }]]), new Map(), DEFAULT_WEEKLY_MODEL);
    const a = out.get("a")!;
    expect(a.drivers.status).toBe("Out");
    expect(a.pPlay).toBeCloseTo(DEFAULT_WEEKLY_MODEL.availability.byStatus.Out ?? FALLBACK_PLAY_PROB.Out, 10);
    expect(a.mean).toBeCloseTo(a.meanIfPlays * a.pPlay, 10);
    expect(a.meanIfPlays).toBe(12); // the conditional projection is untouched
  });

  it("an Active clears a Questionable and restores the healthy rate", () => {
    const q = ol("a", { pPlay: 0.75, drivers: { baseMarket: 12, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: "Questionable" } });
    const out = gradeOutlooks(map(q), new Map([["a", { status: "Active" as const }]]), new Map(), DEFAULT_WEEKLY_MODEL);
    expect(out.get("a")!.drivers.status).toBeNull();
    expect(out.get("a")!.pPlay).toBeCloseTo(healthy, 10);
  });

  it("a baked season-long designation is not overridden by a day-to-day Out", () => {
    const ir = ol("a", { pPlay: 0, mean: 0, drivers: { baseMarket: 12, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: "IR" } });
    const m = map(ir);
    expect(gradeOutlooks(m, new Map([["a", { status: "Out" as const }]]), new Map(), DEFAULT_WEEKLY_MODEL)).toBe(m);
  });

  it("a hard headline escalates on top of the table", () => {
    const out = gradeOutlooks(map(ol("a")), new Map([["a", { status: "Questionable" as const }]]), new Map([["a", { headline: "RB placed on injured reserve" }]]), DEFAULT_WEEKLY_MODEL);
    expect(out.get("a")!.drivers.status).toBe("IR");
    expect(out.get("a")!.pPlay).toBe(0);
    expect(out.get("a")!.mean).toBe(0);
  });

  it("a bye stays a bye whatever the table says", () => {
    const bye = ol("a", { opp: null, pPlay: 0, mean: 0 });
    const out = gradeOutlooks(map(bye), new Map([["a", { status: "Active" as const }]]), new Map(), DEFAULT_WEEKLY_MODEL);
    expect(out.get("a")!.pPlay).toBe(0);
    expect(out.get("a")!.mean).toBe(0);
  });

  it("leaves untouched outlooks by reference and never mutates the input", () => {
    const a = ol("a"); const b = ol("b");
    const m = map(a, b);
    const out = gradeOutlooks(m, new Map([["a", { status: "Doubtful" as const }]]), new Map(), DEFAULT_WEEKLY_MODEL);
    expect(out).not.toBe(m);
    expect(out.get("b")).toBe(b);
    expect(a.drivers.status).toBeNull(); // input untouched
    expect(m.get("a")!.pPlay).toBe(0.97);
  });
});
