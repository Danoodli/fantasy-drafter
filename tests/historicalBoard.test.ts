// Integrity of the committed season snapshots. Players who have since left the
// league sort to the bottom of ESPN's historical payload (it orders by CURRENT
// rank), so a too-small fetch silently zeroes real 2nd-round picks — Pacheco at
// ADP 19.8 scored as 0 in the first cut of this harness. These tests fail if a
// snapshot ever comes back with that hole.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/etl/csv";
import { buildHistoricalBoard, type CrossRow } from "../lib/etl/historicalBoard";
import type { SeasonSnapshot } from "../lib/etl/seasonSnapshot";
import type { LeagueConfig } from "../lib/types";

const cross = parseCsv(readFileSync(join(process.cwd(), "data/raw/db_playerids.csv"), "utf8")) as unknown as CrossRow[];
const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null, teams: 12, rounds: 15,
  scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
const load = (year: number): SeasonSnapshot =>
  JSON.parse(readFileSync(join(process.cwd(), "data/raw/seasons", `${year}.json`), "utf8"));

describe.each([2024, 2025])("season snapshot %i", (year) => {
  const snapshot = load(year);
  const hb = buildHistoricalBoard(snapshot, cross, "ppr", config);

  it("matches every FFC player drafted in the first 12 rounds to an ESPN line", () => {
    const early = hb.board.filter((p) => !p.deepPool && p.adp <= 144 && !hb.realized.has(p.id));
    expect(early.map((p) => `${p.name} (${p.pos}, ADP ${p.adp})`)).toEqual([]);
  });

  it("carries a genuine preseason projection for most of the board", () => {
    // ESPN purges old seasons — 2023 keeps 22 of 264. Catch the erosion early.
    const real = hb.board.filter((p) => !p.projImputed && p.projPoints > 0).length;
    expect(real / hb.board.length).toBeGreaterThan(0.8);
  });

  it("has weekly actuals so rosters can be scored week by week", () => {
    const withWeeks = [...hb.realized.values()].filter((r) => r.weekly.some((w) => w != null)).length;
    expect(withWeeks).toBeGreaterThan(300);
  });

  it("is deep enough for a 20-round best ball", () => {
    const skill = hb.board.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.pos)).length;
    expect(skill).toBeGreaterThanOrEqual(240);
  });
});
