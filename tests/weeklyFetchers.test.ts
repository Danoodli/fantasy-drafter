import { describe, it, expect } from "vitest";
import { parseEspnWeekly } from "../lib/etl/weekly/espnWeekly";
import { slimNflverseWeekly, NFLVERSE_WEEKLY_COLUMNS } from "../lib/etl/weekly/nflverseWeekly";

describe("parseEspnWeekly", () => {
  const payload = {
    players: [
      {
        id: 3139477,
        player: {
          fullName: "Patrick Mahomes",
          defaultPositionId: 1,
          proTeamId: 12,
          stats: [
            // Projection (statSourceId 1) for scoringPeriodId 2 — the one we want.
            { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 2, stats: { "3": 268, "4": 1.7, "20": 0.6 } },
            // Actual (statSourceId 0) — must be ignored.
            { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 2, stats: { "3": 999 } },
            // Another week's projection — must be ignored.
            { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, stats: { "3": 111 } },
          ],
        },
      },
    ],
  };

  it("takes only the projection for the requested week", () => {
    const out = parseEspnWeekly(payload, 2);
    expect(out["3139477"].stats.passYds).toBe(268);
    expect(out["3139477"].stats.passTD).toBeCloseTo(1.7);
    expect(out["3139477"].pos).toBe("QB");
  });

  it("returns nothing for a week ESPN has no projection for", () => {
    expect(Object.keys(parseEspnWeekly(payload, 9))).toHaveLength(0);
  });
});

describe("slimNflverseWeekly", () => {
  it("keeps only the columns the model uses", () => {
    const header = ["player_id", "season", "week", "season_type", "position", "team", "opponent_team", "targets", "carries", "attempts", "receiving_yards", "rushing_yards", "passing_yards", "receptions", "rushing_tds", "receiving_tds", "passing_tds", "passing_interceptions", "headshot_url", "passing_epa"];
    const row = ["00-0001", "2025", "1", "REG", "WR", "DET", "CHI", "10", "0", "0", "120", "0", "0", "7", "0", "1", "0", "0", "http://x", "1.2"];
    const csv = header.join(",") + "\n" + row.join(",");
    const slim = slimNflverseWeekly(csv);
    expect(slim).toHaveLength(1);
    expect(slim[0].targets).toBe("10");
    expect(slim[0].receiving_yards).toBe("120");
    // Dropped: not used by any model, and 8.6 MB per season is worth trimming.
    expect(slim[0].headshot_url).toBeUndefined();
    expect(slim[0].passing_epa).toBeUndefined();
  });

  it("drops non-regular-season rows and rows with no position", () => {
    const header = NFLVERSE_WEEKLY_COLUMNS.join(",");
    const mk = (over: Record<string, string>) =>
      NFLVERSE_WEEKLY_COLUMNS.map((c) => over[c] ?? (c === "season_type" ? "REG" : c === "position" ? "WR" : "0")).join(",");
    const csv = [header, mk({ season_type: "POST" }), mk({ position: "" }), mk({})].join("\n");
    expect(slimNflverseWeekly(csv)).toHaveLength(1);
  });
});
