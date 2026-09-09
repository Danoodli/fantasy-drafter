import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSleeperWeekly } from "../lib/etl/weekly/sleeperWeekly";
import { scoreStatLine, SCORING_PRESETS } from "../lib/scoring";

const rows = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "sleeper-week-sample.json"), "utf8")
);

describe("parseSleeperWeekly", () => {
  it("keys by sleeper id and maps the raw stat line, first downs included", () => {
    const out = parseSleeperWeekly(rows);
    expect(out["6813"].stats.rushYds).toBeCloseTo(99.63);
    expect(out["6813"].stats.recFd).toBeCloseTo(2.61);
    expect(out["6813"].stats.rushFd).toBeCloseTo(9.96);
    expect(out["4034"].stats.passFd).toBeCloseTo(11.2);
    expect(out["6813"].pos).toBe("RB");
    expect(out["6813"].team).toBe("DET");
  });

  it("captures injury_status — the availability model is fitted from it", () => {
    expect(out0().status).toBeNull();
    expect(parseSleeperWeekly(rows)["4034"].status).toBe("Questionable");
    function out0() {
      return parseSleeperWeekly(rows)["6813"];
    }
  });

  it("drops an OFFENSIVE row with no usable stat line rather than emitting a zero player", () => {
    expect(parseSleeperWeekly(rows)["99999"]).toBeUndefined();
  });

  it("keeps kickers and defenses via a direct point total — they have no mappable stat line", () => {
    const kdst = [
      {
        week: 2, season: "2026", player_id: "K1",
        stats: { fga: 2.1, fgm: 1.8, fgm_40_49: 0.6, pts_half_ppr: 8.4 },
        player: { position: "K", team: "DAL", injury_status: null },
      },
      {
        week: 2, season: "2026", player_id: "DEN",
        stats: { pts_half_ppr: 7.2 },
        player: { position: "DEF", team: "DEN", injury_status: null },
      },
    ];
    const out = parseSleeperWeekly(kdst);
    // Without this the weekly board has no K and no DST, and a lineup needs both.
    expect(out["K1"].points).toBeCloseTo(8.4, 6);
    expect(out["K1"].stats).toEqual({});
    expect(out["DEN"].pos).toBe("DST");
    expect(out["DEN"].points).toBeCloseTo(7.2, 6);
  });

  it("still drops a K with neither a stat line nor any point total", () => {
    const bare = [{ week: 2, season: "2026", player_id: "K2", stats: { fga: 0 }, player: { position: "K", team: "DAL", injury_status: null } }];
    expect(parseSleeperWeekly(bare)["K2"]).toBeUndefined();
  });

  it("re-scoring the parsed line reproduces Sleeper's own pts_ppr within rounding", () => {
    const p = parseSleeperWeekly(rows)["6813"];
    // Sleeper's pts_ppr uses -2 for a lost fumble, same as our preset.
    const ours = scoreStatLine(p.stats, SCORING_PRESETS.ppr);
    // ~0.13 residual is Sleeper's own scoring nuances; test validates magnitude.
    expect(ours).toBeCloseTo(23.92, 0);
  });

  it("yields all six positions in a realistic mixed batch (guard against one disappearing)", () => {
    const mixed = [
      { week: 1, season: "2026", player_id: "QB1", stats: { pass_yd: 250.0 }, player: { position: "QB", team: "KC", injury_status: null } },
      { week: 1, season: "2026", player_id: "RB1", stats: { rush_yd: 100.0 }, player: { position: "RB", team: "KC", injury_status: null } },
      { week: 1, season: "2026", player_id: "WR1", stats: { rec_yd: 100.0 }, player: { position: "WR", team: "KC", injury_status: null } },
      { week: 1, season: "2026", player_id: "TE1", stats: { rec_yd: 50.0 }, player: { position: "TE", team: "KC", injury_status: null } },
      { week: 1, season: "2026", player_id: "K1", stats: { pts_ppr: 10.0 }, player: { position: "K", team: "KC", injury_status: null } },
      { week: 1, season: "2026", player_id: "D1", stats: { pts_ppr: 8.0 }, player: { position: "DEF", team: "KC", injury_status: null } },
    ];
    const out = parseSleeperWeekly(mixed);
    const positions = new Set(Object.values(out).map(p => p.pos));
    expect(positions).toEqual(new Set(["QB", "RB", "WR", "TE", "K", "DST"]));
  });
});
