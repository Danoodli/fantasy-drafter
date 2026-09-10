import { describe, it, expect, beforeEach } from "vitest";
import { THEMES, contrastRatio, tint, loadTheme, saveTheme, DEFAULT_THEME_FOR, type ThemePalette } from "../lib/client/theme";

const POS = ["qb", "rb", "wr", "te", "k", "dst"] as const;

describe("theme palettes", () => {
  it("ships exactly the four themes, two dark and two light", () => {
    expect(THEMES.map((t) => t.id)).toEqual(["night", "day", "prime", "throwback"]);
    expect(THEMES.filter((t) => t.scheme === "dark").map((t) => t.id)).toEqual(["night", "prime"]);
  });

  it.each(THEMES.map((t) => [t.id, t] as const))("%s: text is readable on every surface", (_id, t: ThemePalette) => {
    for (const surface of [t.field, t.panel, t.panel2]) {
      expect(contrastRatio(t.ink, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.inkDim, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.inkFaint, surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEMES.map((t) => [t.id, t] as const))("%s: every position colour reads on its sticker tint", (_id, t: ThemePalette) => {
    for (const pos of POS) {
      const colour = t[pos];
      expect(contrastRatio(colour, tint(t.panel, colour, 0.06))).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEMES.map((t) => [t.id, t] as const))("%s: accent, good, bad and warn are legible", (_id, t: ThemePalette) => {
    expect(contrastRatio(t.accentInk, t.accent)).toBeGreaterThanOrEqual(4.5);
    for (const s of [t.good, t.bad, t.warn]) expect(contrastRatio(s, t.panel)).toBeGreaterThanOrEqual(3);
  });

  it("keeps each position's hue family across themes (RB is always the green one)", () => {
    // Coarse check: the green channel dominates RB and the red channel dominates QB in every theme.
    for (const t of THEMES) {
      const ch = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const [rq, gq] = ch(t.qb); const [rr, gr] = ch(t.rb);
      expect(rq).toBeGreaterThan(gq);
      expect(gr).toBeGreaterThan(rr);
    }
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 6);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 1);
  });
  it("is symmetric", () => {
    expect(contrastRatio("#3CC9A7", "#0E1319")).toBeCloseTo(contrastRatio("#0E1319", "#3CC9A7"), 10);
  });
});

describe("persistence", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(), key: () => null, length: 0,
    } as Storage;
  });
  it("round-trips a theme and rejects junk", () => {
    expect(loadTheme()).toBeNull();
    saveTheme("prime");
    expect(loadTheme()).toBe("prime");
    localStorage.setItem("draft-cockpit-theme-v1", "neon");
    expect(loadTheme()).toBeNull();
  });
  it("defaults by colour scheme", () => {
    expect(DEFAULT_THEME_FOR("dark")).toBe("night");
    expect(DEFAULT_THEME_FOR("light")).toBe("day");
  });
});
