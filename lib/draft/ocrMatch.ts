// Screen sync's brain: which board players a noisy OCR read of the draft
// room's "drafted" panel names. Pure — lines in, matches out — so it is
// unit-tested without a camera or a worker.
//
// This is closed-vocabulary matching, not free OCR: the answer must be one of
// a few hundred undrafted names, so a surname within one edit plus any
// first-name evidence (token, prefix, initial) is enough, and a surname that
// several undrafted players share needs position or team on the same line —
// or it is skipped. A missed read costs nothing (the next frame retries);
// marking the wrong player costs a correction on the clock.

import type { BoardPlayer, Position } from "../types";
import { mergeName } from "../etl/names";
import { extractPickNo, findDefense } from "./pasteImport";

export interface OcrLine {
  text: string;
  /** 0–100 from the OCR engine; low-confidence lines still get a chance. */
  confidence: number;
  /** Vertical position in the frame — the panel's order. */
  y: number;
}

export interface OcrMatch {
  player: BoardPlayer;
  line: string;
  /** 0–1: how sure the read is. */
  score: number;
  pickNo: number | null;
  y: number;
}

const POS_WORDS: Record<string, Position> = { qb: "QB", rb: "RB", wr: "WR", te: "TE", k: "K", pk: "K", dst: "DST", def: "DST" };
const TEAM_WORDS = new Set([
  "ari", "atl", "bal", "buf", "car", "chi", "cin", "cle", "dal", "den", "det", "gb", "hou", "ind", "jax", "jac", "kc",
  "lv", "lac", "lar", "mia", "min", "ne", "no", "nyg", "nyj", "phi", "pit", "sf", "sea", "tb", "ten", "was", "wsh",
]);
const TEAM_CANON: Record<string, string> = { jac: "JAX", wsh: "WAS" };

/** OCR confuses a few glyphs inside words; fix them only where letters dominate. */
function fixGlyphs(tok: string): string {
  const letters = (tok.match(/[a-z]/g) ?? []).length;
  if (letters < Math.max(2, tok.length - 2)) return tok;
  return tok.replace(/0/g, "o").replace(/1/g, "l").replace(/5/g, "s").replace(/8/g, "b").replace(/\|/g, "l");
}

export function normalizeOcr(text: string): string[] {
  return mergeName(text.toLowerCase().replace(/[^a-z0-9'’\-\s|]/gi, " "))
    .split(" ")
    .filter(Boolean)
    .map(fixGlyphs);
}

/** Bounded Levenshtein distance (stops early past `max`). */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

interface Vocab {
  player: BoardPlayer;
  first: string;
  last: string;
  /** every other name token (middle names, "st" in "st brown") */
  tokens: string[];
}

function vocabulary(players: BoardPlayer[], draftedIds: Set<string>): Vocab[] {
  const out: Vocab[] = [];
  for (const p of players) {
    if (draftedIds.has(p.id) || p.pos === "DST") continue;
    const tokens = mergeName(p.name).split(" ").filter(Boolean);
    if (tokens.length === 0) continue;
    out.push({ player: p, first: tokens[0], last: tokens[tokens.length - 1], tokens });
  }
  return out;
}

function lastNameTolerance(last: string): number {
  return last.length >= 8 ? 2 : last.length >= 5 ? 1 : 0;
}

/**
 * Score one OCR line against one player. 0 = no. Otherwise 0.5–1: surname
 * quality plus first-name evidence, minus ambiguity handled by the caller.
 */
function scoreLine(tokens: string[], v: Vocab): number {
  let lastScore = 0;
  let lastIdx = -1;
  const tol = lastNameTolerance(v.last);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 3 && v.last.length >= 3) continue;
    const d = editDistance(t, v.last, tol);
    if (d > tol) continue; // a bounded miss reports tol + 1
    const s = d === 0 ? 1 : d === 1 ? 0.8 : 0.6;
    if (s > lastScore) {
      lastScore = s;
      lastIdx = i;
    }
  }
  if (lastScore === 0) return 0;
  // First-name evidence: a token before the surname that equals / prefixes /
  // is within one edit of the first name, or is its initial.
  let firstScore = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (i === lastIdx) continue;
    const t = tokens[i];
    if (t === v.first) firstScore = Math.max(firstScore, 1);
    else if (t.length >= 3 && (v.first.startsWith(t) || t.startsWith(v.first))) firstScore = Math.max(firstScore, 0.85);
    else if (t.length === 1 && v.first.startsWith(t)) firstScore = Math.max(firstScore, 0.6);
    else if (t.length >= 4 && editDistance(t, v.first, 1) <= 1) firstScore = Math.max(firstScore, 0.75);
  }
  if (firstScore === 0) return 0.5 * lastScore; // surname only — caller decides if that's enough
  return 0.5 * lastScore + 0.5 * firstScore;
}

export interface OcrMatchOptions {
  teams: number;
  /** Minimum score to report a match. */
  minScore?: number;
}

/**
 * Match every OCR line to at most one undrafted player. Lines the panel
 * shows twice, headers, owner names and available-player noise fall out.
 */
export function matchOcrLines(
  lines: OcrLine[],
  players: BoardPlayer[],
  draftedIds: Set<string>,
  opts: OcrMatchOptions
): { matches: OcrMatch[]; maxPickNo: number | null } {
  const vocab = vocabulary(players, draftedIds);
  const minScore = opts.minScore ?? 0.7;
  // How many players (drafted or not) share a surname — a lone surname is
  // only trusted when it is unique on the whole board.
  const surnameCount = new Map<string, number>();
  for (const p of players) {
    const t = mergeName(p.name).split(" ");
    const last = t[t.length - 1];
    surnameCount.set(last, (surnameCount.get(last) ?? 0) + 1);
  }

  const best = new Map<string, OcrMatch>();
  let maxPickNo: number | null = null;

  for (const line of lines) {
    const raw = line.text.trim();
    if (!raw) continue;
    const pickNo = extractPickNo(raw, opts.teams);
    if (pickNo != null) maxPickNo = Math.max(maxPickNo ?? 0, pickNo);
    const tokens = normalizeOcr(raw);
    if (tokens.length === 0) continue;

    let pos: Position | null = null;
    let team: string | null = null;
    for (const t of tokens) {
      if (!pos && POS_WORDS[t] && t !== "k") pos = POS_WORDS[t];
      if (!team && TEAM_WORDS.has(t) && t.length >= 2) team = TEAM_CANON[t] ?? t.toUpperCase();
    }
    // A trailing lone "k" is the kicker position, not an initial.
    if (!pos && tokens[tokens.length - 1] === "k" && tokens.length >= 2) pos = "K";

    // Team defenses first — they have no first/last name.
    const dst = findDefense(raw, team, players);
    if (dst && !draftedIds.has(dst.id) && (pos === "DST" || /\b(d\/st|dst|def|defense)\b/i.test(raw) || !/[a-z]{3,}\s+[a-z]{3,}/i.test(raw.replace(/\b(d\/st|dst|def|defense|defence)\b/gi, "")))) {
      const existing = best.get(dst.id);
      if (!existing || existing.score < 0.9) best.set(dst.id, { player: dst, line: raw, score: 0.9, pickNo, y: line.y });
      continue;
    }

    const scored: { v: Vocab; s: number }[] = [];
    for (const v of vocab) {
      if (pos && v.player.pos !== pos) continue;
      if (team && v.player.team !== team) continue;
      const s = scoreLine(tokens, v);
      if (s > 0) scored.push({ v, s });
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => b.s - a.s || a.v.player.adp - b.v.player.adp);
    const top = scored[0];
    const runner = scored[1];
    let score = top.s;
    // Surname-only reads: fine when unique on the board (or pinned by pos/team).
    if (top.s <= 0.5) {
      const unique = (surnameCount.get(top.v.last) ?? 0) === 1;
      const pinned = (pos || team) && (!runner || runner.s < top.s);
      if (!unique && !pinned) continue;
      score = unique ? 0.72 : 0.7;
    }
    // Two candidates equally good ("B. Robinson" with two RB Robinsons): skip.
    if (runner && runner.s >= top.s - 0.05 && runner.v.last === top.v.last) continue;
    if (score < minScore) continue;
    const id = top.v.player.id;
    const existing = best.get(id);
    if (!existing || existing.score < score) best.set(id, { player: top.v.player, line: raw, score, pickNo, y: line.y });
  }

  const matches = [...best.values()].sort((a, b) =>
    a.pickNo != null && b.pickNo != null ? a.pickNo - b.pickNo : a.y - b.y
  );
  return { matches, maxPickNo };
}

/**
 * Frame-to-frame agreement: a player is confirmed once two consecutive reads
 * agree, and reported exactly once. Pure state machine, no timers.
 */
export class FrameAgreement {
  private seenLast = new Set<string>();
  private confirmed = new Set<string>();

  constructor(alreadyDrafted: Iterable<string> = []) {
    for (const id of alreadyDrafted) this.confirmed.add(id);
  }

  /** Feed one frame's matches; get back the ones that just became confirmed. */
  observe(matches: OcrMatch[]): OcrMatch[] {
    const now = new Set(matches.map((m) => m.player.id));
    const fresh: OcrMatch[] = [];
    for (const m of matches) {
      if (this.confirmed.has(m.player.id)) continue;
      if (this.seenLast.has(m.player.id)) {
        this.confirmed.add(m.player.id);
        fresh.push(m);
      }
    }
    this.seenLast = now;
    return fresh;
  }

  /** The user undid a mark — let the read confirm again if it persists. */
  forget(playerId: string): void {
    this.confirmed.delete(playerId);
    this.seenLast.delete(playerId);
  }

  markConfirmed(playerId: string): void {
    this.confirmed.add(playerId);
  }
}
