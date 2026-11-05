// Named synthetic breathing sessions, as arrays of committed breaths in the shape
// signals/processor.js emits ({ t, depth, durationMs, inhaleMs, exhaleMs }).
// Used by the playground, the gallery sheet and the home-screen showcase.
import { buildVessel, makeRecipe, RECIPE_VERSION } from './vessel-profile.js';
import { patternFor } from './pattern.js';
import { paletteFor } from './palette.js';

// small seeded jitter so sessions look like real breathing but never change
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function session(id, name, n, seed, at) {
  const r = rng(seed);
  const jit = (v, k) => v * (1 + (r() - 0.5) * 2 * k);
  const breaths = [];
  let t = 2000;
  for (let i = 0; i < n; i++) {
    const u = n > 1 ? i / (n - 1) : 0;
    const b = at(u, i, r);
    const durationMs = Math.round(jit(b.ms, b.msJit ?? 0.04));
    const inhaleMs = Math.round(durationMs * jit(b.inhale ?? 0.42, 0.04));
    const depth = Math.round(Math.min(1, Math.max(0, jit(b.depth, b.depthJit ?? 0.04))) * 1000) / 1000;
    t += durationMs;
    breaths.push({ t, depth, durationMs, inhaleMs, exhaleMs: durationMs - inhaleMs });
  }
  const meanMs = breaths.reduce((s, b) => s + b.durationMs, 0) / n;
  return Object.freeze({ id, name, breaths, breathRate: Math.round((600000 / meanMs)) / 10 });
}

export const SAMPLES = Object.freeze([
  session('calm-deep', 'Calm and deep', 6, 11, () => ({ ms: 10000, depth: 0.82, inhale: 0.4 })),
  session('steady-ten', 'Steady ten', 10, 12, () => ({ ms: 5000, depth: 0.55, inhale: 0.45 })),
  session('quick-shallow', 'Quick and shallow', 11, 13, () => ({ ms: 2700, msJit: 0.42, depth: 0.24, inhale: 0.46 })),
  session('deepening', 'Deepening', 8, 14, (u) => ({ ms: 5200, depth: 0.32 + 0.6 * u, inhale: 0.44 })),
  session('easing-off', 'Easing off', 8, 15, (u) => ({ ms: 5600 + 5600 * u, depth: 0.88 - 0.5 * u, inhale: 0.42 })),
  session('long-exhales', 'Long exhales', 7, 16, () => ({ ms: 8000, depth: 0.6, inhale: 0.32 })),
  session('uneven', 'Uneven', 9, 17, (u, i, r) => ({ ms: 4600, msJit: 0.1, depth: 0.3 + 0.65 * r(), depthJit: 0, inhale: 0.42 })),
  session('three-big', 'Three big breaths', 3, 18, () => ({ ms: 6000, depth: 0.97, inhale: 0.42 })),
]);

/** A recipe loadRecipe accepts, with pattern fields, for one sample. */
export function sampleRecipe(sample, { pattern = null, finish = null, pulse = 70 } = {}) {
  const { profile, form } = buildVessel(sample.breaths, { finish: 1 });
  return makeRecipe({
    profile,
    palette: paletteFor({ breathRate: sample.breathRate, pulse }),
    breaths: sample.breaths,
    finish,
    pattern: patternFor(sample.breaths, form, pattern),
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

export { RECIPE_VERSION };
