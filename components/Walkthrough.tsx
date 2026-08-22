"use client";

// The full walkthrough: a scripted journey through EVERY screen — setup and
// advanced config, the cockpit, the player card, making a pick, auto-
// completing the draft, and the recap. Steps either advance on Next or wait
// for the user to actually do the thing ("click a player"). Auto-starts on
// first visit (the setup screen), skippable always, replayable from the ?
// button. Spotlight = a ring with a giant shadow; zero dependencies.

import { useCallback, useEffect, useRef, useState } from "react";

type Screen = "setup" | "cockpit" | "modal" | "recap";

const SCREEN_PROBE: Record<Screen, string> = {
  setup: '[data-tour-screen="setup"]',
  cockpit: '[data-tour-screen="cockpit"]',
  modal: '[data-tour-screen="modal"]',
  recap: '[data-tour-screen="recap"]',
};
const SCREEN_ORDER: Screen[] = ["setup", "cockpit", "modal", "recap"];

interface Step {
  screen: Screen;
  target: string;
  title: string;
  body: string;
  /** "next" = button advances; "click" = advancing requires clicking the target. */
  advance: "next" | "click";
}

const STEPS: Step[] = [
  // ---- Setup ---------------------------------------------------------------
  { screen: "setup", target: '[data-tour="mode-manual"]', advance: "click",
    title: "Welcome to Draft Cockpit",
    body: "It tells you exactly who to take, live, during your draft. Sleeper drafts sync automatically; everything else works in manual mode. Click “Manual entry” to try it." },
  { screen: "setup", target: '[data-tour="formats"]', advance: "next",
    title: "Every format",
    body: "Season-long redraft, or best-ball tournaments (Underdog / DraftKings presets — draft once, let it ride). The engine changes how it drafts for each." },
  { screen: "setup", target: '[data-tour="advanced"]', advance: "next",
    title: "Advanced — all the dials",
    body: "Open this any time: edit every roster slot (set K/DST to 0 for formats without them), scoring tweaks like TE premium and PPFD, and pick your data sources — ESPN, Sleeper, or blends for projections and ADP, plus the insider news wire." },
  { screen: "setup", target: '[data-tour="save-share"]', advance: "next",
    title: "Presets & share links",
    body: "Save this exact setup under a name, or copy a link that applies it for anyone — the whole config lives in the URL. Your draft history and player-exposure Portfolio appear down here too." },
  { screen: "setup", target: '[data-tour="slots"] button', advance: "click",
    title: "Pick your draft slot",
    body: "Click the position you draft from — try any slot." },
  { screen: "setup", target: '[data-tour="open"]', advance: "click",
    title: "Into the cockpit",
    body: "Click “Open the cockpit.”" },
  // ---- Cockpit -------------------------------------------------------------
  { screen: "cockpit", target: '[data-tour="answer"]', advance: "next",
    title: "The answer",
    body: "Who to take, computed from projections, tier cliffs, survival odds, your roster needs, and this room's tendencies — with the reason in plain language. The button confirms; Enter works too." },
  { screen: "cockpit", target: '[data-tour="alternates"]', advance: "next",
    title: "Two ways to disagree",
    body: "Ranked alternates, each with a reason to take them INSTEAD — safer floor, different position, or he'll still be there next round." },
  { screen: "cockpit", target: '[data-tour="search"]', advance: "next",
    title: "Mark picks fast",
    body: "When someone else drafts: type a few letters (“ceedee” works), Enter — gone. Press / to focus from anywhere; typing live-filters the board. Every mark has Undo, and ⌘Z works." },
  { screen: "cockpit", target: '[data-tour="board"]', advance: "next",
    title: "The tier board",
    body: "Every draftable player, tiered — the gaps are the cliffs. Badges: injury, 🔥 trending, 📰 breaking news, ▲▼ ADP movement. Filter with the chips, collapse a position by clicking its header, hover a row for the quick verdict." },
  { screen: "cockpit", target: '[data-tour="planner"]', advance: "next",
    title: "Look ahead",
    body: "What each position probably offers at your NEXT pick, with survival odds — how you decide who can wait a round." },
  { screen: "cockpit", target: '[data-tour="roster"]', advance: "next",
    title: "Roster + live win odds",
    body: "Your build, with ⚡ marking QB stacks. From your third pick, a 200-season simulation updates your win% after every selection." },
  { screen: "cockpit", target: '[data-tour="strategy"]', advance: "next",
    title: "Strategies are dials",
    body: "Zero RB, Hero RB, Tournament Ceiling for best ball… same engine, different parameters. Custom gives you sliders for risk, stacking, and ADP discipline." },
  { screen: "cockpit", target: '[data-tour="board"] div.group > button', advance: "click",
    title: "Click any player",
    body: "Player names open the full card everywhere in the app. Click anyone on the board." },
  // ---- Player card ----------------------------------------------------------
  { screen: "modal", target: '[data-tour="modal-verdict"]', advance: "next",
    title: "The verdict",
    body: "Good, bad, or perfect AT THIS PICK — with risk level and every ADP opinion (FFC, Sleeper, ESPN). All math, no vibes." },
  { screen: "modal", target: '[data-tour="modal-news"]', advance: "next",
    title: "Live intel",
    body: "Breaking posts from the insider wire (Rapoport, Pelissero, ProFootballTalk on Bluesky — live via WebSocket), the Rotowire note, last season's stats, and recent headlines. Close the card when you're done (Esc works)." },
  // ---- Draft + finish -------------------------------------------------------
  { screen: "cockpit", target: '[data-tour="answer"] .btn-shimmer', advance: "click",
    title: "Your turn: draft him",
    body: "When it's your pick, one click commits it (there's confetti). Click the big button." },
  { screen: "cockpit", target: '[data-tour="controls"] summary', advance: "click",
    title: "Fast-forward the rest",
    body: "The ⋯ menu holds draft controls: end early, reset, resume — and auto-complete. Open it." },
  { screen: "cockpit", target: '[data-tour="auto-complete"]', advance: "click",
    title: "Auto-complete",
    body: "The engine drafts your remaining picks, ADP drafts the room — instant full draft. Click it and OK the confirmation. The recap opens itself when the draft ends." },
  // ---- Recap ---------------------------------------------------------------
  { screen: "recap", target: '[data-tour="recap-standings"]', advance: "next",
    title: "Who won the draft",
    body: "Every roster ranked and graded, with position counts and steals/reaches called out. Click any team to expand it; every player name opens his card here too." },
  { screen: "recap", target: '[data-tour="recap-sim"]', advance: "next",
    title: "Simulate the season",
    body: "300 full seasons in your browser: win rates and ceiling percentiles per roster. Re-run it — simulations vary. The sort chips re-rank and re-grade by any metric." },
  { screen: "recap", target: '[data-tour="recap-share"]', advance: "next",
    title: "Flex it",
    body: "Renders your recap as a PNG for the group chat — grade, finish, full roster in position colors." },
  { screen: "recap", target: '[data-tour="recap-back"]', advance: "next",
    title: "That's the app",
    body: "Back on the setup screen you'll find draft history (full recaps of every past draft) and your Portfolio — player exposure across all of them. Replay this tour any time with the ? button. Good luck out there. 🏈" },
];

const SEEN_KEY = "draft-cockpit-tour-v2";

// Survives component remounts when the app switches screens mid-tour.
const store = { active: false, index: 0 };

export function walkthroughSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "done";
  } catch {
    return true;
  }
}

export function startWalkthrough() {
  window.dispatchEvent(new Event("dc-walkthrough"));
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function Walkthrough({ autoStart }: { autoStart: boolean }) {
  const [active, setActiveState] = useState(store.active);
  const [index, setIndexState] = useState(store.index);
  const [rect, setRect] = useState<Rect | null>(null);
  const indexRef = useRef(store.index);
  const setActive = useCallback((v: boolean) => {
    store.active = v;
    setActiveState(v);
  }, []);
  const setIndex = useCallback((updater: number | ((i: number) => number)) => {
    setIndexState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      store.index = next;
      indexRef.current = next;
      return next;
    });
  }, []);

  const close = useCallback(() => {
    try {
      localStorage.setItem(SEEN_KEY, "done");
    } catch {
      // ignore
    }
    setActive(false);
    setRect(null);
  }, [setActive]);

  const advance = useCallback(() => {
    setRect(null);
    setIndex((i) => {
      if (i + 1 >= STEPS.length) {
        close();
        return i;
      }
      return i + 1;
    });
  }, [close, setIndex]);

  // Start: automatically on first visit, or via the ? button from anywhere.
  useEffect(() => {
    const start = () => {
      setIndex(0);
      setRect(null);
      setActive(true);
    };
    // Resuming after a screen-switch remount: store already says active.
    // (module state is external to React — this sync is the effect's job)
    if (store.active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time resume from external store
      setActiveState(true);
    }
    if (autoStart && !walkthroughSeen()) {
      const t = setTimeout(start, 800);
      window.addEventListener("dc-walkthrough", start);
      return () => {
        clearTimeout(t);
        window.removeEventListener("dc-walkthrough", start);
      };
    }
    window.addEventListener("dc-walkthrough", start);
    return () => window.removeEventListener("dc-walkthrough", start);
  }, [autoStart, setActive, setIndex]);

  // Resolve the current step's target: poll for it, and skip whole screens
  // that are already behind us (lets the tour start from any screen).
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const step = STEPS[indexRef.current];
      if (!step) return close();
      const el = document.querySelector(step.target);
      if (el) {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        setTimeout(() => {
          if (stopped) return;
          const r = el.getBoundingClientRect();
          setRect({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
        }, 200);
        return;
      }
      // Target missing: if a LATER step's screen is on-stage, skip forward.
      const myOrder = SCREEN_ORDER.indexOf(step.screen);
      const laterVisible = STEPS.slice(indexRef.current + 1).some(
        (s) =>
          SCREEN_ORDER.indexOf(s.screen) !== myOrder &&
          document.querySelector(SCREEN_PROBE[s.screen]) &&
          !document.querySelector(SCREEN_PROBE[step.screen])
      );
      if (laterVisible) {
        advance();
        setTimeout(tick, 60);
        return;
      }
      setTimeout(tick, 300); // still transitioning — keep waiting
    };
    tick();
    const interval = setInterval(tick, 700); // re-measure as layouts settle
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [active, index, advance, close]);

  // Action steps: advance when the user clicks the highlighted thing.
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      const step = STEPS[indexRef.current];
      if (!step || step.advance !== "click") return;
      if ((e.target as Element | null)?.closest?.(step.target)) {
        setTimeout(advance, 350); // let the click's effect land first
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [active, advance]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, close]);

  if (!active || !rect) return null;
  const step = STEPS[index];
  const last = index === STEPS.length - 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(350, vw - 24);
  const below = rect.top + rect.height + 210 < vh;
  const cardTop = below ? rect.top + rect.height + 12 : Math.max(12, rect.top - 210);
  const cardLeft = Math.min(Math.max(12, rect.left), vw - cardW - 12);

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="false" aria-label="Feature tour">
      <div
        className="pointer-events-none absolute rounded-lg ring-2 ring-wr transition-all duration-300"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          boxShadow: "0 0 0 9999px rgba(8, 11, 15, 0.7)",
        }}
      />
      <div
        className="rise-in pointer-events-auto absolute rounded-xl border border-line bg-panel-2 p-4 shadow-2xl"
        style={{ top: cardTop, left: cardLeft, width: cardW }}
      >
        <p className="font-display text-xl font-bold uppercase">{step.title}</p>
        <p className="mt-1.5 text-sm leading-snug text-ink">{step.body}</p>
        <div className="mt-3 flex items-center gap-2">
          <span className="font-mono text-[11px] text-ink-faint">
            {index + 1}/{STEPS.length}
          </span>
          {step.advance === "click" && (
            <span className="rounded bg-wr/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-wr">
              try it ↑
            </span>
          )}
          <button onClick={close} className="ml-auto text-xs text-ink-faint hover:text-ink">
            Skip tour
          </button>
          {step.advance === "next" ? (
            <button
              onClick={() => (last ? close() : advance())}
              className="rounded bg-wr px-3 py-1 text-xs font-semibold text-field"
            >
              {last ? "Done" : "Next"}
            </button>
          ) : (
            <button
              onClick={() => {
                const el = document.querySelector<HTMLElement>(step.target);
                if (el) el.click(); // the click listener advances us
                else advance();
              }}
              className="rounded border border-line px-2.5 py-1 text-xs text-ink-dim hover:text-ink"
            >
              Do it for me
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
