import type { NewsKind } from "../../lib/engine/newsImportance";

/** Kind → pill tone. Reds for season-changers, ambers for availability, blue for moves, teal for good news. */
export const KIND_TONE: Record<NewsKind, string> = {
  "season-ending": "bg-qb/25 text-qb",
  suspension: "bg-qb/25 text-qb",
  out: "bg-warn/25 text-warn",
  doubtful: "bg-warn/20 text-warn",
  questionable: "bg-warn/15 text-warn",
  transaction: "bg-wr/25 text-wr",
  depth: "bg-te/25 text-te",
  cleared: "bg-rb/25 text-rb",
  mention: "bg-panel-2 text-ink-dim",
};

export function ago(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
