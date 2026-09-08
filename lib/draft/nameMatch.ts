// Find player names inside messy text. Shared by paste import and screen
// sync (OCR), so both get the same tolerance:
//
//   "Puka Nacua / LAR WR"           junk around the name
//   "R1, P2 - Team 7"               no name at all → nothing
//   "Chase, Ja'Marr"                last-first
//   "J. Gibbs" · "AJ Brown"         initials, with or without dots
//   "Marvin Harrison" ↔ "… Jr."     suffixes ignored on both sides
//   "Tetaíroa" · "Peña"             accents folded (í→i, ñ→n)
//   "Amon-Ra St. Brown"             hyphens and dots are separators
//   "Rob1nson" (OCR)                digit-for-letter glyphs repaired
//   "Bijan Robinson · Puka Nacua"   several names on one line → all of them
//
// Closed vocabulary: the answer must be one of the board's players, so the
// question is never "what does this say" but "which names appear". A surname
// within one edit plus any first-name evidence (token, prefix, initial) is a
// find; a lone surname counts only when it is unique on the board or pinned
// by a position/team token on the same line. Two players that fit the same
// tokens equally well are a tie — the caller decides whether a tie is skipped
// (automatic OCR) or offered as a best guess (paste preview).

import type { BoardPlayer, Position } from "../types";
import { mergeName } from "../etl/names";

export interface Vocab {
  player: BoardPlayer;
  first: string;
  last: string;
  tokens: string[];
}

export interface Hints {
  pos?: Position | null;
  team?: string | null;
}

export interface Found {
  player: BoardPlayer;
  /** 0–1; ≥ 0.85 with first-name evidence is an unambiguous read. */
  score: number;
  /** Token span the name occupies in the line. */
  start: number;
  end: number;
  surnameOnly: boolean;
  /** Set when another player fit the same tokens about as well. */
  tie: boolean;
  /** The other players in the tie (onTie "best" only), so a caller with more context can settle it. */
  alternatives?: BoardPlayer[];
}

export interface FindOptions {
  minScore?: number;
  /** "skip": drop ties (safe for automation). "best": keep the earlier-ADP player, flagged. */
  onTie?: "skip" | "best";
  /**
   * The text may cut names short with an ellipsis (a board cell: "D. Montgo…",
   * "J. Croskey-M…"): a 4+ letter prefix of the surname, or an exact middle
   * name-part, stands for the surname — with first-name evidence only.
   */
  truncated?: boolean;
}

const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv"]);
/** Words that sit next to names in draft panels but are never first names. */
const NOT_A_FIRST_NAME = new Set(["round", "rd", "pick", "pk", "team", "the", "by", "drafted", "selected", "queue", "bye", "adp", "pts", "proj", "rank", "flex", "bench", "keeper"]);

const POS_WORDS: Record<string, Position> = { qb: "QB", rb: "RB", wr: "WR", te: "TE", k: "K", pk: "K", dst: "DST", def: "DST" };
const TEAM_WORDS: Record<string, string> = {
  ari: "ARI", atl: "ATL", bal: "BAL", buf: "BUF", car: "CAR", chi: "CHI", cin: "CIN", cle: "CLE", dal: "DAL", den: "DEN",
  det: "DET", gb: "GB", gnb: "GB", hou: "HOU", ind: "IND", jax: "JAX", jac: "JAX", kc: "KC", kan: "KC", lv: "LV", lvr: "LV",
  lac: "LAC", lar: "LAR", mia: "MIA", min: "MIN", ne: "NE", nwe: "NE", no: "NO", nor: "NO", nyg: "NYG", nyj: "NYJ", phi: "PHI",
  pit: "PIT", sf: "SF", sfo: "SF", sea: "SEA", tb: "TB", tam: "TB", ten: "TEN", was: "WAS", wsh: "WAS",
};


/** OCR confuses a few glyphs inside words; repair them only where letters dominate. */
function fixGlyphs(tok: string): string {
  const letters = (tok.match(/[a-z]/g) ?? []).length;
  if (letters < Math.max(2, tok.length - 2)) return tok;
  return tok.replace(/0/g, "o").replace(/1/g, "l").replace(/5/g, "s").replace(/8/g, "b").replace(/\|/g, "l");
}

/**
 * Lowercase, fold accents, drop punctuation, split hyphens, keep initials
 * together ("A.J." → "aj"), drop suffixes. Digits survive as their own
 * tokens ("1.05" → "1", "05") — pick numbers are read from the raw text.
 */
export function tokenize(text: string, opts: { ocr?: boolean } = {}): string[] {
  const prepared = text
    // A.J. → AJ, D.J. → DJ — only between two single letters, so OCR's "C.Lamb" still splits into an initial and a surname.
    .replace(/(?<=(?<![A-Za-z])[A-Za-z])\.(?=[A-Za-z](?![A-Za-z]))/g, "")
    .replace(/[./|·•,;:()[\]{}"#*+=<>_~\\-]/g, " ")
    .replace(/[–—]/g, " ");
  const raw = mergeName(prepared)
    .split(" ")
    .filter((t) => t && !SUFFIX.has(t))
    .map((t) => (opts.ocr ? fixGlyphs(t) : t))
    .filter((t) => /[a-z0-9]/.test(t));
  // Spaced initials are one token: "A. J. Brown" → "aj brown", like "A.J. Brown".
  const out: string[] = [];
  for (const t of raw) {
    const prev = out[out.length - 1];
    if (prev && /^[a-z]$/.test(t) && /^[a-z]{1,2}$/.test(prev) && !TEAM_WORDS[prev] && !POS_WORDS[prev]) out[out.length - 1] = prev + t;
    else out.push(t);
  }
  return out;
}

/** Canonical team code for a token, if it is one ("jac" → "JAX"). */
export function teamCodeOf(token: string): string | null {
  return TEAM_WORDS[token] ?? null;
}

export function buildVocab(players: BoardPlayer[], exclude?: Set<string>): Vocab[] {
  const out: Vocab[] = [];
  for (const p of players) {
    if (exclude?.has(p.id) || p.pos === "DST") continue;
    const tokens = tokenize(p.name);
    if (tokens.length === 0) continue;
    out.push({ player: p, first: tokens[0], last: tokens[tokens.length - 1], tokens });
  }
  return out;
}

/** How many players on the WHOLE board (drafted or not) share each surname. */
export function surnameCounts(players: BoardPlayer[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of players) {
    if (p.pos === "DST") continue;
    const t = tokenize(p.name);
    const last = t[t.length - 1];
    if (last) counts.set(last, (counts.get(last) ?? 0) + 1);
  }
  return counts;
}

/** Bounded Levenshtein distance; returns max + 1 once the bound is exceeded. */
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

function surnameTolerance(last: string): number {
  return last.length >= 8 ? 2 : last.length >= 5 ? 1 : 0;
}

/** How strongly a token stands for a first name. */
function firstEvidence(tok: string, first: string): number {
  if (tok === first) return 1;
  if (tok.length >= 3 && (first.startsWith(tok) || tok.startsWith(first))) return 0.85;
  if (tok.length >= 4 && editDistance(tok, first, 1) <= 1) return 0.75;
  if (tok.length <= 2 && first.startsWith(tok)) return 0.6; // initial(s): "j", "aj"
  return 0;
}

interface Candidate extends Found {
  lastIdx: number;
}

/**
 * Every board player named in `tokens`, non-overlapping, best first.
 * `hints` are position/team tokens found on the same line: they tip
 * near-ties and let a lone surname through, never veto a full-name read.
 */
export function findPlayers(
  tokens: string[],
  vocab: Vocab[],
  counts: Map<string, number>,
  hints: Hints = {},
  opts: FindOptions = {}
): Found[] {
  const minScore = opts.minScore ?? 0.7;
  const onTie = opts.onTie ?? "skip";
  const cands: Candidate[] = [];

  for (const v of vocab) {
    const tol = surnameTolerance(v.last);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.length < 3 && v.last.length >= 3) continue;
      if (/^\d+$/.test(t)) continue;
      const d = editDistance(t, v.last, tol);
      let lastScore = d === 0 ? 1 : d === 1 ? 0.8 : 0.6;
      let cut = false;
      if (d > tol) {
        if (!opts.truncated) continue;
        // "Montgo" for Montgomery, "Croskey" for Croskey-Merritt.
        if (t.length >= 4 && v.last.length > t.length && v.last.startsWith(t)) lastScore = 0.75;
        else if (v.tokens.length > 2 && v.tokens.slice(1, -1).includes(t)) lastScore = 0.85;
        else continue;
        cut = true;
      }

      // First-name evidence: look back over as many tokens as the name has
      // ("amon ra st brown" needs three), then one or two tokens forward for
      // last-first order.
      let firstScore = 0;
      let start = i;
      let end = i;
      const back = Math.max(2, v.tokens.length);
      for (let k = 1; k <= back && i - k >= 0; k++) {
        const s = firstEvidence(tokens[i - k], v.first);
        if (s > firstScore) {
          firstScore = s;
          start = i - k;
        }
      }
      if (firstScore < 0.85) {
        for (let k = 1; k <= 2 && i + k < tokens.length; k++) {
          const s = firstEvidence(tokens[i + k], v.first);
          if (s > firstScore) {
            firstScore = s;
            start = i;
            end = i + k;
          }
        }
      }

      let score: number;
      let surnameOnly = false;
      if (firstScore === 0) {
        if (cut) continue; // a cut-off surname alone is too little
        surnameOnly = true;
        // A word right before the surname that is not this player's first name
        // means the line names a DIFFERENT person with that surname.
        const before = tokens[i - 1];
        const otherFirstName =
          before != null && /^[a-z]{3,}$/.test(before) && !TEAM_WORDS[before] && !POS_WORDS[before] && !NOT_A_FIRST_NAME.has(before);
        if (otherFirstName) continue;
        const unique = (counts.get(v.last) ?? 0) === 1;
        const pinned = (hints.pos && v.player.pos === hints.pos) || (hints.team && v.player.team === hints.team);
        if (!unique && !pinned) continue;
        score = 0.5 * lastScore + (unique ? 0.22 : 0.2);
      } else {
        score = 0.5 * lastScore + 0.5 * firstScore;
      }
      if (hints.pos) score += v.player.pos === hints.pos ? 0.08 : -0.15;
      if (hints.team) score += v.player.team === hints.team ? 0.08 : -0.15;
      if (score < minScore) continue;
      cands.push({ player: v.player, score, start, end, surnameOnly, tie: false, lastIdx: i });
    }
  }

  cands.sort((a, b) => b.score - a.score || a.player.adp - b.player.adp);
  const claimed = new Uint8Array(tokens.length);
  const out: Found[] = [];
  const seen = new Set<string>();
  const dropped = new Set<number>();
  for (let ci = 0; ci < cands.length; ci++) {
    if (dropped.has(ci)) continue;
    const c = cands[ci];
    if (seen.has(c.player.id)) continue;
    let overlaps = false;
    for (let k = c.start; k <= c.end; k++) if (claimed[k]) overlaps = true;
    if (overlaps) continue;
    // A different player reading the SAME surname token about as well: a tie.
    let tie = false;
    const alternatives: BoardPlayer[] = [];
    for (let cj = ci + 1; cj < cands.length; cj++) {
      const o = cands[cj];
      if (dropped.has(cj) || o.player.id === c.player.id || o.lastIdx !== c.lastIdx) continue;
      if (c.score - o.score > 0.05) break; // sorted: the rest are further away
      tie = true;
      alternatives.push(o.player);
      dropped.add(cj);
    }
    if (tie && onTie === "skip") continue;
    for (let k = c.start; k <= c.end; k++) claimed[k] = 1;
    seen.add(c.player.id);
    out.push({ player: c.player, score: c.score, start: c.start, end: c.end, surnameOnly: c.surnameOnly, tie, ...(tie ? { alternatives } : {}) });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Position and team tokens on a line. A lone "k" is the kicker position only
 * when it does not introduce a name ("K. Walker"); "no"/"ne"/"la" style team
 * codes must be upper-case in the raw text to count, since they are words.
 */
export interface LineHints {
  pos: Position | null;
  team: string | null;
  posIdx: number[];
  teamIdx: number[];
}

export function lineHints(tokens: string[], raw: string): LineHints {
  let pos: Position | null = null;
  let team: string | null = null;
  const posIdx: number[] = [];
  const teamIdx: number[] = [];
  const rawUpper = new Set((raw.match(/\b[A-Z]{2,3}\b/g) ?? []).map((t) => t.toLowerCase()));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (POS_WORDS[t] && t !== "k" && t !== "def") {
      if (!pos) pos = POS_WORDS[t];
      posIdx.push(i);
    } else if (t === "k" || t === "def") {
      const next = tokens[i + 1];
      const introducesName = t === "k" && next != null && /^[a-z]{2,}$/.test(next) && !TEAM_WORDS[next] && !POS_WORDS[next];
      if (!introducesName && i > 0) {
        if (!pos) pos = POS_WORDS[t];
        posIdx.push(i);
      }
    } else if (TEAM_WORDS[t] && (t.length === 3 || rawUpper.has(t)) && (i > 0 || rawUpper.has(t))) {
      // Two-letter codes are words ("no", "ne", "la") — only trust them in caps.
      // A code may lead the line only when written in caps ("DEN DEF").
      if (!team) team = TEAM_WORDS[t];
      teamIdx.push(i);
    }
  }
  return { pos, team, posIdx, teamIdx };
}
