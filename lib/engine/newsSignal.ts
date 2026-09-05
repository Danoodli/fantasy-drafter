// Live news → gradeable injury signal.
//
// Pure and deterministic: text in, status out. No clock, no I/O, no network.
// The impure half lives in lib/client/{espnNews,bskyNews,wireStream}.ts, which
// already window news by recency before it reaches here.
//
// Deliberately conservative ("hard signals only"): we classify a headline only
// when it unambiguously states a player will miss time. A keyword matcher with
// no LLM at runtime cannot safely read intent, and the cost of a false positive
// is high — it would silently bury a healthy player mid-draft. When in doubt we
// return null and let the 📰 badge inform the human instead.

/** Injury statuses the engine already grades, reused verbatim so the scoring path is unchanged. */
export type InjuryStatus = "IR" | "Sus" | "Out" | "Doubtful" | "Questionable";

/** Severity order for reconciling the baked snapshot against a live headline. */
const SEVERITY: Record<InjuryStatus, number> = {
  Questionable: 1,
  Doubtful: 2,
  Out: 3,
  Sus: 4,
  IR: 5,
};

/**
 * Phrases meaning "this player is available after all". Checked FIRST, because
 * "activated from injured reserve" contains "injured reserve" and would
 * otherwise be read as the exact opposite of what it says.
 */
const CLEARED = [
  /\bactivated\b/,
  /\breturns?\b/,
  /\breturning\b/,
  /\bcleared\b/,
  /\bavoids?\b/,
  /\bwill play\b/,
  /\bexpected to play\b/,
  /\bno longer\b/,
  /\bnot expected to miss\b/,
  /\bwon'?t miss\b/,
  /\bremoved from\b/,
  /\bupgraded\b/,
  /\bfull practice\b/,
  /\bprobable\b/,
];

/**
 * Hard signals, most severe first. Each entry must be specific enough that a
 * generic football headline cannot trip it.
 */
const RULES: { status: InjuryStatus; patterns: RegExp[] }[] = [
  {
    status: "IR",
    patterns: [
      /\b(placed|lands?|landing|goes|going)\s+on\s+(the\s+)?(injured reserve|ir)\b/,
      /\bto\s+(the\s+)?ir\b/,
      /\bseason[-\s]ending\b/,
      /\bout for the (season|year)\b/,
      /\bmiss(es|ing)? the (rest of the )?(season|year)\b/,
      /\btorn?\s+(acl|achilles|pcl|patellar)\b/,
      /\b(acl|achilles)\s+tear\b/,
      /\bruptured\s+achilles\b/,
    ],
  },
  {
    status: "Sus",
    patterns: [
      /\bsuspend(s|ed|ing)\b(?!\s+operations)/,
      /\bsuspension\b/,
      /\barrested\b/,
      /\bplaced on the (commissioner|exempt)\b/,
    ],
  },
  {
    status: "Out",
    patterns: [
      /\bruled out\b/,
      /\bwill not play\b/,
      /\bwon'?t play\b/,
      /\bdeclared out\b/,
      /\bis out\b/,
      /\blisted as inactive\b/,
      /\bis inactive\b/,
      /\bcarted off\b/,
      /\bstretchered off\b/,
      /\bwill miss\b/,
    ],
  },
  {
    status: "Doubtful",
    patterns: [/\bdoubtful\b/],
  },
];

/**
 * Classify a news headline into a gradeable injury status, or null when the
 * headline carries no unambiguous hard signal.
 */
export function classifyNews(headline: string): InjuryStatus | null {
  const t = headline.toLowerCase();
  if (CLEARED.some((re) => re.test(t))) return null;
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(t))) return rule.status;
  }
  return null;
}

/**
 * Reconcile the board's build-time injury status with a live news signal.
 * Takes the MORE severe of the two — live news can escalate a player but never
 * silently clears a designation the ETL already captured.
 */
export function liveInjuryStatus(
  baked: string | null,
  live: InjuryStatus | null
): string | null {
  if (!live) return baked;
  if (!baked) return live;
  const b = SEVERITY[baked as InjuryStatus];
  if (b == null) return baked; // unrecognized baked status wins; don't guess
  return b >= SEVERITY[live] ? baked : live;
}
