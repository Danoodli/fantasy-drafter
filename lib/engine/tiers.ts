// Gap-based tier detection within a position. Pure, deterministic.
//
// A tier break happens where the drop between consecutive players is large
// relative to the gaps AROUND it (a local window), not a global average —
// at the top of a position gaps are naturally wide, and a global threshold
// turns every elite player into a singleton tier. Tier sizes are capped so
// one flat stretch doesn't produce a 25-player "tier".

export interface TierOptions {
  /** Gap must exceed this multiple of the local mean gap... */
  gapFactor: number;
  /** ...and this many absolute points. */
  minGap: number;
  /** Gaps within ±window positions form the local baseline. */
  window: number;
  /** Max players in one tier. */
  maxTierSize: number;
  /** Only tier the top N players; the rest share a final catch-all tier. */
  depth: number;
}

export const DEFAULT_TIER_OPTIONS: TierOptions = {
  gapFactor: 1.8,
  minGap: 4.0,
  window: 4,
  maxTierSize: 8,
  depth: 48,
};

/**
 * Assign tier numbers (1 = best) to a list of projected points sorted DESC.
 * Returns an array of tier numbers aligned with the input.
 */
export function assignTiers(
  pointsDesc: number[],
  opts: TierOptions = DEFAULT_TIER_OPTIONS
): number[] {
  const n = pointsDesc.length;
  if (n === 0) return [];
  const depth = Math.min(opts.depth, n);

  const gaps: number[] = [];
  for (let i = 1; i < depth; i++) gaps.push(pointsDesc[i - 1] - pointsDesc[i]);

  const breaks: boolean[] = gaps.map((gap, i) => {
    const lo = Math.max(0, i - opts.window);
    const hi = Math.min(gaps.length, i + opts.window + 1);
    const neighbors: number[] = [];
    for (let j = lo; j < hi; j++) if (j !== i) neighbors.push(gaps[j]);
    const localMean =
      neighbors.length > 0 ? neighbors.reduce((a, b) => a + b, 0) / neighbors.length : 0;
    return gap > Math.max(opts.gapFactor * localMean, opts.minGap);
  });

  const tiers: number[] = [1];
  let tier = 1;
  let tierSize = 1;
  for (let i = 1; i < n; i++) {
    if (i >= depth) {
      if (i === depth) tier++; // catch-all tier for the deep bench
      tiers.push(tier);
      continue;
    }
    if (breaks[i - 1] || tierSize >= opts.maxTierSize) {
      tier++;
      tierSize = 0;
    }
    tiers.push(tier);
    tierSize++;
  }
  return tiers;
}
