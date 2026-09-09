// Fitting primitives for scripts/calibrate-weekly.ts. Pure, so the statistics
// are unit-tested rather than trusted.
//
// Everything here is deliberately simple: ordinary least squares on log
// residuals, empirical rates, bucketed standard deviations. The signal in
// weekly fantasy football is small, and a fancier estimator on a residual this
// noisy buys precision the data cannot support.

/** Minimum points before a slope means anything. */
const MIN_FIT_N = 3;
/**
 * Minimum observations before a status's play rate is trusted. At n=2 a
 * proportion's 95% interval spans essentially [0,1], so a rate from a handful
 * of rows carries no information — the caller falling back to
 * FALLBACK_PLAY_PROB is strictly better than believing 1/1. Do not lower this
 * to accommodate a small test fixture; enlarge the fixture.
 */
const MIN_STATUS_N = 20;

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function olsSlope(xs: number[], ys: number[]): number {
  return olsFit(xs, ys).slope;
}

export interface OlsFit {
  slope: number;
  /** Standard error of the slope. 0 when the slope is not estimable. */
  se: number;
  /** slope / se. 0 when not estimable. */
  t: number;
  n: number;
}

/**
 * OLS slope WITH its standard error, so a caller can ask whether the
 * coefficient is distinguishable from zero before shipping it.
 *
 * This matters more here than it usually would. Weekly fantasy residuals are
 * enormously noisy — the log-residual standard deviation is 0.57 to 0.84 by
 * position — so a regression over thousands of rows can still produce a
 * confident-looking coefficient that is pure noise. Measured on 10,131 fitted
 * player-weeks, every environment and matchup coefficient came out with
 * |t| < 1.96. Shipping those would add variance with no signal.
 */
export function olsFit(xs: number[], ys: number[]): OlsFit {
  const n = Math.min(xs.length, ys.length);
  if (n < MIN_FIT_N) return { slope: 0, se: 0, t: 0, n };
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (!(den > 0)) return { slope: 0, se: 0, t: 0, n };
  const slope = num / den;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const yhat = my + slope * (xs[i] - mx);
    sse += (ys[i] - yhat) ** 2;
  }
  // n - 2 residual degrees of freedom: intercept plus slope.
  const se = Math.sqrt(sse / (n - 2) / den);
  return { slope, se, t: se > 0 ? slope / se : 0, n };
}

/** |t| a coefficient must clear to be kept rather than zeroed. */
export const MIN_ABS_T = 2;

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
  for (let b = 0; b < BUCKETS; b++) {
    const slice = sorted.slice(b * per, b === BUCKETS - 1 ? sorted.length : (b + 1) * per);
    const sd = stdev(slice.map((p) => p.logResidual));
    const meanV = slice.reduce((s, p) => s + p.volume, 0) / slice.length;
    if (sd <= 0 || meanV <= 0) continue;
    xs.push(Math.log(v0 / meanV));
    ys.push(Math.log(sd));
  }
  // Every bucket filtered out (all-identical volumes, or all-zero spread)
  // would leave xs/ys empty, making the means 0/0 = NaN and sigma0
  // exp(NaN) = NaN. loadWeeklyModel would reject that on the next import, but
  // one step removed from its cause — as a config-load error after a
  // calibration that reported success. Degrade to the flat sd instead.
  if (xs.length < MIN_FIT_N) {
    return { sigma0: stdev(points.map((p) => p.logResidual)), delta: 0 };
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
