// Pure breath maths (no three.js): clean up committed breaths and sum them up into
// a few session features that decide the vessel's form and pattern.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
export const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
export const round = (v, d) => {
  const k = 10 ** d;
  return Math.round(v * k) / k;
};

/** Clean up a breath record so every field is a finite, bounded number. */
export function normalizeBreath(b = {}) {
  const durationMs = Math.round(clamp(num(b.durationMs, 4000), 800, 20000));
  const inhaleMs = Math.round(clamp(num(b.inhaleMs, durationMs * 0.45), 200, durationMs));
  const exhaleMs = Math.round(clamp(num(b.exhaleMs, durationMs - inhaleMs), 200, 20000));
  return { depth: round(clamp(num(b.depth, 0.5), 0, 1), 4), durationMs, inhaleMs, exhaleMs };
}

/**
 * Session features from committed breaths.
 * depth: mean depth 0..1; depthStd: spread of depth; trend: fitted change in depth from
 * the first breath to the last (+ = deepening); exhaleRatio: mean out/in time;
 * paceCV: spread of breath length relative to its mean; meanMs: mean breath length.
 */
export function breathFeatures(breaths = []) {
  const b = breaths.map(normalizeBreath);
  const n = b.length;
  if (!n) return { n: 0, depth: 0.5, depthStd: 0, depthJitter: 0, trend: 0, exhaleRatio: 1.3, paceCV: 0, meanMs: 5000 };
  const d = b.map((x) => x.depth);
  const dur = b.map((x) => x.durationMs);
  let trend = 0;
  if (n >= 3) {
    const xm = (n - 1) / 2, dm = mean(d);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (i - xm) * (d[i] - dm); sxx += (i - xm) ** 2; }
    trend = clamp((sxy / sxx) * (n - 1), -1, 1);
  }
  // depth spread left over once the steady trend is taken out (irregular breathing)
  const dm = mean(d), xm = (n - 1) / 2;
  const slope = n >= 3 ? trend / (n - 1) : 0;
  const jitter = n >= 3 ? Math.sqrt(mean(d.map((x, i) => (x - dm - slope * (i - xm)) ** 2))) : 0;
  return {
    n,
    depth: round(dm, 4),
    depthStd: round(n >= 3 ? stdev(d) : 0, 4),
    depthJitter: round(jitter, 4),
    trend: round(trend, 4),
    exhaleRatio: round(clamp(mean(b.map((x) => x.exhaleMs / x.inhaleMs)), 0.3, 4), 4),
    paceCV: round(n >= 3 ? stdev(dur) / mean(dur) : 0, 4),
    meanMs: Math.round(mean(dur)),
  };
}
