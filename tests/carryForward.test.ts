import { describe, it, expect } from "vitest";
import { carryForwardFp } from "../lib/etl/carryForward";
import type { Board } from "../lib/types";

const mk = (fpName: string | null, ecr: number | null): Board => ({
  meta: {
    format: "ppr", builtAt: "2026-09-07T10:00:00Z", scoring: {} as never, warnings: [],
    sources: fpName ? [{ name: fpName, fetchedAt: "2026-09-07T09:20:00Z", fromFixture: false }] : [],
  },
  players: [{ id: "a", name: "A", pos: "RB", team: "SF", bye: 9, projPoints: 1, projImputed: false, adp: 1, adpStdev: 1, adpHigh: 1, adpLow: 1,
    ecr, ecrStdev: ecr ? 2 : null, vorp: 0, vols: 0, tier: 1, injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {},
    statsFp: ecr ? { rushYds: 900 } : undefined }],
});

describe("carryForwardFp", () => {
  it("copies FP-derived fields from the previous board when this build has none", () => {
    const out = carryForwardFp(mk(null, 12), mk("FantasyPros consensus (103 experts, live)", 5));
    expect(out.players[0]).toMatchObject({ ecr: 5, ecrStdev: 2, statsFp: { rushYds: 900 } });
    expect(out.meta.sources.at(-1)?.name).toMatch(/carried from 2026-09-07T09:20/);
  });
  it("leaves a build that has live FP data alone", () => {
    const b = mk("FantasyPros consensus (90 experts, live)", 12);
    expect(carryForwardFp(b, mk("FantasyPros consensus (103 experts, live)", 5))).toBe(b);
  });
  it("does nothing when the previous board had 0 experts or no FP", () => {
    const b = mk(null, 12);
    expect(carryForwardFp(b, mk("FantasyPros consensus (0 experts, live)", 5))).toBe(b);
    expect(carryForwardFp(b, null)).toBe(b);
  });
});
