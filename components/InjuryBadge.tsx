// Compact injury flag: Q / D / O / IR etc., amber, legible at a glance.

const SHORT: Record<string, string> = {
  Questionable: "Q",
  Doubtful: "D",
  Out: "O",
};

export default function InjuryBadge({ injury }: { injury: string | null | undefined }) {
  if (!injury) return null;
  return (
    <span
      className="rounded bg-warn/15 px-1 font-mono text-[9px] font-medium text-warn"
      title={injury}
    >
      {SHORT[injury] ?? injury}
    </span>
  );
}
