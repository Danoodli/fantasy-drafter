// Fitting primitives for scripts/calibrate-weekly.ts. Pure, so the statistics
// are unit-tested rather than trusted.
//
// Everything here is deliberately simple: ordinary least squares on log
// residuals, empirical rates, bucketed standard deviations. The signal in
// weekly fantasy football is small, and a fancier estimator on a residual this
// noisy buys precision the data cannot support.

/** Minimum points before a slope means anything. */
const MIN_FIT_N = 3;
/** Minimum observations before a status's play rate is trusted. */
const MIN_STATUS_N = 2;

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function olsSlope(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < MIN_FIT_N) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

/**
 * Fit sigma = sigma0 · (v0/v)^delta by bucketing on volume, taking each
 * bucket's residual standard deviation, and regressing log(sd) on log(v0/v).
 * sigma0 is read off at v = v0.
 */
export function fitSigmaByVolume(
  points: { volume: number; logResidual: number }[],
  v0: number
): { sigma0: number; delta: number } {
  const BUCKETS = 8;
  const sorted = [...points].sort((a, b) => a.volume - b.volume);
  if (sorted.length < BUCKETS * 5) {
    return { sigma0: stdev(points.map((p) => p.logResidual)), delta: 0 };
  }
  const per = Math.floor(sorted.length / BUCKETS);
  const xs: number[] = [];
  const ys: number[] = [];
  const sds: { v: number; sd: number }[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const slice = sorted.slice(b * per, b === BUCKETS - 1 ? sorted.length : (b + 1) * per);
    const sd = stdev(slice.map((p) => p.logResidual));
    const meanV = slice.reduce((s, p) => s + p.volume, 0) / slice.length;
    if (sd <= 0 || meanV <= 0) continue;
    sds.push({ v: meanV, sd });
    xs.push(Math.log(v0 / meanV));
    ys.push(Math.log(sd));
  }
  const delta = olsSlope(xs, ys);
  // sigma0 is the fitted sd at v = v0, i.e. where log(v0/v) = 0.
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const intercept = meanY - delta * meanX;
  return { sigma0: Math.exp(intercept), delta };
}

/**
 * P(played | designation). Designations seen too rarely are omitted, so the
 * caller falls back to FALLBACK_PLAY_PROB rather than to a rate of 1/1.
 *
 * NOTE: not currently called by scripts/calibrate-weekly.ts. The only
 * historical status available is Sleeper's live field rather than the week's,
 * so there is nothing sound to feed this yet. Kept and tested because the
 * weekly lane is now accumulating contemporaneous statuses, which will be.
 */
export function empiricalPlayRate(
  rows: { status: string | null; played: boolean }[]
): Record<string, number> {
  const acc: Record<string, { n: number; played: number }> = {};
  for (const r of rows) {
    if (!r.status) continue;
    const cell = (acc[r.status] ??= { n: 0, played: 0 });
    cell.n++;
    if (r.played) cell.played++;
  }
  const out: Record<string, number> = {};
  for (const [status, c] of Object.entries(acc)) {
    if (c.n >= MIN_STATUS_N) out[status] = c.played / c.n;
  }
  return out;
}

/**
 * Distribution calibration. For a correctly-specified lognormal, 10% of
 * actuals fall below p10 and 10% above p90. This is the gate that matters most
 * for start/sit and GPP and the one almost nobody runs: a model can have
 * excellent MAE and still be badly wrong about how often the ceiling hits.
 */
export function pitCoverage(
  pairs: { actual: number; mean: number; sigma: number }[]
): { below10: number; above90: number } {
  const Z10 = -1.2815515655446004;
  const Z90 = 1.2815515655446004;
  let below = 0;
  let above = 0;
  let n = 0;
  for (const { actual, mean, sigma } of pairs) {
    if (!(mean > 0) || !(sigma > 0)) continue;
    const mu = Math.log(mean) - (sigma * sigma) / 2;
    const p10 = Math.exp(mu + sigma * Z10);
    const p90 = Math.exp(mu + sigma * Z90);
    n++;
    if (actual < p10) below++;
    if (actual > p90) above++;
  }
  return n > 0 ? { below10: below / n, above90: above / n } : { below10: 0, above90: 0 };
}
