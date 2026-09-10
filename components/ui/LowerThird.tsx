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
