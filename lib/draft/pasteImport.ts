// Paste import: turn a copied "drafted players" panel from ANY draft site into
// board picks. Pure — text and players in, ordered matches out — so the fiddly
// parsing is unit-tested and the cockpit only has to render a preview.
//
// Formats seen in the wild (all handled):
//   1.01 Ja'Marr Chase WR - CIN          Sleeper-style round.pick
//   1 (1) Ja'Marr Chase, CIN WR          ESPN draft recap
//   1. (1) Ja'Marr Chase (Cin - WR)      Yahoo draft results
//   #17  Bijan Robinson  RB  ATL         numbered lists, tabs or spaces
//   Chase, Ja'Marr                       last-first
//   1.01 ⏎ Ja'Marr Chase ⏎ CIN WR        pick / name / meta on separate lines
//   Seahawks D/ST · Baltimore Defense    team defenses by nickname or city
// Owner names, "Round 3" headers, bye weeks and points are ignored.

import type { BoardPlayer, Position } from "../types";
import { scorePlayers } from "./fuzzy";
import { mergeName } from "../etl/names";

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
  /** Lines that carried no name at all (headers, blank separators). */
  ignored: string[];
}

const TEAM_ALIASES: Record<string, string> = {
  ARI: "ARI", ATL: "ATL", BAL: "BAL", BUF: "BUF", CAR: "CAR", CHI: "CHI", CIN: "CIN", CLE: "CLE",
  DAL: "DAL", DEN: "DEN", DET: "DET", GB: "GB", GNB: "GB", HOU: "HOU", IND: "IND", JAX: "JAX", JAC: "JAX",
  KC: "KC", KAN: "KC", LV: "LV", LVR: "LV", OAK: "LV", LAC: "LAC", SD: "LAC", SDG: "LAC", LAR: "LAR", LA: "LAR",
  STL: "LAR", MIA: "MIA", MIN: "MIN", NE: "NE", NWE: "NE", NO: "NO", NOR: "NO", NYG: "NYG", NYJ: "NYJ",
  PHI: "PHI", PIT: "PIT", SF: "SF", SFO: "SF", SEA: "SEA", TB: "TB", TAM: "TB", TEN: "TEN", WAS: "WAS", WSH: "WAS",
};

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

const POS_TOKENS: Record<string, Position> = {
  QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", PK: "K", DST: "DST", DEF: "DST", "D/ST": "DST", DE: "DST",
};

/** Words that never belong to a player name. */
const NOISE = new Set([
  "round", "rd", "pick", "pk", "overall", "team", "drafted", "by", "selected", "selects", "bye", "pts",
  "points", "proj", "adp", "rank", "flex", "bn", "bench", "ir", "owner", "manager", "keeper", "auto",
  "autopick", "autodraft", "the", "queue", "queued", "you", "your", "me",
]);

/** "1.05", "R1P5", "1-05", "Round 1, Pick 5", "Rd 1 Pk 5" → overall pick (needs teams). */
function roundPick(text: string, teams: number): { pickNo: number; consumed: string } | null {
  const patterns: RegExp[] = [
    /(?:^|\s)(\d{1,2})[.\-:](\d{2})(?=\s|$|[),:])/,
    /\bR(?:ound|d)?\.?\s*(\d{1,2})\s*[,\-–—]?\s*P(?:ick|k)?\.?\s*(\d{1,2})\b/i,
    /\bR(\d{1,2})P(\d{1,2})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const round = Number(m[1]);
    const pick = Number(m[2]);
    if (round < 1 || round > 40 || pick < 1 || pick > Math.max(teams, 20)) continue;
    return { pickNo: (round - 1) * teams + pick, consumed: m[0] };
  }
  return null;
}

/** A leading bare number: "17", "#17", "17.", "17)", "17 (5)". */
function leadingNumber(text: string): { n: number; consumed: string } | null {
  const m = text.match(/^\s*#?(\d{1,3})(?:\s*\(\d{1,2}\))?[.):]?(?=\s|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 400) return null;
  return { n, consumed: m[0] };
}

function isUpper(tok: string): boolean {
  return /^[A-Z][A-Z/]*$/.test(tok) && tok !== "I";
}

interface Cleaned {
  nameText: string;
  pos: Position | null;
  team: string | null;
}

/** Pull position + team tokens out of a line, leaving the likeliest name text. */
function cleanLine(text: string): Cleaned {
  let pos: Position | null = null;
  let team: string | null = null;
  // Parenthesized meta: "(Cin - WR)", "(CIN)", "(Bye 7)". Extract, then drop.
  let work = text.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    for (const tok of inner.split(/[\s\-–—,/|·]+/)) {
      const up = tok.toUpperCase();
      if (!team && TEAM_ALIASES[up] && (up.length >= 2)) team = TEAM_ALIASES[up];
      else if (!pos && POS_TOKENS[up] && up !== "DE") pos = POS_TOKENS[up];
    }
    return " ";
  });
  work = work.replace(/[|·•]/g, " ").replace(/\s[-–—]\s/g, " ").replace(/,/g, " , ");
  const tokens = work.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const bare = tok.replace(/[.,]/g, "");
    const up = bare.toUpperCase();
    if (tok === ",") {
      kept.push(",");
      continue;
    }
    if (isUpper(bare) && TEAM_ALIASES[up] && kept.length > 0 && !team) {
      // Team codes follow the name ("Chase CIN"), never lead it. "LA"/"NO"/"NE" in
      // caps mid-name would be a stretch anyway.
      team = TEAM_ALIASES[up];
      continue;
    }
    if (isUpper(bare) && POS_TOKENS[up] && up !== "DE") {
      // "K" is also an initial ("K. Walker"): a lone K only counts as a position
      // when it does not introduce a name.
      const next = tokens[i + 1]?.replace(/[.,]/g, "");
      const introducesName = up === "K" && next != null && /^[A-Za-z][a-z'’-]+$/.test(next);
      if (kept.length > 0 && !introducesName && !pos) {
        pos = POS_TOKENS[up];
        continue;
      }
      if (kept.length === 0 && !introducesName && !pos) {
        pos = POS_TOKENS[up];
        continue;
      }
    }
    if (/^\d+(\.\d+)?$/.test(bare)) continue; // stray numbers: bye weeks, points, ranks
    if (NOISE.has(bare.toLowerCase())) continue;
    if (/^d\/st$/i.test(bare) || /^defense$/i.test(bare) || /^defence$/i.test(bare)) {
      pos = "DST";
      continue;
    }
    kept.push(tok.replace(/[.,]+$/, "").replace(/^[.,]+/, ""));
  }
  // "Last, First" → "First Last"
  let nameText = kept.join(" ").replace(/\s+,\s+/g, ", ").trim();
  const lf = nameText.match(/^([^,]+),\s*([^,]+)$/);
  if (lf) nameText = `${lf[2]} ${lf[1]}`;
  nameText = nameText.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  return { nameText, pos, team };
}

/**
 * A pick number carried by a line, if any: "1.05" (needs teams), "Round 1
 * Pick 5", "#17", "17." — shared with the OCR matcher.
 */
export function extractPickNo(text: string, teams: number): number | null {
  const rp = roundPick(text, Math.max(2, teams));
  if (rp) return rp.pickNo;
  const ln = leadingNumber(text);
  return ln ? ln.n : null;
}

/** The team defense a line names, by nickname / city / code — shared with the OCR matcher. */
export function findDefense(text: string, team: string | null, players: BoardPlayer[]): BoardPlayer | null {
  const lower = text.toLowerCase();
  const mentionsDefense = /\b(d\/st|dst|def|defense|defence)\b/.test(lower);
  const nick = Object.entries(DST_NAMES).find(([n]) => new RegExp(`(^|\\s)${n}(\\s|$)`).test(lower))?.[1] ?? null;
  const code = nick ?? (mentionsDefense ? team : null);
  if (!code) return null;
  return players.find((p) => p.pos === "DST" && p.team === code) ?? null;
}

function dstFor(nameText: string, team: string | null, players: BoardPlayer[]): BoardPlayer | null {
  const lower = nameText.toLowerCase();
  let code = team;
  if (!code) {
    for (const [nick, c] of Object.entries(DST_NAMES)) {
      if (new RegExp(`(^|\\s)${nick}(\\s|$)`).test(lower)) {
        code = c;
        break;
      }
    }
  }
  if (!code) return null;
  return players.find((p) => p.pos === "DST" && p.team === code) ?? null;
}

interface Resolved {
  player: BoardPlayer | null;
  confidence: "high" | "low";
  suggestions: BoardPlayer[];
}

/** Which player a cleaned line means, with confidence. */
export function resolvePlayer(cleaned: Cleaned, players: BoardPlayer[]): Resolved {
  const { nameText, pos, team } = cleaned;
  if (!nameText) return { player: null, confidence: "low", suggestions: [] };

  // Team defenses: nickname / city / "D/ST" before any fuzzy name work.
  const wantsDst = pos === "DST" || /\b(d\/st|dst|defense|defence|def)\b/i.test(nameText);
  if (wantsDst || Object.keys(DST_NAMES).some((n) => new RegExp(`(^|\\s)${n}(\\s|$)`).test(nameText.toLowerCase()))) {
    const dst = dstFor(nameText, team, players);
    if (dst) return { player: dst, confidence: "high", suggestions: [] };
  }

  let scored = scorePlayers(nameText, players);
  // A "Last First" paste can slip through un-swapped ("Chase Ja'Marr"): try both orders.
  const words = nameText.split(" ");
  if (scored.length === 0 && words.length === 2) {
    scored = scorePlayers(`${words[1]} ${words[0]}`, players);
  }
  if (scored.length === 0) return { player: null, confidence: "low", suggestions: [] };

  const posOk = (p: BoardPlayer) => !pos || p.pos === pos;
  const teamOk = (p: BoardPlayer) => !team || p.team === team;
  const consistent = scored.filter((s) => posOk(s.player) && teamOk(s.player));
  const pool = consistent.length > 0 ? consistent : scored;
  const top = pool[0];
  const second = pool[1];
  const suggestions = pool.slice(0, 4).map((s) => s.player);

  const singleToken = words.length === 1;
  let confidence: "high" | "low" = "low";
  if (top.exact) confidence = "high";
  else if (!second) confidence = singleToken && !pos && !team ? "low" : "high";
  else if (top.score - second.score >= 2 && !singleToken) confidence = "high";
  else if ((pos || team) && consistent.length === 1) confidence = "high";
  return { player: top.player, confidence, suggestions };
}

/** Merge meta-only lines ("CIN WR", "1.01") into their neighbouring name line. */
function coalesceLines(lines: string[]): { lines: string[]; ignored: string[] } {
  const out: string[] = [];
  const ignored: string[] = [];
  let pendingPrefix = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Section headers carry nothing: "Round 3", "Rd. 3", "ROUND 3 ·".
    if (/^(round|rd)\.?\s*\d{1,2}\b[\s·:\-–—]*$/i.test(line)) {
      ignored.push(line);
      continue;
    }
    const alpha = line.replace(/[^A-Za-z'’.\-\s]/g, " ").split(/\s+/).filter((t) => t.length >= 2);
    const upper = alpha.map((t) => t.replace(/\./g, "").toUpperCase());
    const hasNameWord = alpha.some((t, i) => {
      const up = upper[i];
      return !(TEAM_ALIASES[up] || POS_TOKENS[up] || NOISE.has(t.toLowerCase()) || /^d\/st$/i.test(t));
    });
    // "HOU DST" / "SEA DEF" IS a pick — a team defense by code.
    const dstByCode = upper.some((u) => TEAM_ALIASES[u]) && /\b(DST|DEF|D\/ST)\b/i.test(line);
    if (!hasNameWord && !dstByCode) {
      // Meta only. Pick numbers lead the NEXT line; pos/team trail the PREVIOUS.
      if (/\d/.test(line) && !/[A-Za-z]{2,}/.test(line.replace(/\b(round|rd|pick|pk)\b/gi, ""))) {
        pendingPrefix = `${pendingPrefix} ${line}`.trim();
      } else if (out.length > 0) {
        out[out.length - 1] = `${out[out.length - 1]} ${line}`;
      } else {
        pendingPrefix = `${pendingPrefix} ${line}`.trim();
      }
      continue;
    }
    out.push(pendingPrefix ? `${pendingPrefix} ${line}` : line);
    pendingPrefix = "";
  }
  return { lines: out, ignored };
}

export function parsePastedPicks(
  text: string,
  players: BoardPlayer[],
  draftedIds: Set<string>,
  opts: { teams: number }
): PasteResult {
  const teams = Math.max(2, opts.teams);
  const rawLines = text.replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
  const { lines, ignored } = coalesceLines(rawLines);
  const parsed: ParsedLine[] = [];
  const bareNumbers: (number | null)[] = [];

  for (const line of lines) {
    let work = line;
    let pickNo: number | null = null;
    const rp = roundPick(work, teams);
    if (rp) {
      pickNo = rp.pickNo;
      work = work.replace(rp.consumed, " ");
    }
    let bare: number | null = null;
    const ln = leadingNumber(work);
    if (ln) {
      bare = ln.n;
      work = work.slice(ln.consumed.length);
    }
    bareNumbers.push(pickNo == null ? bare : null);
    const cleaned = cleanLine(work);
    if (!cleaned.nameText) {
      ignored.push(line);
      bareNumbers.pop();
      continue;
    }
    parsed.push({ raw: line, pickNo, ...cleaned });
  }

  // Leading bare numbers are pick numbers only when they form a clean sequence
  // (a ranking or row count would too — but then marking in that order is right anyway).
  const bares = bareNumbers.filter((n): n is number => n != null);
  if (bares.length === parsed.length && bares.length >= 2) {
    const distinct = new Set(bares).size === bares.length;
    const asc = bares.every((n, i) => i === 0 || n > bares[i - 1]);
    const desc = bares.every((n, i) => i === 0 || n < bares[i - 1]);
    if (distinct && (asc || desc)) parsed.forEach((p, i) => (p.pickNo = p.pickNo ?? bares[i]));
  }

  const matches: PasteMatch[] = parsed.map((line) => {
    const r = resolvePlayer(line, players);
    return {
      line,
      player: r.player,
      confidence: r.confidence,
      suggestions: r.suggestions,
      alreadyDrafted: r.player ? draftedIds.has(r.player.id) : false,
    };
  });

  // De-duplicate a player pasted twice (a panel that lists him under two headers).
  const seen = new Set<string>();
  for (const m of matches) {
    if (!m.player) continue;
    if (seen.has(m.player.id)) {
      m.player = null;
      m.confidence = "low";
    } else seen.add(m.player.id);
  }

  const hasPickNumbers = matches.some((m) => m.line.pickNo != null);
  if (hasPickNumbers) {
    matches.sort((a, b) => (a.line.pickNo ?? Infinity) - (b.line.pickNo ?? Infinity));
  }
  return { matches, hasPickNumbers, ignored };
}

/** Human-readable normalized name, for tests and previews. */
export function normalizedName(name: string): string {
  return mergeName(name);
}
