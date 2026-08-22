// One-line plain-language reasons, templated from the numbers. No LLM.

import type { BoardPlayer, Recommendation } from "../types";

const POS_LABEL: Record<string, string> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  K: "kicker",
  DST: "defense",
};

export function buildReason(
  rec: Recommendation,
  available: BoardPlayer[],
  nextPick: number
): string {
  const p = rec.player;
  const clauses: string[] = [];

  // Tier context
  const tierMates = available.filter(
    (a) => a.pos === p.pos && a.tier === p.tier && a.id !== p.id
  ).length;
  const tierLabel = `${POS_LABEL[p.pos]}${p.tier}`;
  if (tierMates === 0) {
    clauses.push(`Last of the ${tierLabel} tier.`);
  } else if (tierMates <= 2) {
    clauses.push(`Only ${tierMates + 1} left in the ${tierLabel} tier.`);
  }

  // Survival
  const pct = Math.round(rec.survivalToNextPick * 100);
  if (pct <= 4) {
    clauses.push(`He won't be there at pick ${nextPick}.`);
  } else if (pct <= 60) {
    clauses.push(`${pct}% he survives to pick ${nextPick}.`);
  } else if (clauses.length === 0) {
    clauses.push(`${pct}% he's still there at pick ${nextPick} — but nothing better is.`);
  }

  // VONA
  if (rec.vona >= 8 && clauses.length < 2) {
    clauses.push(`Next ${POS_LABEL[p.pos]} at your pick projects ${Math.round(rec.vona)} points worse.`);
  }

  if (clauses.length === 0) {
    clauses.push("Best value on the board.");
  }
  return clauses.slice(0, 2).join(" ");
}
