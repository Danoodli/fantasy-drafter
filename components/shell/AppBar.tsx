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
