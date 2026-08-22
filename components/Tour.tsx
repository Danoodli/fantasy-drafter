"use client";

// Guided tour: a spotlight walks through every major feature. Auto-starts on
// first visit, skippable at any point (Esc too), replayable forever from the
// ? button. No library — a ring with a giant box-shadow is the spotlight.

import { useCallback, useEffect, useState } from "react";

export interface TourStep {
  /** CSS selector for the element to spotlight ([data-tour="…"]). */
  target: string;
  title: string;
  body: string;
}

const SEEN_KEY = "draft-cockpit-tour-v1";

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "done";
  } catch {
    return true;
  }
}

export function markTourSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "done");
  } catch {
    // ignore
  }
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const close = useCallback(() => {
    markTourSeen();
    onClose();
  }, [onClose]);

  // Measure the current target (skipping any that aren't on screen).
  useEffect(() => {
    let idx = index;
    let el: Element | null = null;
    while (idx < steps.length) {
      el = document.querySelector(steps[idx].target);
      if (el) break;
      idx++;
    }
    if (!el || idx >= steps.length) {
      if (idx !== index) close();
      return;
    }
    if (idx !== index) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- skipping steps whose DOM target doesn't exist is inherently a DOM-state sync
      setIndex(idx);
      return;
    }
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const measure = () => {
      const r = el!.getBoundingClientRect();
      setRect({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
    };
    const t = setTimeout(measure, 180); // let scrollIntoView settle
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, [index, steps, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight" || e.key === "Enter")
        setIndex((i) => (i + 1 < steps.length ? i + 1 : (close(), i)));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps.length, close]);

  if (!rect) return null;
  const step = steps[index];
  const last = index === steps.length - 1;

  // Card placement: below the target when there's room, else above; clamped.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const cardW = Math.min(340, vw - 24);
  const below = rect.top + rect.height + 190 < vh;
  const cardTop = below ? rect.top + rect.height + 12 : Math.max(12, rect.top - 190);
  const cardLeft = Math.min(Math.max(12, rect.left), vw - cardW - 12);

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label="Feature tour">
      {/* Spotlight: the ring's massive shadow dims everything else */}
      <div
        className="pointer-events-none absolute rounded-lg ring-2 ring-wr transition-all duration-300"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          boxShadow: "0 0 0 9999px rgba(8, 11, 15, 0.72)",
        }}
      />
      {/* Click-catcher so the page underneath doesn't react */}
      <div className="absolute inset-0" onClick={close} />
      <div
        className="rise-in absolute rounded-xl border border-line bg-panel-2 p-4 shadow-2xl"
        style={{ top: cardTop, left: cardLeft, width: cardW }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="font-display text-xl font-bold uppercase">{step.title}</p>
        <p className="mt-1.5 text-sm leading-snug text-ink">{step.body}</p>
        <div className="mt-3 flex items-center gap-2">
          <span className="font-mono text-[11px] text-ink-faint">
            {index + 1}/{steps.length}
          </span>
          <div className="flex gap-1">
            {steps.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full ${i === index ? "bg-wr" : "bg-line"}`}
              />
            ))}
          </div>
          <button onClick={close} className="ml-auto text-xs text-ink-faint hover:text-ink">
            Skip
          </button>
          {index > 0 && (
            <button
              onClick={() => setIndex(index - 1)}
              className="rounded border border-line px-2.5 py-1 text-xs text-ink-dim hover:text-ink"
            >
              Back
            </button>
          )}
          <button
            onClick={() => (last ? close() : setIndex(index + 1))}
            className="rounded bg-wr px-3 py-1 text-xs font-semibold text-field"
          >
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
