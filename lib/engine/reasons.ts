// One-line plain-language reasons, templated from the numbers. No LLM.

import type { BoardPlayer, Position, Recommendation } from "../types";
import { survivalProb } from "./survival";

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

  // Schedule
  if (p.sosPlayoff != null && p.sosPlayoff >= 0.72 && clauses.length < 2) {
    clauses.push("Soft weeks 15-17 schedule.");
  }

  if (clauses.length === 0) {
    clauses.push("Best value on the board.");
  }
  return clauses.slice(0, 2).join(" ");
}

/**
 * Why an alternate might beat the top pick — comparative, not generic.
 * "I need to disagree quickly, not be forced into the engine's opinion."
 */
export function buildAlternateReason(
  alt: Recommendation,
  top: Recommendation,
  nextPick: number
): string {
  const clauses: string[] = [];
  const p = alt.player;

  if (p.pos !== top.player.pos) {
    clauses.push(`Different build — fills ${POS_LABEL[p.pos]} instead.`);
  }
  if (alt.simStdev < top.simStdev * 0.85) {
    clauses.push("Safer floor than the top pick.");
  } else if (alt.simStdev > top.simStdev * 1.15) {
    clauses.push("More ceiling if you want variance.");
  }
  if (alt.survivalToNextPick >= top.survivalToNextPick + 0.25 && alt.survivalToNextPick >= 0.5) {
    clauses.push(
      `${Math.round(alt.survivalToNextPick * 100)}% he's still there at ${nextPick} — you could wait.`
    );
  } else if (alt.survivalToNextPick <= 0.25) {
    clauses.push(`Now or never — ${Math.round(alt.survivalToNextPick * 100)}% at pick ${nextPick}.`);
  }
  if (p.sosPlayoff != null && p.sosPlayoff >= 0.72 && clauses.length < 2) {
    clauses.push("Soft weeks 15-17 schedule.");
  }
  if (clauses.length === 0) return buildReason(alt, [], nextPick);
  return clauses.slice(0, 2).join(" ");
}

export interface BlurbContext {
  currentPick: number;
  nextPick: number;
  drift: Partial<Record<Position, number>>;
  tierMatesLeft: number; // undrafted players sharing this player's tier
}

export type Verdict = "perfect" | "good" | "fair" | "bad" | "horrible";
export type Risk = "low risk" | "medium risk" | "high risk";

export interface PlayerBlurb {
  verdict: Verdict;
  risk: Risk;
  lines: string[];
}

/** The at-a-glance grade for taking this player AT THIS PICK. Pure math. */
export function playerVerdict(p: BoardPlayer, ctx: BlurbContext): { verdict: Verdict; risk: Risk } {
  const diff = p.adp - ctx.currentPick; // + = reaching past market
  const seasonEnder = ["IR", "PUP", "Sus", "NA", "COV", "DNR"].includes(p.injury ?? "");
  const scarce = ctx.tierMatesLeft <= 1;
  const value = -diff; // + = falling to you

  let verdict: Verdict;
  if (seasonEnder || diff >= 18) verdict = "horrible";
  else if (diff >= 10 || p.injury === "Out") verdict = "bad";
  else if (value >= 6 && scarce && !p.injury) verdict = "perfect";
  else if (value >= 4 || scarce || (diff <= 2 && p.sosPlayoff != null && p.sosPlayoff >= 0.72))
    verdict = "good";
  else verdict = "fair";

  const risky =
    p.adpStdev >= 10 ||
    Boolean(p.injury) ||
    ((p.depthOrder ?? 1) >= 2 && (p.pos === "RB" || p.pos === "WR")) ||
    p.projImputed;
  const steady = p.adpStdev <= 4.5 && !p.injury && (p.depthOrder ?? 1) === 1;
  const risk: Risk = risky ? "high risk" : steady ? "low risk" : "medium risk";
  return { verdict, risk };
}

/**
 * Hover-card content: the verdict plus why — every line computed from the
 * numbers already on the board. No LLM, ever.
 */
export function playerBlurb(p: BoardPlayer, ctx: BlurbContext): PlayerBlurb {
  const lines: string[] = [];

  // Market read
  const diff = p.adp - ctx.currentPick;
  if (diff >= 10) lines.push(`Reach — market says ${Math.round(diff)} picks from now (ADP ${p.adp.toFixed(0)}).`);
  else if (diff >= 4) lines.push(`Slightly early — ADP ${p.adp.toFixed(0)}.`);
  else if (diff <= -8) lines.push(`Falling — ADP ${p.adp.toFixed(0)}, available ${Math.round(-diff)} picks late.`);
  else lines.push(`Fair price — ADP ${p.adp.toFixed(0)}.`);

  // Tier context
  lines.push(
    ctx.tierMatesLeft === 0
      ? `Last of the ${POS_LABEL[p.pos]}${p.tier} tier.`
      : `${POS_LABEL[p.pos]}${p.tier} tier · ${ctx.tierMatesLeft + 1} left.`
  );

  // Survival to my next pick
  const s = Math.round(survivalProb(p, ctx.nextPick, ctx.drift) * 100);
  lines.push(`${s}% he survives to your pick ${ctx.nextPick}.`);

  // Schedule
  if (p.sosPlayoff != null) {
    if (p.sosPlayoff >= 0.72) lines.push("Soft playoff schedule (weeks 15-17).");
    else if (p.sosPlayoff <= 0.28) lines.push("Brutal playoff schedule (weeks 15-17).");
  }

  // Role + health
  if (p.depthOrder != null && p.depthOrder >= 2 && (p.pos === "RB" || p.pos === "WR")) {
    lines.push(`Depth-chart #${p.depthOrder} — backup role today.`);
  }
  if (p.injury) lines.push(`Injury: ${p.injury}.`);
  if (p.projImputed) lines.push("No ESPN projection — estimated from ADP neighbors.");

  return { ...playerVerdict(p, ctx), lines };
}
