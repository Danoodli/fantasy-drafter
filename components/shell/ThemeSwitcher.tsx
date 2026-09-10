"use client";

// Four swatches, one per theme. A radio group semantically: arrow keys move,
// Enter/Space select, the choice persists and applies immediately.
import { useEffect, useState } from "react";
import { THEMES, type ThemeId, applyTheme, loadTheme, saveTheme, DEFAULT_THEME_FOR } from "../../lib/client/theme";

export default function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId | null>(null);

  // Read the applied theme after mount (the layout's inline script set it).
  useEffect(() => {
    const applied = document.documentElement.dataset.theme as ThemeId | undefined;
    const fallback = DEFAULT_THEME_FOR(window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the pre-hydration state
    setTheme(loadTheme() ?? applied ?? fallback);
  }, []);

  const choose = (id: ThemeId) => {
    setTheme(id);
    saveTheme(id);
    applyTheme(id);
  };

  return (
    <div role="radiogroup" aria-label="Colour theme" className="flex items-center gap-1">
      {THEMES.map((t) => {
        const on = t.id === theme;
        return (
          <button
            key={t.id}
            role="radio"
            aria-checked={on}
            aria-label={t.label}
            title={t.label}
            onClick={() => choose(t.id)}
            onKeyDown={(e) => {
              const i = THEMES.findIndex((x) => x.id === t.id);
              if (e.key === "ArrowRight") choose(THEMES[(i + 1) % THEMES.length].id);
              if (e.key === "ArrowLeft") choose(THEMES[(i - 1 + THEMES.length) % THEMES.length].id);
            }}
            className={`h-6 w-6 rounded-full border-2 ${on ? "border-ink" : "border-transparent hover:border-ink-dim"}`}
            style={{ background: `linear-gradient(135deg, ${t.field} 50%, ${t.accent} 50%)` }}
          />
        );
      })}
    </div>
  );
}
