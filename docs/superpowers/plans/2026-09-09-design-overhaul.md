# Design Overhaul (Leg D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the whole app — `/season` first — a look that is recognisably its own (the draft board's stickers and the broadcast lower-third), with four themes including two light ones, and make every clickable thing look clickable.

**Architecture:** A theme layer (`lib/client/theme.ts` + `[data-theme]` CSS variables behind Tailwind's `@theme` tokens) so every existing token class keeps working and only values move; a shared `AppBar` mounted once in `app/layout.tsx` (navigation + theme switcher, so no route is a dead end); two visual primitives as Tailwind v4 `@utility` classes (`sticker`, `lower-third`) plus button/link utilities; then route-by-route restyles that use only those primitives and tokens. A Playwright shot script renders every route in every theme as the review artifact.

**Tech Stack:** Next.js App Router (client components), React 19, Tailwind v4 (`@theme`, `@utility`), vitest, Playwright (devDependency, chromium installed). No new runtime dependencies; no font changes.

**Spec:** `docs/superpowers/specs/2026-09-09-design-overhaul-design.md` — read it before Task 1 and keep it open. It records the owner's brief verbatim and what "the AI look" is, so every choice here can be checked against it.

**Depends on:** Leg B (`docs/superpowers/plans/2026-09-09-in-season-cockpit.md`) complete on the branch — `/season`, its panels, `PlayerModal`'s `week` mode and `POS_COLOR` tags all exist.

## Global Constraints

- **Do not touch `lib/engine/**`, `lib/etl/**` or `scripts/build-*.ts`.** This leg is presentation. The draft recompute budget (`tests/perf.test.ts`, <50 ms) and every engine test must stay exactly as they are.
- **Colour only through tokens.** No raw hex in a component, no Tailwind `neutral-*`/`gray-*`/`slate-*`/`zinc-*`, no `bg-black`/`bg-white`. The tokens: `field`, `panel`, `panel-2`, `line`, `ink`, `ink-dim`, `ink-faint`, `accent`, `accent-ink`, `good`, `bad`, `warn`, `live`, and the positions `qb rb wr te k dst`. `POS_COLOR` in `lib/client/pos.ts` keeps returning `var(--color-<pos>)`, so it follows the theme for free.
- **Every theme passes the contrast test** (`tests/theme.test.ts`): ink and ink-dim ≥ 4.5:1 and ink-faint ≥ 3:1 on field/panel/panel-2; each position colour ≥ 3:1 on its 6 %-tinted panel; accent-ink ≥ 4.5:1 on accent; good/bad/warn ≥ 3:1 on panel. Change a value, re-run the test; never loosen the test.
- **The mock board is an OCR fixture.** `components/MockBoard.tsx` and `components/DraftBoardGrid.tsx` cell markup must not change (`pnpm ocr:check` reads it). Tokens changing value is fine; classes on cells are not.
- **This repo's Next.js has breaking changes from training data.** Before editing `app/layout.tsx`, read `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md` and `05-server-and-client-components.md`. `layout.tsx` is a server component; the bar and switcher are client components imported into it.
- **No "AI look" defaults** (spec §"What the AI look is"): no uniform bordered grey cards, no numbered markers, no gradient blobs, no cream+serif+terracotta, no bare-text buttons. The sticker edge and the lower-third are the ONLY structural devices; if you find yourself adding a `border border-line rounded-lg p-4` wrapper, use a sticker or nothing.
- **Copy:** sentence case, plain verbs, no "Loading…"/"Coming soon"/"No data". Empty states say what to do next; errors say what happened and how to fix it.
- `prefers-reduced-motion: reduce` disables all transitions/animations globally.
- `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm lint` clean before every commit; `pnpm ui:shots` (Task 8) re-run after any later UI change. Commit trailer after a blank line. The owner's own `pnpm dev` may be running on :3000 — never kill it; use `-p 3005` for your own.

## File Structure

| File | Responsibility |
|---|---|
| `lib/client/theme.ts` | theme catalogue (4 palettes), `applyTheme`, `loadTheme`/`saveTheme`, pure `contrastRatio` |
| `app/globals.css` | `@theme` tokens → per-theme variables under `[data-theme]`; `@utility` primitives (`sticker`, `lower-third`, `btn`, `btn-accent`, `btn-outline`, `link`); reduced motion |
| `app/layout.tsx` | no-flash theme script, `<AppBar />` above `{children}` |
| `components/shell/AppBar.tsx` | brand, route tabs, theme switcher slot |
| `components/shell/ThemeSwitcher.tsx` | four swatches, keyboard-navigable, persists |
| `components/ui/LowerThird.tsx` | headline + big number + label on the accent slab |
| `components/ui/Sticker.tsx` | position-coloured edge + tint wrapper (row / chip / card) |
| `components/season/*` | restyled on the primitives |
| `components/Setup.tsx`, `components/Cockpit.tsx`, `components/TierBoard.tsx` | shell integration, lower-third recommendation, sticker rows |
| `components/Newsroom.tsx`, `components/newsroom/StoryCard.tsx` | sticker edges, slab headers |
| `components/PlayerModal.tsx` | sticker edge, lower-third week line |
| `scripts/ui-shots.ts` | Playwright: routes × themes → `docs/design/shots/*.png` |
| `tests/theme.test.ts` | palette contrast + persistence |

---

### Task 1: Theme layer — tokens, four palettes, persistence, contrast test

**Files:**
- Create: `lib/client/theme.ts`
- Modify: `app/globals.css` (token block only — utilities come in Task 3)
- Modify: `app/layout.tsx` (no-flash script)
- Test: `tests/theme.test.ts`

**Interfaces:**
- Produces: `type ThemeId = "night" | "day" | "prime" | "throwback"`; `interface ThemePalette { id: ThemeId; label: string; scheme: "dark" | "light"; field; panel; panel2; line; ink; inkDim; inkFaint; accent; accentInk; good; bad; warn; live; qb; rb; wr; te; k; dst: string }`; `THEMES: ThemePalette[]`; `THEME_KEY`; `DEFAULT_THEME_FOR(scheme: "dark" | "light"): ThemeId`; `loadTheme(): ThemeId | null`; `saveTheme(id: ThemeId): void`; `applyTheme(id: ThemeId): void` (sets `document.documentElement.dataset.theme` and `style.colorScheme`); `relativeLuminance(hex: string): number`; `contrastRatio(a: string, b: string): number`; `tint(base: string, toward: string, t: number): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/theme.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/theme.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Every hex below was verified against the test's thresholds while writing this plan (2026-09-09). If you change one, the test tells you.

```ts
// lib/client/theme.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/theme.test.ts`
Expected: PASS, 18 tests (5 palette groups × 4 themes as `it.each` rows count individually: 1 + 4 + 4 + 4 + 1 + 2 + 2). If a contrast row fails, print the ratio and adjust the VALUE in `THEMES`, never the threshold.

- [ ] **Step 5: Rewrite the token block in `app/globals.css`**

Replace the two `@theme` blocks at the top of the file (keep everything from `html {` downward untouched for now) with:

```css
@import "tailwindcss";

/* Tailwind tokens resolve to per-theme variables, so every bg-panel /
   text-ink-dim / text-rb class in the app follows [data-theme] on <html>.
   Values live in lib/client/theme.ts (tested for contrast); this file
   mirrors them. Keep the two in sync — tests/theme.test.ts guards the maths,
   scripts/ui-shots.ts shows the result. */
@theme {
  --color-field: var(--t-field);
  --color-panel: var(--t-panel);
  --color-panel-2: var(--t-panel-2);
  --color-line: var(--t-line);
  --color-ink: var(--t-ink);
  --color-ink-dim: var(--t-ink-dim);
  --color-ink-faint: var(--t-ink-faint);
  --color-accent: var(--t-accent);
  --color-accent-ink: var(--t-accent-ink);
  --color-good: var(--t-good);
  --color-bad: var(--t-bad);
  --color-warn: var(--t-warn);
  --color-live: var(--t-live);
  /* Position system — the palette IS the information */
  --color-qb: var(--t-qb);
  --color-rb: var(--t-rb);
  --color-wr: var(--t-wr);
  --color-te: var(--t-te);
  --color-k: var(--t-k);
  --color-dst: var(--t-dst);
}

/* Font tokens must be inline: next/font defines its variables on <body>,
   which :root-level theme variables can't see. */
@theme inline {
  --font-display: var(--font-barlow-condensed);
  --font-body: var(--font-barlow);
  --font-mono: var(--font-plex-mono);
}

/* Night game — the default dark theme */
:root, [data-theme="night"] {
  --t-field: #0E1319; --t-panel: #171E27; --t-panel-2: #202A36; --t-line: #2C3641;
  --t-ink: #EEF2F5; --t-ink-dim: #97A3B0; --t-ink-faint: #6E7A88;
  --t-accent: #3CC9A7; --t-accent-ink: #0E1319; --t-good: #3CC9A7; --t-bad: #F45D6C; --t-warn: #FFB224; --t-live: #3CC9A7;
  --t-qb: #F45D6C; --t-rb: #3CC9A7; --t-wr: #55A9FF; --t-te: #F5A623; --t-k: #B48BF2; --t-dst: #93A3B1;
  color-scheme: dark;
}
/* Day game — the default light theme: chalk white and turf, not cream */
[data-theme="day"] {
  --t-field: #F4F7F5; --t-panel: #FFFFFF; --t-panel-2: #E9EFEC; --t-line: #CFD8D3;
  --t-ink: #14202B; --t-ink-dim: #4C5A66; --t-ink-faint: #7A8791;
  --t-accent: #167A5F; --t-accent-ink: #FFFFFF; --t-good: #1F9E7A; --t-bad: #C8323F; --t-warn: #B26A00; --t-live: #1F9E7A;
  --t-qb: #C8323F; --t-rb: #1F9E7A; --t-wr: #1F6FD1; --t-te: #C97A0A; --t-k: #7C4DD6; --t-dst: #5B6B7A;
  color-scheme: light;
}
/* Prime time — navy and gold broadcast */
[data-theme="prime"] {
  --t-field: #0B1220; --t-panel: #131C2E; --t-panel-2: #1B2740; --t-line: #2A3853;
  --t-ink: #F3EEDF; --t-ink-dim: #A9B0C2; --t-ink-faint: #6E778C;
  --t-accent: #E8B33F; --t-accent-ink: #1A1405; --t-good: #4FD1A5; --t-bad: #F26D7A; --t-warn: #F0B25B; --t-live: #4FD1A5;
  --t-qb: #F26D7A; --t-rb: #4FD1A5; --t-wr: #6FB3FF; --t-te: #F0B25B; --t-k: #C39BFF; --t-dst: #A6B4C6;
  color-scheme: dark;
}
/* Throwback — the 90s paper board */
[data-theme="throwback"] {
  --t-field: #EFEDE6; --t-panel: #FFFDF7; --t-panel-2: #F6F3EA; --t-line: #D9D4C7;
  --t-ink: #1B1B1B; --t-ink-dim: #5A5A57; --t-ink-faint: #83827C;
  --t-accent: #C4381F; --t-accent-ink: #FFFDF7; --t-good: #1E8E5A; --t-bad: #C8323F; --t-warn: #9A5B00; --t-live: #1E8E5A;
  --t-qb: #C8323F; --t-rb: #1E8E5A; --t-wr: #1F5FBF; --t-te: #C46A00; --t-k: #6B3FC4; --t-dst: #4E5B66;
  color-scheme: light;
}

/* Motion is a courtesy, not a requirement. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

Then change the `:focus-visible` rule's colour from `var(--color-wr)` to `var(--color-accent)`.

- [ ] **Step 6: No-flash theme script in `app/layout.tsx`**

Add, as the first child of `<body>` (before `{children}`), an inline script that runs before hydration. Read the layouts doc first (Global Constraints). The script mirrors `loadTheme`/`DEFAULT_THEME_FOR` without importing them (it must be inline text):

```tsx
        <script
          // Runs before paint so a light-theme user never sees a dark flash.
          // Mirrors lib/client/theme.ts: saved id if valid, else by colour scheme.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var k="draft-cockpit-theme-v1",v=localStorage.getItem(k),ok=["night","day","prime","throwback"];if(ok.indexOf(v)<0){v=window.matchMedia("(prefers-color-scheme: light)").matches?"day":"night"}document.documentElement.dataset.theme=v;document.documentElement.style.colorScheme=(v==="day"||v==="throwback")?"light":"dark"}catch(e){}})();`,
          }}
        />
```

Also add `suppressHydrationWarning` to the `<html>` element (the script mutates `data-theme` before React hydrates).

- [ ] **Step 7: Verify nothing moved**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
```

Expected: all clean. Then `pnpm dev -- -p 3005`, open `/` and `/season`: pixel-identical to before (Night game is the old palette). In the browser console run `document.documentElement.dataset.theme = "day"` — the whole page should go light with no component change. Stop your server.

- [ ] **Step 8: Commit**

```bash
git add lib/client/theme.ts tests/theme.test.ts app/globals.css app/layout.tsx
git commit -m "Design: theme layer — four tested palettes behind the existing tokens, no-flash apply"
```

---

### Task 2: The shared shell — `AppBar` with route tabs and the theme switcher

**Files:**
- Create: `components/shell/AppBar.tsx`
- Create: `components/shell/ThemeSwitcher.tsx`
- Modify: `app/layout.tsx` (mount the bar)
- Modify: `components/Setup.tsx` (remove the two ad-hoc links), `components/Newsroom.tsx` (remove "← Cockpit"), `components/season/SeasonCockpit.tsx` (remove "← Draft cockpit"), `components/Cockpit.tsx` (`lg:h-dvh` → `lg:h-[calc(100dvh-3rem)]`)

**Interfaces:**
- Consumes: `THEMES`, `ThemeId`, `loadTheme`, `saveTheme`, `applyTheme`, `DEFAULT_THEME_FOR` (Task 1).
- Produces: `AppBar` (no props), `ThemeSwitcher` (no props). CSS variable `--appbar-h: 3rem` set on `:root` in globals.css.

- [ ] **Step 1: Write `ThemeSwitcher`**

```tsx
// components/shell/ThemeSwitcher.tsx
"use client";

// Four swatches, one per theme. A radio group semantically: arrow keys move,
// Enter/Space select, the choice persists and applies immediately.
import { useEffect, useRef, useState } from "react";
import { THEMES, type ThemeId, applyTheme, loadTheme, saveTheme, DEFAULT_THEME_FOR } from "../../lib/client/theme";

export default function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId | null>(null);
  // Roving tabindex (WAI-ARIA radiogroup): one Tab stop, arrows move focus AND selection.
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // Read the applied theme after mount (the layout's inline script set it).
  useEffect(() => {
    const applied = document.documentElement.dataset.theme as ThemeId | undefined;
    const fallback = DEFAULT_THEME_FOR(window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the pre-hydration state
    setTheme(loadTheme() ?? applied ?? fallback);
  }, []);

  const choose = (id: ThemeId, focus = false) => {
    setTheme(id);
    saveTheme(id);
    applyTheme(id);
    if (focus) refs.current[THEMES.findIndex((x) => x.id === id)]?.focus();
  };

  return (
    <div role="radiogroup" aria-label="Colour theme" className="flex items-center gap-1">
      {THEMES.map((t, i) => {
        const on = t.id === theme;
        // Before hydration nothing is checked; the first swatch is the Tab stop so the group is reachable.
        const tabbable = theme === null ? i === 0 : on;
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[i] = el; }}
            role="radio"
            aria-checked={on}
            aria-label={t.label}
            title={t.label}
            tabIndex={tabbable ? 0 : -1}
            onClick={() => choose(t.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); choose(THEMES[(i + 1) % THEMES.length].id, true); }
              if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); choose(THEMES[(i - 1 + THEMES.length) % THEMES.length].id, true); }
            }}
            className={`h-6 w-6 rounded-full border-2 ${on ? "border-ink" : "border-transparent hover:border-ink-dim"}`}
            style={{ background: `linear-gradient(135deg, ${t.field} 50%, ${t.accent} 50%)` }}
          />
        );
      })}
    </div>
  );
}
```

(The swatch is the one place a raw palette value is used in a component — it is showing the palette itself.)

- [ ] **Step 2: Write `AppBar`**

```tsx
// components/shell/AppBar.tsx
"use client";

// One bar on every route: brand, where you are, where you can go, and the
// theme. This is the "back button" generalised — no page is a dead end.
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeSwitcher from "./ThemeSwitcher";

const TABS = [
  { href: "/", label: "Draft" },
  { href: "/season", label: "In-season" },
  { href: "/newsroom", label: "Newsroom" },
] as const;

export default function AppBar() {
  const path = usePathname() ?? "/";
  return (
    <header className="sticky top-0 z-40 h-[var(--appbar-h)] border-b border-line bg-field/90 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1400px] items-center gap-4 px-4">
        <Link href="/" className="font-display text-xl font-bold uppercase tracking-tight text-ink">
          Draft<span className="text-accent">Cockpit</span>
        </Link>
        <nav aria-label="Sections" className="flex items-center gap-1">
          {TABS.map((t) => {
            const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`rounded px-2.5 py-1 font-mono text-xs uppercase tracking-widest ${
                  active ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-panel hover:text-ink"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <ThemeSwitcher />
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Mount it and retire the ad-hoc links**

In `app/layout.tsx`, import `AppBar` and render `<AppBar />` immediately before `{children}` (after the inline script). Add `--appbar-h: 3rem;` to the `:root, [data-theme="night"]` block in `globals.css` (it is theme-independent but lives with the variables).

Remove: the two `<Link>`s ("Newsroom →", "In-season →") in `components/Setup.tsx`'s header; the "← Cockpit" `<Link>` in `components/Newsroom.tsx`'s header (keep the `<h1>`); the "← Draft cockpit" link Task 13 added in `components/season/SeasonCockpit.tsx`. Remove any now-unused `Link` imports. In `components/Cockpit.tsx`, the root `<main>`'s `lg:h-dvh` becomes `lg:h-[calc(100dvh-var(--appbar-h))]` so the board still fits one screen under the bar. `/mock-board` keeps the bar too (it changes nothing inside the grid).

- [ ] **Step 4: Verify**

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
pnpm dev -- -p 3005
```

Open `/`, `/season`, `/newsroom`: the bar shows the active tab filled in accent, the swatches switch theme instantly and persist across reload and across routes. Tab through the bar with the keyboard: focus ring visible, arrows move between swatches. Confirm the cockpit board still fits one screen at 1280×800 in the Tiers view. Stop your server.

- [ ] **Step 5: Commit**

```bash
git add components/shell app/layout.tsx app/globals.css components/Setup.tsx components/Newsroom.tsx components/season/SeasonCockpit.tsx components/Cockpit.tsx
git commit -m "Design: shared app bar with route tabs and theme switcher; ad-hoc back links retired"
```

---

### Task 3: The two primitives — sticker and lower-third — and button/link utilities

**Files:**
- Modify: `app/globals.css` (append `@utility` blocks)
- Create: `components/ui/Sticker.tsx`
- Create: `components/ui/LowerThird.tsx`

**Interfaces:**
- Produces CSS utilities: `sticker` (uses `--sticker` colour variable; 4 px left edge, 6 % tint, 4 px radius on the right), `sticker-chip`, `lower-third` (accent slab), `btn`, `btn-accent`, `btn-outline`, `btn-quiet`, `link`.
- Produces components: `Sticker({ pos, as?: "row" | "chip" | "card", className?, children, onClick?, title? })`; `LowerThird({ headline, number?, label?, tone?: "accent" | "good" | "bad" | "quiet", children? })`.

- [ ] **Step 0: Roving focus in `ThemeSwitcher` (carried from Task 2's review)**

Task 2 shipped the switcher with arrow keys moving the selection but not focus, and every swatch tabbable. Bring `components/shell/ThemeSwitcher.tsx` to Task 2's Step 1 code as it now reads in this plan: a `refs` array, `tabIndex={tabbable ? 0 : -1}` (first swatch before hydration, the checked one after), `choose(id, focus)` focusing the chosen swatch on arrow keys, and Up/Down as synonyms. Verify with the keyboard: one Tab stop enters the group, arrows move the ring and the focus together and wrap.

- [ ] **Step 1: Utilities**

Append to `app/globals.css`:

```css
/* ---- Primitives ---------------------------------------------------------- */

/* The draft board's sticker: a solid position-coloured edge and a faint tint
   of the same colour behind. Set --sticker to a position colour. This is the
   ONLY way rows, chips and cards are bounded — never a 1px grey border. */
@utility sticker {
  --sticker: var(--color-ink-faint);
  position: relative;
  border-left: 4px solid var(--sticker);
  background: color-mix(in srgb, var(--color-panel) 94%, var(--sticker) 6%);
  border-radius: 0 6px 6px 0;
}
@utility sticker-chip {
  --sticker: var(--color-ink-faint);
  display: inline-flex; align-items: center; gap: 0.375rem;
  border-left: 3px solid var(--sticker);
  background: color-mix(in srgb, var(--color-panel) 92%, var(--sticker) 8%);
  border-radius: 0 4px 4px 0;
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
}

/* The broadcast lower-third: headline on a slab, big number, small label. */
@utility lower-third {
  display: flex; align-items: stretch; gap: 0;
  background: var(--color-accent);
  color: var(--color-accent-ink);
  border-radius: 6px 6px 0 0;
  overflow: hidden;
}

/* Buttons never look like text. */
@utility btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.375rem;
  border-radius: 6px; padding: 0.5rem 0.875rem;
  font-weight: 600; font-size: 0.875rem; line-height: 1.25rem;
}
@utility btn-accent {
  background: var(--color-accent); color: var(--color-accent-ink);
}
.btn-accent:hover:not(:disabled) { filter: brightness(1.1); }
@utility btn-outline {
  border: 2px solid var(--color-ink-dim); color: var(--color-ink);
}
.btn-outline:hover:not(:disabled) { border-color: var(--color-ink); background: var(--color-panel); }
@utility btn-quiet {
  color: var(--color-ink-dim);
}
.btn-quiet:hover:not(:disabled) { color: var(--color-ink); background: var(--color-panel); }
.btn:disabled { opacity: 0.4; }

/* Links: ink, accent underline on hover. */
@utility link {
  color: var(--color-ink);
  text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; text-decoration-thickness: 2px;
}
.link:hover { text-decoration-color: var(--color-accent); }
```

- [ ] **Step 2: Components**

```tsx
// components/ui/Sticker.tsx
"use client";

// A position-coloured sticker, as on the physical draft board. Wrap a row, a
// chip or a card; the edge and tint follow the player's position and the theme.
import type { ReactNode } from "react";
import type { Position } from "../../lib/types";
import { POS_COLOR } from "../../lib/client/pos";

export default function Sticker({
  pos, as = "row", className = "", children, onClick, title,
}: {
  pos: Position | null;
  as?: "row" | "chip" | "card";
  className?: string;
  children: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const style = pos ? ({ "--sticker": POS_COLOR[pos] } as React.CSSProperties) : undefined;
  const base = as === "chip" ? "sticker-chip" : `sticker ${as === "card" ? "p-4" : "px-3 py-1.5"}`;
  const interactive = onClick ? " cursor-pointer hover:brightness-105" : "";
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} style={style} className={`${base}${interactive} text-left ${className}`}>
        {children}
      </button>
    );
  }
  return (
    <div style={style} title={title} className={`${base} ${className}`}>
      {children}
    </div>
  );
}
```

```tsx
// components/ui/LowerThird.tsx
// The broadcast lower-third: a condensed headline on the accent slab, the
// section's one big number beside it, its label small. Headline, number,
// label — that is the whole hierarchy a section needs.
import type { ReactNode } from "react";

const TONE: Record<"accent" | "good" | "bad" | "quiet", string> = {
  accent: "bg-accent text-accent-ink",
  good: "bg-good text-accent-ink",
  // accent-ink, not ink: ink on the red slab measures 2.5–3.3:1 across the themes; accent-ink 5.2–6.3:1.
  bad: "bg-bad text-accent-ink",
  quiet: "bg-panel-2 text-ink",
};

export default function LowerThird({
  headline, number, label, tone = "accent", children,
}: {
  headline: string;
  number?: string;
  label?: string;
  tone?: keyof typeof TONE;
  children?: ReactNode;
}) {
  return (
    <div className={`lower-third ${TONE[tone]}`}>
      <h2 className="flex items-center px-3 py-1.5 font-display text-xl font-bold uppercase tracking-tight">{headline}</h2>
      {number !== undefined && (
        <div className="flex items-baseline gap-2 border-l border-current/30 px-3 py-1.5">
          <span className="font-display text-3xl font-bold tabular-nums leading-none">{number}</span>
          {label && <span className="font-mono text-[11px] uppercase tracking-widest opacity-80">{label}</span>}
        </div>
      )}
      {children && <div className="ml-auto flex items-center px-3 text-xs">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 2b: Pin the CSS mirror to `THEMES`**

`app/globals.css` duplicates the palettes because CSS cannot import TypeScript. Pin them: append to `tests/theme.test.ts`

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("globals.css mirrors THEMES", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  const KEYS: [keyof ThemePalette, string][] = [
    ["field", "field"], ["panel", "panel"], ["panel2", "panel-2"], ["line", "line"], ["ink", "ink"], ["inkDim", "ink-dim"], ["inkFaint", "ink-faint"],
    ["accent", "accent"], ["accentInk", "accent-ink"], ["good", "good"], ["bad", "bad"], ["warn", "warn"], ["live", "live"],
    ["qb", "qb"], ["rb", "rb"], ["wr", "wr"], ["te", "te"], ["k", "k"], ["dst", "dst"],
  ];
  it.each(THEMES.map((t) => [t.id, t] as const))("%s block matches hex-for-hex", (id, t: ThemePalette) => {
    const start = css.indexOf(`[data-theme="${id}"]`);
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start));
    for (const [field, cssName] of KEYS) {
      const m = block.match(new RegExp(`--t-${cssName}:\\s*(#[0-9A-Fa-f]{6})`));
      expect(m, `--t-${cssName} missing in ${id}`).not.toBeNull();
      expect(m![1].toUpperCase()).toBe(t[field].toUpperCase());
    }
  });
});
```

(`ThemePalette` is already imported at the top of the file.) Run `pnpm vitest run tests/theme.test.ts` — 22 tests. A future edit to one file without the other now fails CI.

- [ ] **Step 3: Smoke it on `/season`'s Lineup header only**

In `components/season/SeasonCockpit.tsx`, replace the Lineup section's `<h2 …>Lineup</h2>` + the "99% now → 99%" span with `<LowerThird headline="Lineup" number={`${(advice.winProbability * 100).toFixed(0)}%`} label="to win" />` — one section, to prove the primitive renders in all four themes before Task 4 uses it everywhere.

```bash
pnpm exec tsc --noEmit && pnpm lint && pnpm test
```

`pnpm dev -- -p 3005`: `/season` shows the Lineup slab in each theme; the number is legible in all four. Stop your server.

- [ ] **Step 4: Commit**

```bash
git add app/globals.css components/ui components/season/SeasonCockpit.tsx
git commit -m "Design: sticker and lower-third primitives, button and link utilities"
```

---

### Task 4: `/season` on the new system

**Files:**
- Modify: `components/season/SeasonCockpit.tsx`, `LineupTable.tsx`, `MatchupPanel.tsx`, `WaiversPanel.tsx`, `PlayoffPanel.tsx`, `TradePanel.tsx`, `RosterImport.tsx`, `SleeperSync.tsx`, `RosterPaste.tsx`, `RosterScreenSync.tsx`

**Interfaces:**
- Consumes: `Sticker`, `LowerThird`, the `btn*`/`link` utilities, `contrastRatio`-free semantic tokens `good`/`bad`.
- Produces: no new exports. Behaviour is unchanged — this task moves classes and structure only. Every engine call and prop stays as Leg B left it.

Rules for this task, applied everywhere in the folder:
- **Sections**: each `<section className="rounded-lg border border-line p-4">` loses its border and padding wrapper; it becomes `<section className="space-y-3">` opening with a `LowerThird` (headline = the section name; the number is the section's one figure) and the body below with `px-1`. Numbers per section: Lineup → current win % ("to win"); Matchup → win % (tone `good` ≥ 0.6, `bad` ≤ 0.4, else `accent`); Waivers → count of adds ("adds"); Playoff odds → my odds % ("to make it"), tone by the same rule, or `quiet` with no number when no league; Trade → no number; Must fix → tone `bad`, number = count ("to fix").
- **Rows**: every `<tr>` in `LineupTable` becomes a sticker row: the Slot cell keeps its text; the row gets `style={{ "--sticker": POS_COLOR[p.pos] }}` and className `sticker`; the table loses its `border-t` rules. Waiver entries, trade give/receive items and swap suggestions render inside `<Sticker pos as="row">`.
- **Chips**: roster chips in `RosterImport` and receive chips in `TradePanel` are `<Sticker pos as="chip">` with the `×` button inside.
- **Buttons**: every `<button>` gets `btn` plus `btn-accent` (the one primary action per panel: Load, sync a roster, Apply/Replace roster, Evaluate, Read, Share screen), `btn-outline` (secondary: Stop, Refresh) or `btn-quiet` (tabs, toggles, chips' ×). Tab strips (RosterImport, Waivers modes) render the active tab as `btn btn-accent` and the others `btn btn-quiet`.
- **Names**: player-name buttons in `LineupTable` use `link font-display text-base` so they read as targets.
- **Big numbers** (`MatchupPanel`'s win %, `PlayoffPanel`'s odds) come from the section's `LowerThird`; the panels' own `font-display text-4xl` blocks are removed to avoid saying it twice.
- **Copy**: "Add a player by name…" → placeholder "Add a player" with `aria-label="Add a player"`; empty roster → "Your roster is empty. Sync a Sleeper league, paste a roster page, or add players by name."; playoff panel without a league → "Playoff odds need every roster in the league. Sync a Sleeper league to see them."; waivers empty → "Nobody available would improve your lineup{over the rest of the season | at X this week}."; "Simulating the rest of the season…" stays (it says what is happening).
- **No `text-neutral-*`, no `border border-line`, no `rounded-lg border` wrappers** remain in the folder when done: `grep -rn "border-line\|neutral-" components/season` must return only the AppBar-unrelated legitimate uses (`divide-line` inside preview lists is fine).

- [ ] **Step 1: Apply the rules** file by file, running `pnpm exec tsc --noEmit && pnpm lint` after each.

- [ ] **Step 2: Browser pass in all four themes** (`pnpm dev -- -p 3005`, manual roster of 8–9 real players, then the Sleeper sample league `289646328504385536` roster 1): every section opens with a slab; the lineup reads as a strip of stickers; win % is coloured by band; nothing renders as a grey card; every button is filled or outlined; the theme switcher recolours everything including sticker tints. Take a screenshot per theme to `/tmp` and describe what you see in the report.

- [ ] **Step 3: Commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
git add components/season
git commit -m "Design: /season on stickers and lower-thirds, filled buttons, plain copy"
```

---

### Task 5: Draft cockpit and Setup on the new system

**Files:**
- Modify: `components/Cockpit.tsx`, `components/TierBoard.tsx`, `components/Setup.tsx`, `components/RecentPicks.tsx`, `components/Shortlist.tsx`, `components/RoomStrip.tsx`

**Interfaces:**
- Consumes: `Sticker`, `LowerThird`, utilities.
- Constraint: `components/DraftBoardGrid.tsx` and `components/MockBoard.tsx` are NOT touched (OCR fixture). `pnpm ocr:check` runs at the end against your dev server.

Rules:
- **The recommendation is the hero and gets the lower-third**: in `Cockpit.tsx`, the block that shows the recommended player's name, projected points/VONA and the one-line reason becomes `LowerThird` with headline = player name, number = the figure the block already shows first, label = its unit, and the reason line as the slab's trailing child. Keep the Pick button as `btn btn-accent` directly under it; keep `data-tour` attributes where they are (the walkthrough targets them).
- **Tier board rows are stickers**: in `TierBoard.tsx`, each player `<li>`/row gets `sticker` with `--sticker` = the position colour; the position column header keeps its coloured bottom border. The recommended row's `rec-glow` stays.
- **Setup**: filled `btn btn-accent` for "Start draft"/primary, `btn-outline` for secondary, `btn-quiet` for toggles; the two removed links are gone (Task 2); the "Draft in progress" resume panel is a `Sticker pos={null}` card with `--sticker: var(--color-accent)`.
- **RecentPicks, Shortlist, RoomStrip**: rows/chips as stickers; buttons as utilities.
- Same grep rule as Task 4 over these files.

- [ ] **Step 1: Apply**, `tsc`/`lint` after each file.
- [ ] **Step 2: Browser pass** in all four themes: run a few picks in manual mode; the recommendation slab updates; the board still fits one screen; `pnpm ocr:check` against your server (`PORT=3005` if the script takes one — read `scripts/ocr-grid-check.ts` for how it finds the server) passes.
- [ ] **Step 3: Commit** `git add components/Cockpit.tsx components/TierBoard.tsx components/Setup.tsx components/RecentPicks.tsx components/Shortlist.tsx components/RoomStrip.tsx && git commit -m "Design: draft cockpit — lower-third recommendation, sticker tiers, filled controls"`.

---

### Task 6: Newsroom and the player card

**Files:**
- Modify: `components/Newsroom.tsx`, `components/newsroom/StoryCard.tsx`, `components/newsroom/TopStories.tsx`, `components/newsroom/FilterMenu.tsx`, `components/PlayerModal.tsx`

Rules:
- **Newsroom**: the severity buckets open with `LowerThird` (headline = bucket name, tone `bad` for the top bucket, `accent` for the next, `quiet` for the rest; number = item count, label "items"); each `StoryCard` is a `Sticker pos as="card"` with the player's position; filter controls are `btn btn-quiet`/`btn-accent`; the header keeps its live dot and refresh (`btn-outline`).
- **PlayerModal**: the dialog panel gets a 6 px left edge in the player's colour (`style={{ borderLeft: `6px solid ${color}` }}` on the existing panel `div`); in `week` mode the `WeekLine` renders as a `LowerThird` (headline "Week N", number = projection, label = "proj · floor–ceiling · vs OPP", tone by status: `bad` when `pPlay < 0.5`, else `accent`); the Close/Draft buttons use utilities; the draft verdict pill keeps its own colour (it is semantic).
- Same grep rule.

- [ ] **Step 1: Apply**, `tsc`/`lint` after each file.
- [ ] **Step 2: Browser pass**: `/newsroom` in four themes; open a player card from `/season` and from `/` — both variants (week / draft) look intentional.
- [ ] **Step 3: Commit** `git add components/Newsroom.tsx components/newsroom components/PlayerModal.tsx && git commit -m "Design: newsroom buckets as lower-thirds, story stickers, player card edge"`.

---

### Task 7: Sweep — anything still grey

**Files:**
- Modify: whatever the grep finds under `components/` and `app/` except `DraftBoardGrid.tsx`, `MockBoard.tsx`.

- [ ] **Step 1:** `grep -rn "neutral-\|gray-\|slate-\|zinc-\|bg-black\|bg-white\|#[0-9a-fA-F]\{6\}\|rgba\?(" components app --include=*.tsx | grep -v "DraftBoardGrid\|MockBoard\|ThemeSwitcher"` — must return nothing when done. Fix each hit with a token or a primitive. Known hits from Task 1's report: `components/Walkthrough.tsx:283` (dark scrim `rgba(8,11,15,0.7)` → `color-mix(in srgb, var(--color-field) 70%, transparent)`); `components/ScreenSync.tsx:172,177` canvas colours — a canvas cannot read CSS variables, so read them once via `getComputedStyle(document.documentElement).getPropertyValue("--color-field")` (and `--color-accent`) before painting. Also sweep `app/globals.css` below the token block: `.live-dot`'s `rgb(60 201 167 / 0.55)` becomes `color-mix(in srgb, var(--color-live) 55%, transparent)`, black shadows may stay (shadows are shadows), and the now-redundant granular `@media (prefers-reduced-motion)` blocks are removed in favour of the global rule.
- [ ] **Step 2:** `grep -rn "rounded-lg border border-line" components app --include=*.tsx | grep -v "DraftBoardGrid\|MockBoard"` — each remaining wrapper becomes a sticker card or loses its border; list every file you changed in the report.
- [ ] **Step 2b: Inputs must look editable.** In the light themes a bare `<input>` on a panel has no visible boundary (seen on `/season`'s "Add a player" and the two number inputs). Add to `app/globals.css`:

```css
/* Text inputs: a field, not a line of text. */
@utility field {
  background: var(--color-panel-2);
  border: 1px solid var(--color-line);
  border-bottom: 2px solid var(--color-ink-faint);
  border-radius: 6px 6px 0 0;
  padding: 0.375rem 0.625rem;
  color: var(--color-ink);
}
.field::placeholder { color: var(--color-ink-faint); }
.field:focus { border-bottom-color: var(--color-accent); outline: none; }
```

and apply `field` to every `<input>`, `<select>` and `<textarea>` under `components/` and `app/` (grep `<input`, `<select`, `<textarea`), removing their ad-hoc `rounded border border-line bg-field …` classes. The `:focus-visible` ring still applies to keyboard focus.

- [ ] **Step 3:** `pnpm test && pnpm exec tsc --noEmit && pnpm lint`; commit `git add -A components app && git commit -m "Design: sweep — no raw greys or bordered cards remain outside the OCR fixture"`.

---

### Task 8: `pnpm ui:shots` — the review artifact

**Files:**
- Create: `scripts/ui-shots.ts`
- Create: `docs/design/shots/` (committed PNGs)
- Modify: `package.json` (`"ui:shots": "tsx scripts/ui-shots.ts"`)

- [ ] **Step 1: Write the script**

```ts
// scripts/ui-shots.ts
// Renders every route in every theme to docs/design/shots/<route>-<theme>.png.
// The owner's review artifact for design work, committed so a before/after
// exists. Needs a dev server: pass its URL, e.g.
//   pnpm ui:shots -- --url=http://localhost:3005
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const THEMES = ["night", "day", "prime", "throwback"] as const;
const ROUTES: { name: string; path: string; prepare?: (page: import("playwright").Page) => Promise<void> }[] = [
  { name: "draft", path: "/" },
  { name: "newsroom", path: "/newsroom" },
  {
    name: "season",
    path: "/season",
    // A manual roster of real 2026 board ids so the lineup, matchup and waivers render.
    prepare: async (page) => {
      await page.evaluate(() => {
        const team = {
          id: "shots", name: "Shots", source: "manual", savedAt: new Date().toISOString(),
          config: { platform: "manual", leagueId: "", draftId: "", myDraftSlot: null, teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft", rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }, flexEligible: ["RB", "WR", "TE"], strategy: "balanced" },
          roster: ["4984", "9509", "7564", "9221", "9493", "11604", "11539", "SEA", "8112"].map((playerId) => ({ playerId, slot: "bench" })),
        };
        localStorage.setItem("draft-cockpit-teams-v1", JSON.stringify([team]));
      });
      await page.reload();
      await page.getByText("Lineup").first().waitFor({ timeout: 15000 });
    },
  },
];

async function main() {
  const url = process.argv.find((a) => a.startsWith("--url="))?.slice(6) ?? "http://localhost:3000";
  const out = join(process.cwd(), "docs", "design", "shots");
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  for (const route of ROUTES) {
    await page.goto(url + route.path, { waitUntil: "networkidle" });
    if (route.prepare) await route.prepare(page);
    for (const theme of THEMES) {
      await page.evaluate((t) => {
        localStorage.setItem("draft-cockpit-theme-v1", t);
        document.documentElement.dataset.theme = t;
        document.documentElement.style.colorScheme = t === "day" || t === "throwback" ? "light" : "dark";
      }, theme);
      await page.waitForTimeout(250);
      const file = join(out, `${route.name}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log("wrote", file);
    }
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run it** against your own dev server (`pnpm dev -- -p 3005`, then `pnpm ui:shots -- --url=http://localhost:3005`). Expected: 12 PNGs. LOOK at them — each theme should read as a designed variant, not a recolour with broken contrast. If something is illegible, fix the component (not the shot).
- [ ] **Step 3: Commit** `git add scripts/ui-shots.ts docs/design/shots package.json && git commit -m "Design: ui:shots renders every route in every theme"`.

---

### Task 9: Docs

**Files:**
- Modify: `AGENTS.md`, `README.md`, `docs/superpowers/specs/2026-09-09-design-overhaul-design.md` (status line)

- [ ] **Step 1: AGENTS.md** — add to the project-notes list:

```markdown
- **Design system**: colour only through tokens (`lib/client/theme.ts` holds the four palettes; `app/globals.css` mirrors them under `[data-theme]`; `tests/theme.test.ts` enforces contrast). Two primitives bound everything — the `sticker` (position-coloured edge + tint) and the `LowerThird` (headline · big number · label); never a 1 px grey card, never `neutral-*`. Buttons are `btn btn-accent|btn-outline|btn-quiet`, links are `link`. The `AppBar` in `app/layout.tsx` is the only navigation. `DraftBoardGrid`/`MockBoard` cell markup is an OCR fixture — tokens may change, classes may not (`pnpm ocr:check`). After any UI change run `pnpm ui:shots` against a dev server and look at `docs/design/shots/`.
```

- [ ] **Step 2: README.md** — a short "Look and themes" section: the four themes and how to switch; that light mode follows the OS by default; `pnpm ui:shots`.
- [ ] **Step 3:** Set the spec's status to "implemented 2026-09-09". Commit `git add AGENTS.md README.md docs/superpowers/specs/2026-09-09-design-overhaul-design.md && git commit -m "Design: document the theme layer and primitives"`.

---

## Self-Review

**Spec coverage.** Signature element (sticker edge) → Tasks 3–7; lower-third headers → 3–6; semantic colour on win %/odds only → 4; no numbered markers/dividers → 4–7 rules; four themes with contrast → 1; `prefers-color-scheme` default, persistence, no-flash → 1; switcher in the bar → 2; reduced motion → 1; shared shell / no dead ends → 2; affordances (filled/outlined buttons, link underline, row hover, focus ring in accent, sticker chips) → 3–7; copy rules → 4 (and applied in 5–6 where copy is touched); route-by-route → 4 (`/season`), 5 (`/`), 6 (newsroom, player card), `/mock-board` untouched → 5's constraint; testing: `ocr:check` → 5, `ui:shots` → 8, contrast test → 1, tsc/lint/test → every task.

**Placeholder scan.** Tasks 4–7 are restyle passes over large existing files (Cockpit is 1,370 lines); their steps are rules with exact class mappings, the primitives' full code lives in Task 3, and every new string of copy is spelled out. That is deliberate: reprinting 3,000 lines of JSX to change class names would hide the rules in noise. The implementer for those tasks needs judgement (sonnet or better) and screenshots.

**Type consistency.** `ThemeId`, `ThemePalette`, `THEMES`, `loadTheme`, `saveTheme`, `applyTheme`, `DEFAULT_THEME_FOR`, `contrastRatio`, `tint` defined in Task 1 and consumed in 1–2 and 8 (by name in the inline script, mirrored); `Sticker`, `LowerThird` defined in Task 3 and consumed in 4–6; `--appbar-h` defined in Task 2 and consumed in 2.

**Risks stated.** Tailwind v4 `@utility` with `color-mix()` — supported in every browser this app targets (Chrome/Safari 17+, per `screenCapture.ts`'s own requirement). The inline theme script duplicates the theme id list; the contrast test does not cover that duplication — Task 8's shots do, and the AGENTS bullet names both files.
