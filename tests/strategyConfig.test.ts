// Guards on the strategy config. The best-ball default was set to
// tournament-ceiling, which the 2024+2025 season backtests rank mid-pack
// (+169 vs the ADP bot) against robust-rb's +321 — a silent, invisible
// mis-default. These tests keep the picker and the defaults honest.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BESTBALL_PRESETS,
  BESTBALL_DEFAULT_STRATEGY,
  REDRAFT_DEFAULT_STRATEGY,
  defaultStrategyFor,
  DEFAULT_CONFIG,
} from "../lib/client/config";
import type { LeagueType, Strategy } from "../lib/types";

const strategies: Strategy[] = JSON.parse(
  readFileSync(join(process.cwd(), "config", "strategies.json"), "utf8")
);
const ids = new Set(strategies.map((s) => s.id));

describe("strategy config", () => {
  it("has exactly one recommended strategy per league type", () => {
    for (const lt of ["redraft", "bestball"] as LeagueType[]) {
      const rec = strategies.filter((s) => s.recommendedFor?.includes(lt));
      expect(rec.map((s) => s.id), `recommended for ${lt}`).toHaveLength(1);
    }
  });

  it("auto-selects the format's backtest winner", () => {
    // Robust RB won best ball in 2024 (+273) and 2025 (+368); Balanced tied
    // first in redraft both years. Changing these should require new evidence.
    expect(defaultStrategyFor("bestball")).toBe("robust-rb");
    expect(defaultStrategyFor("redraft")).toBe("balanced");
  });

  it("keeps every default and recommendation pointing at a real strategy", () => {
    expect(ids).toContain(BESTBALL_DEFAULT_STRATEGY);
    expect(ids).toContain(REDRAFT_DEFAULT_STRATEGY);
    expect(ids).toContain(DEFAULT_CONFIG.strategy);
    for (const s of strategies) {
      if (s.recommendedFor) expect(s.recommendedFor.length).toBeGreaterThan(0);
    }
  });

  it("wires every best-ball preset to the best-ball default", () => {
    expect(BESTBALL_PRESETS.length).toBeGreaterThan(0);
    for (const p of BESTBALL_PRESETS) {
      expect(p.config.strategy, `preset ${p.id}`).toBe(BESTBALL_DEFAULT_STRATEGY);
      expect(p.config.leagueType, `preset ${p.id}`).toBe("bestball");
    }
  });

  it("never hides a recommended strategy, and leaves most of them pickable", () => {
    for (const s of strategies) {
      if (s.recommendedFor) expect(s.hidden, `${s.id} is recommended`).not.toBe(true);
    }
    const pickable = strategies.filter((s) => !s.hidden);
    expect(pickable.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps hidden strategies in config so the backtest can still measure them", () => {
    // `--strategy=all` reads this file directly; hiding must not delete.
    const hidden = strategies.filter((s) => s.hidden);
    for (const s of hidden) {
      expect(s.lambda).toBeTypeOf("number");
      expect(s.positionCaps).toBeTruthy();
    }
  });
});
