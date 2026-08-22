"use client";

// One brief celebratory burst when you draft your guy. CSS-only pieces in
// the pick's position color; hidden entirely under prefers-reduced-motion.
// Stateless: the animation runs to opacity 0 and stays there; a new burst
// key remounts the pieces and replays it.

interface Burst {
  key: number;
  color: string;
}

const PIECES = 14;

export default function Confetti({ burst }: { burst: Burst | null }) {
  if (!burst) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
      {Array.from({ length: PIECES }, (_, i) => {
        const angle = (i / PIECES) * Math.PI * 2;
        const dist = 70 + (i % 3) * 35;
        return (
          <span
            key={`${burst.key}-${i}`}
            className="confetti-piece left-1/2 top-1/2"
            style={{
              background: i % 3 === 0 ? "var(--color-ink)" : burst.color,
              ["--cx" as string]: `${Math.cos(angle) * dist}px`,
              ["--cy" as string]: `${Math.sin(angle) * dist - 30}px`,
              ["--cr" as string]: `${(i % 2 ? 1 : -1) * (180 + i * 20)}deg`,
            }}
          />
        );
      })}
    </div>
  );
}

export type { Burst };
