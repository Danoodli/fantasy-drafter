// Type-ahead player matching for manual mode. Must resolve partial and
// abbreviated names ("ceedee" → CeeDee Lamb, "b thomas" → Brian Thomas Jr.,
// "k walker" → Kenneth Walker) in sub-second time on a 90-second clock.

import type { BoardPlayer } from "../types";
import { mergeName } from "../etl/names";

/**
 * Score how well query tokens match name tokens, in order. Each query token
 * must match SOME name token at or after the previous match position:
 * exact > prefix > substring. Returns 0 if any token fails.
 */
function tokenScore(queryTokens: string[], nameTokens: string[]): number {
  let score = 0;
  let namePos = 0;
  for (const q of queryTokens) {
    let matched = false;
    for (let i = namePos; i < nameTokens.length; i++) {
      const t = nameTokens[i];
      if (t === q) {
        score += 3;
        namePos = i + 1;
        matched = true;
        break;
      }
      if (t.startsWith(q)) {
        score += 2;
        namePos = i + 1;
        matched = true;
        break;
      }
      if (q.length >= 3 && t.includes(q)) {
        score += 1;
        namePos = i + 1;
        matched = true;
        break;
      }
    }
    if (!matched) return 0;
  }
  return score;
}

export interface ScoredPlayer {
  player: BoardPlayer;
  score: number;
  /** The normalized query equals the normalized full name. */
  exact: boolean;
}

/**
 * Every player the query could mean, best first, with the match score —
 * the paste/OCR importers need the scores to judge confidence; the search
 * box only needs the order.
 */
export function scorePlayers(query: string, players: BoardPlayer[]): ScoredPlayer[] {
  const q = mergeName(query.replace(/\./g, " "));
  if (!q) return [];
  const queryTokens = q.split(" ").filter(Boolean);
  const matches: ScoredPlayer[] = [];
  for (const p of players) {
    const name = mergeName(p.name);
    const nameTokens = name.split(" ");
    let score = tokenScore(queryTokens, nameTokens);
    // Whole-string prefix beats token matches ("ja" → top ADP "Ja..." names)
    if (name.startsWith(q)) score += 4;
    if (score <= 0) continue;
    // Earlier-ADP players are the likelier intent; small, bounded boost.
    const adpBoost = Math.max(0, 2 - p.adp / 100);
    matches.push({ player: p, score: score + adpBoost, exact: name === q });
  }
  matches.sort((a, b) => b.score - a.score || a.player.adp - b.player.adp);
  return matches;
}

export function searchPlayers(
  query: string,
  players: BoardPlayer[],
  limit = 8
): BoardPlayer[] {
  return scorePlayers(query, players)
    .slice(0, limit)
    .map((m) => m.player);
}
