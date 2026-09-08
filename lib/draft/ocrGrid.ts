// Screen sync for a draft BOARD (DraftKings, Yahoo, most grid rooms): one cell
// per pick, one column per team, rounds snaking left-to-right then right-to-
// left. There is no chronological list to read top to bottom, so order is
// useless here — but every cell carries its own "round.pick" label, which the
// numbered-pick path (sequence.ts placeNumberedPicks) already trusts. So:
//
//   1. the labels ("6.12", "7.1") are the anchors — one per cell, top-left.
//      The gray OVERALL pick right under the label ("72") says the same thing
//      a second way, and OCR drops the tiny dot in small bold labels often
//      ("1.1" → "11"), so a dotless label is repaired from the overall;
//   2. a label's round and pick say exactly which COLUMN it must be in, so the
//      anchors calibrate the grid — column pitch, left edge, which row is
//      which round — and any anchor that lands in the wrong column (a "1.11"
//      read as 1.1, a speck read as "7.3") is thrown out. Once the grid is
//      calibrated every cell's round and pick follow from its position alone,
//      so a cell whose own label came back as "5M" still reads;
//   3. a cell's words ("72 Q. Johnston WR LAC (BYE 7)") go through the shared
//      name matcher, line by line so specks of the headshot never merge into
//      the initial, with the cell's position/team as hints — which is what
//      makes an initial + a common surname readable ("J. Williams · WR DET").
//      A tie that survives the hints ("B. Robinson · RB ATL" is Bijan or
//      Brian) is settled by the pick number: a candidate already placed at
//      another pick is out, and otherwise the one whose ADP is near this pick
//      wins when the other's is far.
//
// Pure — words with boxes in, numbered picks out — so it is unit-tested with a
// synthetic board and no camera; scripts/ocr-grid-check.ts runs it on real OCR
// of the mock board. Words above the first anchored row (a cut-off round) are
// dropped: without a label we do not know their pick number, and a guess costs
// a correction on the clock.

import type { BoardPlayer } from "../types";
import { findDefense } from "./pasteImport";
import { buildVocab, findPlayers, lineHints, surnameCounts, tokenize } from "./nameMatch";

export interface OcrWord {
  text: string;
  /** 0–100 from the OCR engine. */
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface GridPick {
  /** Overall pick number: (round − 1) × teams + pick. */
  pickNo: number;
  round: number;
  pick: number;
  player: BoardPlayer;
  /** 0–1: how sure the read is. */
  score: number;
  /** The cell's words, joined. */
  text: string;
}

export interface GridReadOptions {
  teams: number;
  /** Minimum name-match score to report a cell. */
  minScore?: number;
  /** Players already on the board, by pick number: a tie candidate sitting at ANOTHER pick is ruled out. */
  placed?: Map<string, number>;
}

export interface GridRead {
  /** Cell labels found and trusted. 0 means this is not a grid (fall back to list reading). */
  anchors: number;
  picks: GridPick[];
}

const LABEL_RE = /^(\d{1,2})[.,:](\d{1,2})$/;
const DIGITS_RE = /^\d{1,3}$/;

interface RoundPick {
  round: number;
  pick: number;
}

/** "6.12" → { round: 6, pick: 12 } when the pick fits the league; anything else → null. */
export function parseCellLabel(text: string, teams: number): RoundPick | null {
  const m = text.trim().match(LABEL_RE);
  if (!m) return null;
  const round = Number(m[1]);
  const pick = Number(m[2]);
  if (round < 1 || round > 40 || pick < 1 || pick > teams) return null;
  return { round, pick };
}

/** Overall pick "72" → { round: 6, pick: 12 } for a 12-team league. */
function fromOverall(text: string, teams: number): RoundPick | null {
  if (!DIGITS_RE.test(text)) return null;
  const overall = Number(text);
  if (overall < 1 || overall > 40 * teams) return null;
  const round = Math.ceil(overall / teams);
  return { round, pick: overall - (round - 1) * teams };
}

/** Screen column of a pick: odd rounds run left to right, even rounds right to left. */
function columnOf(rp: RoundPick, teams: number): number {
  return rp.round % 2 === 1 ? rp.pick - 1 : teams - rp.pick;
}

function pickAt(round: number, col: number, teams: number): number {
  return round % 2 === 1 ? col + 1 : teams - col;
}

interface Candidate extends RoundPick {
  word: OcrWord;
  /** The label has a dot but the overall under it says otherwise — trusted only if the grid geometry backs it. */
  conflict: boolean;
}

/**
 * The cell label a digit word carries, using the overall pick stacked under
 * it when there is one. Null when the word is not a label — including a
 * dotless number with nothing under it ("71" is neither 7.1 nor pick 71).
 */
function resolveLabel(word: OcrWord, below: OcrWord | null, teams: number): Candidate | null {
  const label = parseCellLabel(word.text, teams);
  const overall = below ? fromOverall(below.text, teams) : null;
  if (label) {
    const conflict = overall != null && (overall.round !== label.round || overall.pick !== label.pick);
    return { word, ...label, conflict };
  }
  if (!overall || !DIGITS_RE.test(word.text)) return null;
  // A dotless label must still read as round+pick run together.
  return word.text === `${overall.round}${overall.pick}` ? { word, ...overall, conflict: false } : null;
}

/** The digit word stacked directly under `w` (same left edge, next text line), if any. */
function numberBelow(w: OcrWord, digitWords: OcrWord[]): OcrWord | null {
  const h = Math.max(6, w.y1 - w.y0);
  let best: OcrWord | null = null;
  for (const b of digitWords) {
    if (b === w || !DIGITS_RE.test(b.text)) continue;
    if (Math.abs(b.x0 - w.x0) > h * 1.2) continue;
    const dy = b.y0 - w.y0;
    if (dy < h * 0.6 || dy > h * 2.6) continue;
    if (!best || dy < best.y0 - w.y0) best = b;
  }
  return best;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
}

interface Row<T extends { word: OcrWord }> {
  y: number;
  anchors: T[];
}

/** Group anchors into screen rows (same y, within a label's height and a half), each sorted by x. */
function rowsOf<T extends { word: OcrWord }>(anchors: T[]): Row<T>[] {
  const tol = Math.max(4, median(anchors.map((a) => a.word.y1 - a.word.y0)) * 1.5);
  const rows: Row<T>[] = [];
  for (const a of [...anchors].sort((p, q) => p.word.y0 - q.word.y0)) {
    const row = rows[rows.length - 1];
    if (row && a.word.y0 - row.y <= tol) row.anchors.push(a);
    else rows.push({ y: a.word.y0, anchors: [a] });
  }
  for (const r of rows) r.anchors.sort((p, q) => p.word.x0 - q.word.x0);
  return rows;
}

interface Geometry {
  /** Column pitch in pixels. */
  pitch: number;
  /** x of column 0's label (may be off-frame). */
  origin: number;
  /** Row height in pixels. */
  rowH: number;
  /** Anchored rows, top to bottom, with the round each one is. */
  rows: { y: number; round: number }[];
}

/**
 * Calibrate the grid from the anchors: each label's column is known from its
 * round and pick, so neighbouring labels in a row give the pitch directly
 * (median over pairs — a speck read as a label is outvoted), then the left
 * edge, then which anchors sit where they claim to. Null when fewer than
 * three anchors agree: too little to trust position over labels.
 */
function calibrate(cands: Candidate[], teams: number): { geometry: Geometry; anchors: Candidate[] } | null {
  const rows = rowsOf(cands);
  const pitches: number[] = [];
  for (const r of rows)
    for (let i = 1; i < r.anchors.length; i++) {
      const a = r.anchors[i - 1];
      const b = r.anchors[i];
      const dc = columnOf(b, teams) - columnOf(a, teams);
      if (dc > 0) pitches.push((b.word.x0 - a.word.x0) / dc);
    }
  if (pitches.length === 0) return null;
  const pitch = median(pitches);
  if (!(pitch > 0)) return null;
  const origins = cands.map((c) => c.word.x0 - columnOf(c, teams) * pitch);
  const origin = median(origins);
  const fits = (c: Candidate) => Math.abs(c.word.x0 - (origin + columnOf(c, teams) * pitch)) < pitch * 0.35;
  let anchors = cands.filter(fits);
  if (anchors.length < 3 || anchors.length * 2 < cands.length) return null;
  // Rows are consecutive rounds top to bottom, so every anchor votes for the
  // round of the FIRST row (its round minus its row index) and the rows take
  // the winning sequence. A row whose labels mostly misread ("1.2" → "11.2",
  // the column still fits) is outvoted by the rows around it.
  const rows2 = rowsOf(anchors);
  const yGaps: number[] = [];
  for (let i = 1; i < rows2.length; i++) yGaps.push(rows2[i].y - rows2[i - 1].y);
  // The smallest gap between rows is one round; a lone row has no measured
  // height, and a board cell is a bit shorter than it is wide.
  const rowH = yGaps.length ? Math.min(...yGaps) : pitch * 0.8;
  const indexOf = (y: number) => Math.round((y - rows2[0].y) / rowH);
  const votes = new Map<number, number>();
  for (const r of rows2) for (const a of r.anchors) votes.set(a.round - indexOf(r.y), (votes.get(a.round - indexOf(r.y)) ?? 0) + 1);
  const first = [...votes.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0][0];
  const rowsOut = rows2.map((r) => ({ y: r.y, round: first + indexOf(r.y) })).filter((r) => r.round >= 1);
  anchors = rows2.flatMap((r) => r.anchors.filter((a) => a.round === first + indexOf(r.y)));
  if (anchors.length < 3) return null;
  return { geometry: { pitch, origin: median(anchors.map((c) => c.word.x0 - columnOf(c, teams) * pitch)), rowH, rows: rowsOut }, anchors };
}

interface Cell extends RoundPick {
  words: OcrWord[];
}

/** Every word to its cell by position, on a calibrated grid. */
function cellsByPosition(words: OcrWord[], g: Geometry, teams: number): Cell[] {
  const cells = new Map<string, Cell>();
  for (const w of words) {
    let row: { y: number; round: number } | null = null;
    for (const r of g.rows) {
      if (r.y <= w.y0 + 2) row = r;
      else break;
    }
    if (!row || w.y0 - row.y >= g.rowH * 0.95) continue;
    const col = Math.floor((w.x0 - g.origin) / g.pitch + 0.08);
    if (col < 0 || col >= teams) continue;
    const pick = pickAt(row.round, col, teams);
    const key = `${row.round}:${pick}`;
    const cell = cells.get(key) ?? { round: row.round, pick, words: [] };
    cell.words.push(w);
    cells.set(key, cell);
  }
  return [...cells.values()];
}

/** Every word to the nearest anchor above-left of it — for grids too sparse to calibrate. */
function cellsByAnchor(words: OcrWord[], anchors: Candidate[], teams: number): Cell[] {
  const rows = rowsOf(anchors);
  const gaps: number[] = [];
  for (const r of rows)
    for (let i = 1; i < r.anchors.length; i++) {
      const dc = columnOf(r.anchors[i], teams) - columnOf(r.anchors[i - 1], teams);
      if (dc > 0) gaps.push((r.anchors[i].word.x0 - r.anchors[i - 1].word.x0) / dc);
    }
  const cellW = gaps.length ? median(gaps) : Infinity;
  const cells = new Map<Candidate, Cell>();
  for (const w of words) {
    let row: Row<Candidate> | null = null;
    for (const r of rows) {
      if (r.y <= w.y0 + 2) row = r;
      else break;
    }
    if (!row) continue;
    let anchor: Candidate | null = null;
    for (const a of row.anchors) {
      if (a.word.x0 <= w.x0 + 2) anchor = a;
      else break;
    }
    if (!anchor) continue;
    if (w.x0 - anchor.word.x0 >= cellW * 0.95) continue;
    if (w.y0 - anchor.word.y0 >= cellW * 0.8 * 0.95) continue;
    const cell = cells.get(anchor) ?? { round: anchor.round, pick: anchor.pick, words: [] };
    cell.words.push(w);
    cells.set(anchor, cell);
  }
  return [...cells.values()];
}

/** A cell's words in reading order, one string per text line. */
function cellLines(words: OcrWord[]): string[] {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lineTol = Math.max(3, median(sorted.map((w) => w.y1 - w.y0)) * 0.6);
  const lines: OcrWord[][] = [];
  for (const w of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(w.y0 - line[0].y0) <= lineTol) line.push(w);
    else lines.push([w]);
  }
  return lines.map((l) => l.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(" "));
}

/**
 * Among players who read the same, the one whose ADP sits near this pick —
 * but only when the runner-up's ADP is decisively farther (twice as far and
 * at least two rounds), otherwise nobody: a wrong mark costs a correction.
 */
function settleByPick(cands: BoardPlayer[], pickNo: number): BoardPlayer | null {
  const ranked = cands
    .filter((p) => Number.isFinite(p.adp))
    .map((p) => ({ p, d: Math.abs(p.adp - pickNo) }))
    .sort((x, y) => x.d - y.d);
  if (ranked.length === 0) return null;
  if (ranked.length === 1) return ranked.length === cands.length ? ranked[0].p : null;
  const [best, next] = ranked;
  return next.d >= best.d * 2 && next.d - best.d >= 24 ? best.p : null;
}

export function readGrid(words: OcrWord[], players: BoardPlayer[], opts: GridReadOptions): GridRead {
  const teams = Math.max(2, opts.teams);
  const minScore = opts.minScore ?? 0.7;

  const digitWords = words.filter((w) => LABEL_RE.test(w.text) || DIGITS_RE.test(w.text));
  const cands: Candidate[] = [];
  for (const w of digitWords) {
    const c = resolveLabel(w, numberBelow(w, digitWords), teams);
    if (c) cands.push(c);
  }
  if (cands.length === 0) return { anchors: 0, picks: [] };

  const calibrated = calibrate(cands, teams);
  // Uncalibrated, a label the overall contradicts is not trusted at all.
  const anchors = calibrated ? calibrated.anchors : cands.filter((c) => !c.conflict);
  if (anchors.length === 0) return { anchors: 0, picks: [] };
  const anchorWords = new Set(anchors.map((a) => a.word));
  const rest = words.filter((w) => !anchorWords.has(w));
  const cells = calibrated ? cellsByPosition(rest, calibrated.geometry, teams) : cellsByAnchor(rest, anchors, teams);

  const vocab = buildVocab(players);
  const counts = surnameCounts(players);
  const byPlayer = new Map<string, GridPick>();
  for (const cell of cells) {
    if (cell.words.length === 0) continue;
    const lines = cellLines(cell.words);
    const raw = lines.join(" ");
    // Line by line: a speck read as "I" above "J. Gibbs" must not become the initials "IJ".
    const tokens = lines.flatMap((l) => tokenize(l, { ocr: true }));
    if (tokens.length === 0) continue;
    const hints = lineHints(tokens, raw);
    const pickNo = (cell.round - 1) * teams + cell.pick;
    const found: { player: BoardPlayer; score: number }[] = [];
    // Cells cut long names short ("J. Croskey-M…"), so a surname prefix counts.
    for (const f of findPlayers(tokens, vocab, counts, { pos: hints.pos, team: hints.team }, { minScore, onTie: "best", truncated: true })) {
      if (!f.tie) {
        found.push({ player: f.player, score: f.score });
        continue;
      }
      const tied = [f.player, ...(f.alternatives ?? [])].filter((p) => {
        const at = opts.placed?.get(p.id);
        return at == null || at === pickNo;
      });
      const settled = tied.length === 1 ? tied[0] : settleByPick(tied, pickNo);
      if (settled) found.push({ player: settled, score: f.score });
    }
    found.sort((p, q) => q.score - p.score);
    if (found.length === 0) {
      const dst = findDefense(raw, hints.team, players);
      if (dst) found.push({ player: dst, score: 0.9 });
    }
    if (found.length === 0) continue;
    // One cell names one player; two that read about as well means the cell
    // caught a neighbour's words — skip rather than guess.
    if (found.length > 1 && found[0].score - found[1].score <= 0.05) continue;
    const { player, score } = found[0];
    const pick: GridPick = { pickNo, round: cell.round, pick: cell.pick, player, score, text: raw };
    const existing = byPlayer.get(player.id);
    if (!existing || existing.score < score) byPlayer.set(player.id, pick);
  }
  // Two players at one pick number: neither is trusted.
  const perPick = new Map<number, number>();
  for (const p of byPlayer.values()) perPick.set(p.pickNo, (perPick.get(p.pickNo) ?? 0) + 1);
  const picks = [...byPlayer.values()].filter((p) => perPick.get(p.pickNo) === 1).sort((p, q) => p.pickNo - q.pickNo);
  return { anchors: anchors.length, picks };
}
