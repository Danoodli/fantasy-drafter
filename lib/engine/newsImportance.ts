// Ranks live updates for the Newsroom: how much does this item matter to a
// drafter right now?
//
//   importance = severity(kind) × (0.4 + 0.6 · relevance(ADP)) × recency(age)
//
// so an ADP-50 season-ender (~0.92) outranks an ADP-1 nothing-burger (~0.10).
// Pure and deterministic: `now` is a parameter, no I/O. Kind detection reuses
// the hard-signal classifier and adds soft buckets it deliberately ignores.

import type { Board, Position } from "../types";
import { classifyNews } from "./newsSignal";
import { reconcileStatus, type FeedStatus } from "./injuryFeed";

export type NewsKind =
  | "season-ending"
  | "suspension"
  | "out"
  | "transaction"
  | "doubtful"
  | "cleared"
  | "questionable"
  | "depth"
  | "mention";

export const KIND_SEVERITY: Record<NewsKind, number> = {
  "season-ending": 1,
  suspension: 0.9,
  out: 0.7,
  transaction: 0.6,
  doubtful: 0.5,
  cleared: 0.4,
  questionable: 0.35,
  depth: 0.3,
  mention: 0.1,
};

export const KIND_LABEL: Record<NewsKind, string> = {
  "season-ending": "Season-ending",
  suspension: "Suspension",
  out: "Out",
  transaction: "Transaction",
  doubtful: "Doubtful",
  cleared: "Cleared",
  questionable: "Questionable",
  depth: "Depth chart",
  mention: "Mention",
};

const CLEARED = [
  /\bactivated\b/, /\breturn(s|ed|ing)?\b/, /\bcleared\b/, /\bwill play\b/, /\bexpected to play\b/,
  /\bback at practice\b/, /\bfull practice\b/, /\bfull participant\b/, /\bremoved from\b/, /\bupgraded\b/,
  /\bgood to go\b/, /\bno longer\b/, /\bpractic(ed|ing) (fully|in full)\b/, /\bavoids?\b/, /\bwon'?t miss\b/,
  /\bnot expected to miss\b/, /\bsuited up\b/, /\bon (the )?practice field\b/,
];
const QUESTIONABLE = [
  /\bquestionable\b/, /\blimited\b/, /\bdnp\b/, /\bdid not practice\b/, /\bnot practicing\b/, /\bmissed practice\b/,
  /\bsat out\b/, /\bday[- ]to[- ]day\b/, /\bgame[- ]time decision\b/, /\bheld out\b/, /\bsidelined\b/, /\bnursing\b/,
  /\bunlikely to play\b/, /\bin doubt\b/,
];
const TRANSACTION = [
  /\bsign(s|ed|ing)?\b/, /\btrade[sd]?\b/, /\breleas(e|ed|ing)\b/, /\bwaiv(e|ed|ing)\b/, /\bclaim(s|ed)?\b/,
  /\bextension\b/, /\bacquir(e|ed|ing)\b/, /\bcut\b/, /\bpractice squad\b/, /\belevated\b/, /\brestructur/,
  /\bfranchise tag\b/, /\bholdout\b/,
];
const DEPTH = [
  /\bstarter\b/, /\bstarting\b/, /\bwill start\b/, /\bnamed the\b/, /\bdepth chart\b/, /\bfirst[- ]team\b/,
  /\b(qb|rb|wr|te)1\b/, /\bworkload\b/, /\bsnap (count|share)\b/, /\btarget share\b/, /\bcaptains?\b/, /\bbackup\b/,
];

/** Bucket a headline (plus any note) into a severity kind. */
export function classifyKind(text: string): NewsKind {
  const t = text.toLowerCase();
  const hard = classifyNews(t);
  if (hard === "IR") return "season-ending";
  if (hard === "Sus") return "suspension";
  if (hard === "Out") return "out";
  if (hard === "Doubtful") return "doubtful";
  if (CLEARED.some((re) => re.test(t))) return "cleared";
  if (QUESTIONABLE.some((re) => re.test(t))) return "questionable";
  if (TRANSACTION.some((re) => re.test(t))) return "transaction";
  if (DEPTH.some((re) => re.test(t))) return "depth";
  return "mention";
}

/** 1.0 at the top of the board, 0.2 from ADP 300 on. */
export function relevanceOf(adp: number): number {
  return 1 - (0.8 * Math.min(Math.max(adp, 0), 300)) / 300;
}

/** Halves every `halfLifeHours`; future-dated items count as now. */
export function recencyOf(ageHours: number, halfLifeHours = 12): number {
  return Math.pow(0.5, Math.max(0, ageHours) / halfLifeHours);
}

export function importanceOf(kind: NewsKind, adp: number, ageHours: number): number {
  return KIND_SEVERITY[kind] * (0.4 + 0.6 * relevanceOf(adp)) * recencyOf(ageHours);
}

/** Short source name from a link: "@handle" for Bluesky, outlet names for the feeds we know. */
export function sourceLabel(href: string | null): string {
  if (!href) return "ESPN injury note";
  try {
    const u = new URL(href);
    const h = u.hostname.replace(/^www\./, "");
    if (h === "bsky.app") {
      const m = u.pathname.match(/^\/profile\/([^/]+)/);
      return m ? `@${m[1]}` : "Bluesky";
    }
    if (h.endsWith("espn.com")) return "ESPN";
    if (h.endsWith("cbssports.com")) return "CBS Sports";
    if (h.endsWith("rotowire.com")) return "RotoWire";
    if (h.endsWith("yahoo.com")) return "Yahoo Sports";
    if (h.includes("profootballtalk")) return "PFT";
    return h;
  } catch {
    return "link";
  }
}

function kindForStatus(to: string | null): NewsKind {
  switch (to) {
    case null: return "cleared";
    case "Out": return "out";
    case "Doubtful": return "doubtful";
    case "Questionable": return "questionable";
    case "IR": case "PUP": return "season-ending";
    case "Sus": return "suspension";
    default: return "mention";
  }
}

export interface FeedItem {
  /** Stable across polls for the same underlying update. */
  id: string;
  playerId: string;
  name: string;
  pos: Position;
  team: string;
  adp: number;
  headline: string;
  href: string | null;
  published: string;
  source: string;
  kind: NewsKind;
  severity: number;
  importance: number;
  statusChange?: { from: string | null; to: string | null };
}

/**
 * One item per player headline, plus one per status the live table changed
 * versus the baked board. Pass the RAW board (not the graded one) so the
 * status diff is visible. Sorted by importance, then recency.
 */
export function buildFeed(
  board: Board,
  news: ReadonlyMap<string, { headline: string; published: string; href: string | null }>,
  liveStatus: ReadonlyMap<string, { status: FeedStatus; date: string; note: string | null }>,
  now: number
): FeedItem[] {
  const out: FeedItem[] = [];
  const ageHours = (published: string) => (now - Date.parse(published)) / 3_600_000;
  for (const p of board.players) {
    const item = news.get(p.id);
    if (item && Number.isFinite(Date.parse(item.published))) {
      const kind = classifyKind(item.headline);
      out.push({
        id: `${p.id}:news:${item.published}`,
        playerId: p.id, name: p.name, pos: p.pos, team: p.team, adp: p.adp,
        headline: item.headline, href: item.href, published: item.published,
        source: sourceLabel(item.href), kind, severity: KIND_SEVERITY[kind],
        importance: importanceOf(kind, p.adp, ageHours(item.published)),
      });
    }
    const row = liveStatus.get(p.id);
    if (row && Number.isFinite(Date.parse(row.date))) {
      const to = reconcileStatus(p.injury, row.status);
      if (to !== p.injury) {
        const kind = kindForStatus(to);
        out.push({
          id: `${p.id}:status:${row.date}:${to ?? "healthy"}`,
          playerId: p.id, name: p.name, pos: p.pos, team: p.team, adp: p.adp,
          headline: `Status: ${p.injury ?? "healthy"} → ${to ?? "healthy"}${row.note ? ` — ${row.note}` : ""}`,
          href: null, published: row.date, source: "ESPN injuries", kind, severity: KIND_SEVERITY[kind],
          importance: importanceOf(kind, p.adp, ageHours(row.date)),
          statusChange: { from: p.injury, to },
        });
      }
    }
  }
  out.sort((x, y) => y.importance - x.importance || Date.parse(y.published) - Date.parse(x.published));
  return out;
}
