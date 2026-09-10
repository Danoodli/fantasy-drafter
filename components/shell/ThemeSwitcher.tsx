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
