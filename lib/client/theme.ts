// The theme layer. A theme is a complete palette; Tailwind's tokens
// (bg-panel, text-ink-dim, text-rb, …) resolve to these values through the
// [data-theme] blocks in app/globals.css, so switching a theme never touches
// a component. Two darks, two lights. The position hues are constant across
// themes — "RB is the green one" survives a switch — only their lightness
// moves so they read on each surface.
export type ThemeId = "night" | "day" | "prime" | "throwback";

export interface ThemePalette {
  id: ThemeId;
  label: string;
  scheme: "dark" | "light";
  field: string; panel: string; panel2: string; line: string;
  ink: string; inkDim: string; inkFaint: string;
  accent: string; accentInk: string; good: string; bad: string; warn: string; live: string;
  qb: string; rb: string; wr: string; te: string; k: string; dst: string;
}

export const THEMES: ThemePalette[] = [
  {
    id: "night", label: "Night game", scheme: "dark",
    field: "#0E1319", panel: "#171E27", panel2: "#202A36", line: "#2C3641",
    ink: "#EEF2F5", inkDim: "#97A3B0", inkFaint: "#6E7A88",
    accent: "#3CC9A7", accentInk: "#0E1319", good: "#3CC9A7", bad: "#F45D6C", warn: "#FFB224", live: "#3CC9A7",
    qb: "#F45D6C", rb: "#3CC9A7", wr: "#55A9FF", te: "#F5A623", k: "#B48BF2", dst: "#93A3B1",
  },
  {
    id: "day", label: "Day game", scheme: "light",
    field: "#F4F7F5", panel: "#FFFFFF", panel2: "#E9EFEC", line: "#CFD8D3",
    ink: "#14202B", inkDim: "#4C5A66", inkFaint: "#7A8791",
    accent: "#167A5F", accentInk: "#FFFFFF", good: "#1F9E7A", bad: "#C8323F", warn: "#B26A00", live: "#1F9E7A",
    qb: "#C8323F", rb: "#1F9E7A", wr: "#1F6FD1", te: "#C97A0A", k: "#7C4DD6", dst: "#5B6B7A",
  },
  {
    id: "prime", label: "Prime time", scheme: "dark",
    field: "#0B1220", panel: "#131C2E", panel2: "#1B2740", line: "#2A3853",
    ink: "#F3EEDF", inkDim: "#A9B0C2", inkFaint: "#6E778C",
    accent: "#E8B33F", accentInk: "#1A1405", good: "#4FD1A5", bad: "#F26D7A", warn: "#F0B25B", live: "#4FD1A5",
    qb: "#F26D7A", rb: "#4FD1A5", wr: "#6FB3FF", te: "#F0B25B", k: "#C39BFF", dst: "#A6B4C6",
  },
  {
    id: "throwback", label: "Throwback", scheme: "light",
    field: "#EFEDE6", panel: "#FFFDF7", panel2: "#F6F3EA", line: "#D9D4C7",
    ink: "#1B1B1B", inkDim: "#5A5A57", inkFaint: "#83827C",
    accent: "#C4381F", accentInk: "#FFFDF7", good: "#1E8E5A", bad: "#C8323F", warn: "#9A5B00", live: "#1E8E5A",
    qb: "#C8323F", rb: "#1E8E5A", wr: "#1F5FBF", te: "#C46A00", k: "#6B3FC4", dst: "#4E5B66",
  },
];

export const THEME_KEY = "draft-cockpit-theme-v1";
const IDS = new Set<string>(THEMES.map((t) => t.id));

export function DEFAULT_THEME_FOR(scheme: "dark" | "light"): ThemeId {
  return scheme === "light" ? "day" : "night";
}

export function loadTheme(): ThemeId | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw && IDS.has(raw) ? (raw as ThemeId) : null;
  } catch {
    return null;
  }
}

export function saveTheme(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // private mode: the in-memory choice still applies for this session
  }
}

/** Apply to the document. Also sets color-scheme so native controls follow. */
export function applyTheme(id: ThemeId): void {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
  document.documentElement.dataset.theme = t.id;
  document.documentElement.style.colorScheme = t.scheme;
}

// ---- pure colour maths (WCAG 2.x) ------------------------------------------
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Linear mix of `base` toward `toward` by `t` in [0, 1]; the sticker tint is tint(panel, pos, 0.06). */
export function tint(base: string, toward: string, t: number): string {
  const a = rgb(base);
  const b = rgb(toward);
  return "#" + a.map((v, i) => Math.round(v * (1 - t) + b[i] * t).toString(16).padStart(2, "0")).join("");
}
