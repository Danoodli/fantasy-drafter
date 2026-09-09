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

  it("drops rows with no usable stat line rather than emitting a zero player", () => {
    expect(parseSleeperWeekly(rows)["99999"]).toBeUndefined();
  });

  it("re-scoring the parsed line reproduces Sleeper's own pts_ppr within rounding", () => {
    const p = parseSleeperWeekly(rows)["6813"];
    // Sleeper's pts_ppr uses -2 for a lost fumble, same as our preset.
    const ours = scoreStatLine(p.stats, SCORING_PRESETS.ppr);
    expect(ours).toBeCloseTo(23.79, 1);
  });
});
