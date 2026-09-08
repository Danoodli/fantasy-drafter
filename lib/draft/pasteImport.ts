// Paste import: turn a copied "drafted players" panel from ANY draft site into
// board picks. Pure — text and players in, ordered matches out — so the fiddly
// parsing is unit-tested and the cockpit only has to render a preview.
//
// Formats seen in the wild (all handled):
//   1.01 Ja'Marr Chase WR - CIN          Sleeper-style round.pick
//   1 (1) Ja'Marr Chase, CIN WR          ESPN draft recap
//   Puka Nacua / LAR WR ⏎ R1, P2 - Team 7   ESPN live draft, label under the name
//   1. (1) Ja'Marr Chase (Cin - WR)      Yahoo draft results
//   #17  Bijan Robinson  RB  ATL         numbered lists, tabs or spaces
//   Chase, Ja'Marr                       last-first
//   1.01 ⏎ Ja'Marr Chase ⏎ CIN WR        pick / name / meta on separate lines
//   Seahawks D/ST · Baltimore Defense    team defenses by nickname or city
//   Bijan Robinson · Puka Nacua          several names on one line
// Names are found INSIDE lines (see nameMatch.ts): junk around them, accents,
// suffixes and initials don't matter. Owner names, "Round 3" headers, bye
// weeks and points fall away.

import type { BoardPlayer, Position } from "../types";
import { scorePlayers } from "./fuzzy";
import { mergeName } from "../etl/names";
import { buildVocab, findPlayers, lineHints, surnameCounts, teamCodeOf, tokenize, type Vocab } from "./nameMatch";
import { inferPasteLayout, type LayoutInference, type PasteShape, type RoomState } from "./pasteLayout";

export interface ParsedLine {
  raw: string;
  /** Overall pick number when the line carried one (or a round.pick pair). */
  pickNo: number | null;
  /** The residual text most likely to be the player's name. */
  nameText: string;
  pos: Position | null;
  team: string | null;
}

export interface PasteMatch {
  line: ParsedLine;
  player: BoardPlayer | null;
  /** "high": unambiguous. "low": best guess — the preview shows alternatives. */
  confidence: "high" | "low";
  suggestions: BoardPlayer[];
  alreadyDrafted: boolean;
}

export interface PasteResult {
  /** In the order picks should be marked: ascending pick number when known, else pasted order. */
  matches: PasteMatch[];
  hasPickNumbers: boolean;
  /** Lines that carried no name at all (headers, blank separators, owner tags). */
  ignored: string[];
  /** For a paste without pick numbers: how the rows were laid onto the board from what the room already knows. */
  layout?: LayoutInference;
}

/** Nickname / city → team code, for team defenses ("Seahawks D/ST", "Baltimore Defense"). */
const DST_NAMES: Record<string, string> = {
  cardinals: "ARI", arizona: "ARI", falcons: "ATL", atlanta: "ATL", ravens: "BAL", baltimore: "BAL",
  bills: "BUF", buffalo: "BUF", panthers: "CAR", carolina: "CAR", bears: "CHI", chicago: "CHI",
  bengals: "CIN", cincinnati: "CIN", browns: "CLE", cleveland: "CLE", cowboys: "DAL", dallas: "DAL",
  broncos: "DEN", denver: "DEN", lions: "DET", detroit: "DET", packers: "GB", "green bay": "GB",
  texans: "HOU", houston: "HOU", colts: "IND", indianapolis: "IND", jaguars: "JAX", jacksonville: "JAX",
  chiefs: "KC", "kansas city": "KC", raiders: "LV", "las vegas": "LV", chargers: "LAC", "la chargers": "LAC",
  "los angeles chargers": "LAC", rams: "LAR", "la rams": "LAR", "los angeles rams": "LAR", dolphins: "MIA",
  miami: "MIA", vikings: "MIN", minnesota: "MIN", patriots: "NE", "new england": "NE", saints: "NO",
  "new orleans": "NO", giants: "NYG", "ny giants": "NYG", "new york giants": "NYG", jets: "NYJ", "ny jets": "NYJ",
  "new york jets": "NYJ", eagles: "PHI", philadelphia: "PHI", steelers: "PIT", pittsburgh: "PIT", "49ers": "SF",
  niners: "SF", "san francisco": "SF", seahawks: "SEA", seattle: "SEA", buccaneers: "TB", bucs: "TB",
  "tampa bay": "TB", titans: "TEN", tennessee: "TEN", commanders: "WAS", washington: "WAS",
};

const TEAM_CODES = new Set([
  "ari", "atl", "bal", "buf", "car", "chi", "cin", "cle", "dal", "den", "det", "gb", "gnb", "hou", "ind", "jax", "jac",
  "kc", "kan", "lv", "lvr", "lac", "lar", "mia", "min", "ne", "nwe", "no", "nor", "nyg", "nyj", "phi", "pit", "sf", "sfo",
  "sea", "tb", "tam", "ten", "was", "wsh",
]);
const POS_CODES = new Set(["qb", "rb", "wr", "te", "k", "pk", "dst", "def", "d", "st", "flex", "bn", "ir"]);
/** Words that never belong to a player name. */
const NOISE = new Set([
  "round", "rd", "pick", "pk", "overall", "team", "drafted", "by", "selected", "selects", "bye", "pts",
  "points", "proj", "adp", "rank", "bench", "owner", "manager", "keeper", "auto", "autopick", "autodraft",
  "the", "queue", "queued", "you", "your", "me", "and", "of", "at", "vs", "week", "wk",
]);

/**
 * "1.05", "R1P5", "1-05", "Round 1, Pick 5", "Rd 1 Pk 5", "R1, P5" → overall
 * pick (needs teams). A board grid writes picks 1–9 without the zero ("7.1");
 * that form counts only when it leads the line, so "6.5 pts" mid-line is not
 * a pick.
 */
function roundPick(text: string, teams: number): number | null {
  const patterns: RegExp[] = [
    /(?:^|\s)(\d{1,2})[.\-:](\d{2})(?=\s|$|[),:])/,
    /^\s*(\d{1,2})[.\-:](\d{1,2})(?=\s|$|[),:])/,
    /\bR(?:ound|d)?\.?\s*(\d{1,2})\s*[,\-–—]?\s*P(?:ick|k)?\.?\s*(\d{1,2})\b/i,
    /\bR(\d{1,2})P(\d{1,2})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const round = Number(m[1]);
    const pick = Number(m[2]);
    if (round < 1 || round > 40 || pick < 1 || pick > Math.max(teams, 20)) continue;
    return (round - 1) * teams + pick;
  }
  return null;
}

/** A board row copied as ONE line ("7.1 73 T. Kraft TE GB  7.2 74 …"): split it at every cell label. */
function splitCells(line: string): string[] {
  const re = /(?:^|\s)(\d{1,2})\.(\d{1,2})(?=\s|$)/g;
  const starts: number[] = [];
  for (let m = re.exec(line); m; m = re.exec(line)) starts.push(m.index + (m[0].length - m[1].length - 1 - m[2].length));
  if (starts.length < 2) return [line];
  const out: string[] = [];
  if (starts[0] > 0 && line.slice(0, starts[0]).trim()) out.push(line.slice(0, starts[0]));
  for (let i = 0; i < starts.length; i++) out.push(line.slice(starts[i], starts[i + 1] ?? line.length));
  return out;
}

/** A leading bare number: "17", "#17", "17.", "17)", "17 (5)". */
function leadingNumber(text: string): number | null {
  const m = text.match(/^\s*#?(\d{1,3})(?:\s*\(\d{1,2}\))?[.):]?(?=\s|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 400 ? n : null;
}

/** A pick number carried by a line, if any — shared with the OCR matcher. */
export function extractPickNo(text: string, teams: number): number | null {
  return roundPick(text, Math.max(2, teams)) ?? leadingNumber(text);
}

/** The team defense a line names, by nickname / city / code — shared with the OCR matcher. */
export function findDefense(text: string, team: string | null, players: BoardPlayer[]): BoardPlayer | null {
  const lower = mergeName(text.replace(/[/.]/g, " "));
  const mentionsDefense = /\b(d st|dst|def|defense|defence)\b/.test(lower);
  const nick = Object.entries(DST_NAMES).find(([n]) => new RegExp(`(^|\\s)${n}(\\s|$)`).test(lower))?.[1] ?? null;
  // "HOU DST" / "DEN DEF": the code may be the only clue, wherever it sits.
  const codeInLine = mentionsDefense
    ? (lower.split(" ").map((t) => teamCodeOf(t)).find((c): c is string => c != null && (c.length === 3 || text.includes(c))) ?? null)
    : null;
  const code = nick ?? (mentionsDefense ? team ?? codeInLine : null);
  if (!code) return null;
  return players.find((p) => p.pos === "DST" && p.team === code) ?? null;
}

/** Does this line contain anything that could be a name? */
function nameWords(line: string): string[] {
  return tokenize(line).filter((t) => t.length >= 2 && /[a-z]/.test(t) && !TEAM_CODES.has(t) && !POS_CODES.has(t) && !NOISE.has(t));
}

/** A line that is only a pick label ("1.01", "R1, P2", "#17") or a label plus owner tag ("R1, P2 - Team 7"). */
function labelKind(line: string, teams: number): "bare" | "trailing" | null {
  if (extractPickNo(line, teams) == null && !/^\s*#?\d{1,3}[.):]?\s*$/.test(line)) return null;
  const words = nameWords(line);
  return words.length === 0 ? "bare" : "trailing";
}

/** "HOU DST" / "DEN DEF": a team defense named by code alone. */
function defenseByCode(line: string): boolean {
  const tokens = tokenize(line);
  return tokens.some((t) => teamCodeOf(t) != null) && tokens.some((t) => t === "dst" || t === "def" || t === "defense" || t === "defence");
}

/**
 * Attach meta-only lines to their name line. Pos/team-only lines ("CIN WR")
 * describe the name above. Pick labels lead the next name (Sleeper "1.01" on
 * its own line) unless the paste starts with a name, in which case they trail
 * it (ESPN: "Puka Nacua / LAR WR" then "R1, P2 - Team 7"). A label carrying an
 * owner tag ("R1, P2 - Team 7") always trails. A line that names a player is
 * a name line no matter what else is on it.
 */
function coalesceLines(
  rawLines: string[],
  teams: number,
  namesPlayer: (line: string) => boolean
): { lines: string[]; ignored: string[] } {
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  const ignored: string[] = [];
  const first = lines[0];
  const labelsFirst = first != null && nameWords(first).length === 0 && extractPickNo(first, teams) != null;
  let pendingPrefix = "";
  for (const line of lines) {
    if (/^(round|rd)\.?\s*\d{1,2}\b[\s·:\-–—]*$/i.test(line)) {
      ignored.push(line);
      continue;
    }
    const isName = defenseByCode(line) || (nameWords(line).length > 0 && namesPlayer(line));
    if (isName) {
      out.push(pendingPrefix ? `${pendingPrefix} ${line}` : line);
      pendingPrefix = "";
      continue;
    }
    // Meta: a pick label (bare or with an owner tag), pos/team codes, or an
    // unrecognized owner/header line.
    const label = labelKind(line, teams);
    const words = nameWords(line);
    if (label === "bare" && labelsFirst) {
      pendingPrefix = `${pendingPrefix} ${line}`.trim();
    } else if (label != null && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${line}`;
    } else if (label != null) {
      pendingPrefix = `${pendingPrefix} ${line}`.trim();
    } else if (words.length === 0 && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${line}`; // "CIN WR" under a name
    } else if (words.length >= 2 || (words.length === 1 && words[0].length >= 4)) {
      out.push(pendingPrefix ? `${pendingPrefix} ${line}` : line); // maybe a name we can't match — keep for did-you-mean
      pendingPrefix = "";
    } else {
      ignored.push(line);
    }
  }
  return { lines: out, ignored };
}

export interface PasteOptions {
  teams: number;
  /**
   * What the room already knows (picks recorded, who sits where, draft order).
   * A paste without pick numbers is laid onto the board from it: a board copy
   * in screen order snakes correctly, a list stays a list, and names already
   * on the board pin the reading (lib/draft/pasteLayout.ts). Ignored when the
   * paste carries pick numbers of its own.
   */
  room?: Omit<RoomState, "teams"> & { prefer?: PasteShape };
}

/** Board cells copy with their "(BYE 7)" tag; a paste full of them is a board, not a list. */
export function looksLikeBoard(text: string, names: number): boolean {
  const tags = (text.match(/\(BYE\s*\d+\)/gi) ?? []).length;
  return tags >= Math.max(2, Math.ceil(names * 0.5));
}

export function parsePastedPicks(
  text: string,
  players: BoardPlayer[],
  draftedIds: Set<string>,
  opts: PasteOptions
): PasteResult {
  const teams = Math.max(2, opts.teams);
  const vocab: Vocab[] = buildVocab(players);
  const counts = surnameCounts(players);
  const namesPlayer = (line: string) => {
    const tokens = tokenize(line);
    const h = lineHints(tokens, line);
    return (
      findPlayers(tokens, vocab, counts, { pos: h.pos, team: h.team }, { onTie: "best" }).length > 0 ||
      findDefense(line, h.team, players) != null
    );
  };
  const rawLines = text.replace(/\r/g, "").replace(/\t/g, "  ").split("\n").flatMap(splitCells);
  const { lines, ignored } = coalesceLines(rawLines, teams, namesPlayer);

  const matches: PasteMatch[] = [];
  const bareNumbers: (number | null)[] = [];
  const seen = new Set<string>();
  const gridCopy = looksLikeBoard(text, 0);

  for (const raw of lines) {
    const rp = roundPick(raw, teams);
    const bare = rp == null ? leadingNumber(raw) : null;
    const tokens = tokenize(raw);
    const hints = lineHints(tokens, raw);
    const found = findPlayers(tokens, vocab, counts, { pos: hints.pos, team: hints.team }, { onTie: "best" });
    const dst = found.length === 0 ? findDefense(raw, hints.team, players) : null;

    const base: ParsedLine = { raw, pickNo: rp, nameText: raw, pos: hints.pos, team: hints.team };
    if (dst) {
      if (!seen.has(dst.id)) {
        seen.add(dst.id);
        matches.push({ line: base, player: dst, confidence: "high", suggestions: [], alreadyDrafted: draftedIds.has(dst.id) });
        bareNumbers.push(bare);
      }
      continue;
    }
    if (found.length === 0) {
      // Name-like words but no player: offer did-you-mean from the fuzzy search.
      const words = nameWords(raw);
      if (words.length >= 2 || (words.length === 1 && words[0].length >= 4 && tokens.length <= 3)) {
        const suggestions = scorePlayers(words.join(" "), players).slice(0, 4).map((s) => s.player);
        matches.push({ line: { ...base, nameText: words.join(" ") }, player: null, confidence: "low", suggestions, alreadyDrafted: false });
        bareNumbers.push(bare);
      } else ignored.push(raw);
      continue;
    }
    let pushed = false;
    for (const f of found) {
      let player = f.player;
      if (seen.has(player.id)) {
        // A tie whose best guess is already in the paste ("A. Brown" after
        // "A. St. Brown"): it must be the other one.
        const alt = f.alternatives?.find((a) => !seen.has(a.id));
        if (!alt) continue;
        player = alt;
      } else if (f.tie && draftedIds.has(player.id)) {
        // A tie whose best guess is already gone from the room: a paste is
        // mostly new picks, so it is the candidate still on the board.
        const alt = f.alternatives?.find((a) => !seen.has(a.id) && !draftedIds.has(a.id));
        if (alt) player = alt;
      }
      seen.add(player.id);
      pushed = true;
      const nameText = tokens.slice(f.start, f.end + 1).join(" ");
      const high = !f.surnameOnly && !f.tie && f.score >= 0.85;
      // Alternatives for the preview: same surname first, then the fuzzy neighbours.
      const suggestions = high
        ? []
        : [...new Map(
            [...scorePlayers(nameText, players), ...scorePlayers(player.name.split(" ").slice(-1)[0], players)]
              .map((s) => [s.player.id, s.player] as const)
          ).values()].slice(0, 4);
      matches.push({
        // A line with several names can't say which one its pick number belongs to.
        line: { ...base, pickNo: found.length === 1 ? rp : null, nameText },
        player,
        confidence: high ? "high" : "low",
        suggestions,
        alreadyDrafted: draftedIds.has(player.id),
      });
      bareNumbers.push(found.length === 1 ? bare : null);
    }
    if (!pushed && gridCopy) {
      // On a board every screen cell counts: a duplicate line keeps its cell
      // (unresolved, with the players it read as) so later cells stay numbered right.
      const nameText = tokens.slice(found[0].start, found[0].end + 1).join(" ");
      matches.push({ line: { ...base, nameText }, player: null, confidence: "low", suggestions: found.map((f) => f.player).slice(0, 4), alreadyDrafted: false });
      bareNumbers.push(bare);
    }
  }

  // Leading bare numbers are pick numbers only when they form a clean sequence
  // (a ranking or row count would too — but then marking in that order is right anyway).
  const bares = bareNumbers.filter((n): n is number => n != null);
  if (bares.length === matches.length && bares.length >= 2) {
    const distinct = new Set(bares).size === bares.length;
    const asc = bares.every((n, i) => i === 0 || n > bares[i - 1]);
    const desc = bares.every((n, i) => i === 0 || n < bares[i - 1]);
    if (distinct && (asc || desc)) matches.forEach((m, i) => (m.line.pickNo = m.line.pickNo ?? bares[i]));
  }

  let hasPickNumbers = matches.some((m) => m.line.pickNo != null);
  let layout: LayoutInference | undefined;
  if (!hasPickNumbers && opts.room && matches.length > 0) {
    // No numbers on the paste: lay the rows onto the board from what the room
    // knows. A board copy (cells with BYE tags) is read in screen order unless
    // the names already on the board say otherwise.
    // Cell tags are structural evidence of a board; without them ADP tells a board from a list.
    const prefer = opts.room.prefer ?? (looksLikeBoard(text, matches.length) ? "grid" : null);
    const adpById = new Map(players.map((p) => [p.id, p.adp]));
    const inferred = inferPasteLayout(matches.map((m) => m.player?.id ?? null), { ...opts.room, teams }, prefer, (id) => adpById.get(id));
    if (inferred) {
      layout = inferred;
      matches.forEach((m, i) => (m.line.pickNo = inferred.best.picks[i]));
      hasPickNumbers = true;
    }
  }
  if (hasPickNumbers) {
    matches.sort((a, b) => (a.line.pickNo ?? Infinity) - (b.line.pickNo ?? Infinity));
  }
  return { matches, hasPickNumbers, ignored, layout };
}

/** Human-readable normalized name, for tests and previews. */
export function normalizedName(name: string): string {
  return mergeName(name);
}
