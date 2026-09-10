// A pasted roster page -> board players with slots. Pure: text and players
// in, entries out, so the parsing is unit-tested and the component only
// renders a preview. Name matching is lib/draft/nameMatch.ts, shared with the
// draft's paste import and screen sync, so tolerance is identical everywhere.
//
// Formats seen in the wild (all handled):
//   QB  Josh Allen  Buf  vs MIA  24.1        ESPN / Yahoo, slot label first
//   QB J. Allen BUF vs MIA                   Sleeper, initial + surname
//   Starters / Bench / Injured Reserve       section headers, names beneath
//   Seahawks D/ST · SEA DEF                  team defenses
import type { BoardPlayer } from "../types";
import type { RosterEntry } from "../client/teams";
import { buildVocab, findPlayers, lineHints, surnameCounts, teamCodeOf, tokenize, type Vocab } from "../draft/nameMatch";
import { findDefense } from "../draft/pasteImport";
import { scorePlayers } from "../draft/fuzzy";

export type RosterSlot = RosterEntry["slot"];

/** Leading labels that mean "this line is a starter": positions, flex spellings ("W/R/T" -> "wrt"), DST spellings. */
const STARTER_WORDS = new Set(["qb", "rb", "wr", "te", "k", "pk", "dst", "def", "d", "flex", "wrt", "wrtq", "rbwr", "rbwrte", "wrte", "superflex", "sflex", "sf", "op"]);
const BENCH_WORDS = new Set(["bn", "be", "bench", "reserves", "reserve"]);
const IR_WORDS = new Set(["ir"]);
/** Words that sit on roster pages but are never part of a name. */
const NOISE = new Set(["my", "team", "week", "wk", "total", "totals", "projected", "proj", "pts", "points", "opp", "opponent", "status", "owner", "manager", "vs", "at", "bye", "score", "rank", "roster", "lineup", "starters", "bench", "reserve", "reserves", "the", "and"]);

/**
 * A slot label at the start of the RAW line, and the line without it.
 * Raw rather than tokenized on purpose: tokenize()'s spaced-initials rule
 * turns "BN D. London" into ["bnd", "london"], so the label must come off
 * before the tokenizer sees the line. A single letter followed by a period
 * ("K. Walker") is an initial, not the kicker slot.
 */
export function leadingSlot(line: string): { slot: RosterSlot | null; rest: string } {
  // An optional trailing digit accepts numbered labels ("RB1", "WR2").
  const m = line.match(/^\s*([A-Za-z]+(?:\/[A-Za-z]+)*)\d?(\.?)(?=\s|$)\s*/);
  if (!m) return { slot: null, rest: line };
  const word = m[1].replace(/\//g, "").toLowerCase();
  if (m[2] === "." && m[1].length === 1) return { slot: null, rest: line };
  let slot: RosterSlot | null = null;
  if (IR_WORDS.has(word)) slot = "ir";
  else if (BENCH_WORDS.has(word)) slot = "bench";
  else if (STARTER_WORDS.has(word)) slot = "starter";
  if (!slot) return { slot: null, rest: line };
  return { slot, rest: line.slice(m[0].length) };
}

/** A line that is ONLY a section header, e.g. "Bench", "Bench (5)", "Injured Reserve", "Starters". */
export function headerSlot(tokens: string[]): RosterSlot | null {
  const words = tokens.filter((t) => !/^\d+$/.test(t));
  if (words.length === 0 || words.length > 2) return null;
  const joined = words.join(" ");
  if (joined === "bench" || joined === "reserves") return "bench";
  if (joined === "ir" || joined === "injured reserve") return "ir";
  if (joined === "starters" || joined === "starter" || joined === "lineup" || joined === "starting lineup") return "starter";
  return null;
}

export interface RosterPasteEntry {
  raw: string;
  player: BoardPlayer | null;
  slot: RosterSlot;
  /** "high": unambiguous. "low": best guess or unmatched — the preview shows alternatives. */
  confidence: "high" | "low";
  suggestions: BoardPlayer[];
}

export interface RosterPasteResult {
  entries: RosterPasteEntry[];
  /** Lines that named nobody (totals, headers, owner tags). */
  ignored: string[];
  /** True when the paste said anything about slots; false means every entry defaulted to bench. */
  hasSlots: boolean;
}

/** Name-like words on a line: letters, not a slot/team/position code, not page noise, not a number. */
function nameWords(tokens: string[]): string[] {
  return tokens.filter(
    (t) => t.length >= 3 && /[a-z]/.test(t) && !STARTER_WORDS.has(t) && !BENCH_WORDS.has(t) && !NOISE.has(t) && teamCodeOf(t) === null
  );
}

export function parseRosterPaste(text: string, players: BoardPlayer[]): RosterPasteResult {
  const vocab: Vocab[] = buildVocab(players);
  const counts = surnameCounts(players);
  const lines = text.replace(/\r/g, "").replace(/\t/g, "  ").split("\n").map((l) => l.trim()).filter(Boolean);

  const anyHeader = lines.some((l) => headerSlot(tokenize(l)) !== null);
  const anyLabel = lines.some((l) => {
    const { slot, rest } = leadingSlot(l);
    return slot !== null && nameWords(tokenize(rest)).length > 0;
  });
  const hasSlots = anyHeader || anyLabel;
  // With headers, everything above the first bench/IR header is a starter.
  let mode: RosterSlot = hasSlots ? "starter" : "bench";

  const entries: RosterPasteEntry[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const header = headerSlot(tokenize(raw));
    if (header) {
      mode = header;
      continue;
    }
    const lead = leadingSlot(raw);
    const slot = lead.slot ?? mode;
    const body = lead.rest;
    const tokens = tokenize(body);
    const hints = lineHints(tokens, body);
    const found = findPlayers(tokens, vocab, counts, { pos: hints.pos, team: hints.team }, { onTie: "best" });
    const dst = found.length === 0 ? findDefense(body, hints.team, players) : null;

    if (dst) {
      if (!seen.has(dst.id)) {
        seen.add(dst.id);
        entries.push({ raw, player: dst, slot, confidence: "high", suggestions: [] });
      }
      continue;
    }
    if (found.length === 0) {
      const words = nameWords(tokens);
      if (words.length >= 2) {
        entries.push({ raw, player: null, slot, confidence: "low", suggestions: scorePlayers(words.join(" "), players).slice(0, 4).map((s) => s.player) });
      } else {
        ignored.push(raw);
      }
      continue;
    }
    for (const f of found) {
      if (seen.has(f.player.id)) continue;
      seen.add(f.player.id);
      const high = !f.surnameOnly && !f.tie && f.score >= 0.85;
      entries.push({
        raw,
        player: f.player,
        slot,
        confidence: high ? "high" : "low",
        suggestions: high ? [] : [f.player, ...(f.alternatives ?? [])].slice(0, 4),
      });
    }
  }
  return { entries, ignored, hasSlots };
}
