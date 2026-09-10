"use client";

import { useState } from "react";
import type { Advice } from "../../lib/engine/season/advice";
import LowerThird from "../ui/LowerThird";

export default function MatchupPanel({
  advice, oppName, oppIsTotal, oppTotal, onOppTotal,
}: {
  advice: Advice;
  oppName: string | null;
  oppIsTotal: boolean;
  oppTotal: number;
  onOppTotal: (v: number) => void;
}) {
  const pct = (advice.winProbability * 100).toFixed(0);
  // Local text state so a keystroke never commits — Number("") is 0, and a
  // number input's onChange fires with an EMPTY string while the field is
  // mid-edit (e.g. backspacing "120" to retype it), which would silently zero
  // the opponent's total on every edit. Commit only on blur/Enter, and only
  // when the text actually parses.
  const [oppTotalText, setOppTotalText] = useState(() => String(Math.round(oppTotal)));
  // Adjusting state when a prop changes, done during render per React's own
  // guidance — not in an effect, which would commit the stale text for one
  // extra frame and trip react-hooks/set-state-in-effect besides.
  const [syncedOppTotal, setSyncedOppTotal] = useState(oppTotal);
  if (oppTotal !== syncedOppTotal) {
    setSyncedOppTotal(oppTotal);
    setOppTotalText(String(Math.round(oppTotal)));
  }
  const commitOppTotal = () => {
    const n = Number(oppTotalText);
    if (oppTotalText.trim() !== "" && Number.isFinite(n)) onOppTotal(n);
    else setOppTotalText(String(Math.round(oppTotal)));
  };
  const band = (t: { p10: number; p50: number; p90: number }) => `${t.p10.toFixed(0)} · ${t.p50.toFixed(0)} · ${t.p90.toFixed(0)}`;
  const tone = advice.winProbability >= 0.6 ? "good" : advice.winProbability <= 0.4 ? "bad" : "accent";
  return (
    <section className="space-y-3">
      <LowerThird headline={`Matchup${oppName ? ` vs ${oppName}` : ""}`} number={`${pct}%`} label="to win" tone={tone} />
      <table className="px-1 text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-faint"><th className="pr-4 font-normal"></th><th className="pr-4 font-normal">Mean</th><th className="font-normal">Floor · Median · Ceiling</th></tr>
        </thead>
        <tbody>
          <tr><td className="pr-4">You</td><td className="pr-4 tabular-nums">{advice.myTotal.mean.toFixed(1)}</td><td className="tabular-nums text-ink-dim">{band(advice.myTotal)}</td></tr>
          <tr><td className="pr-4">{oppName ?? "Opponent"}</td><td className="pr-4 tabular-nums">{advice.oppTotal.mean.toFixed(1)}</td><td className="tabular-nums text-ink-dim">{band(advice.oppTotal)}</td></tr>
        </tbody>
      </table>
      {oppIsTotal ? (
        <label className="block px-1 text-xs text-ink-dim">
          No opponent roster is loaded, so the opponent is modelled as a projected total with the same spread as your lineup — not a roster.
          Opponent projected total{" "}
          <input
            type="number" step="1" value={oppTotalText}
            onChange={(e) => setOppTotalText(e.target.value)}
            onBlur={commitOppTotal}
            onKeyDown={(e) => { if (e.key === "Enter") { commitOppTotal(); e.currentTarget.blur(); } }}
            className="ml-1 w-20 rounded bg-field px-1 py-0.5 text-sm tabular-nums"
          />
        </label>
      ) : (
        <p className="px-1 text-xs text-ink-faint">Both lineups are drawn from the same simulated week, so a shared game is correlated rather than assumed independent.</p>
      )}
    </section>
  );
}
