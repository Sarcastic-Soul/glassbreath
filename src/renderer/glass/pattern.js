// Pure pattern logic (no three.js): which glass decoration a session earns, and its
// parameters. The shader in shaders.js draws it. Every vessel also gets a lip wrap.
import { breathFeatures, round } from './features.js';

export const PATTERNS = Object.freeze(['plain', 'thread', 'feather', 'filigrana', 'incalmo']);
export const MAX_PATTERN_BANDS = 16;
// Thresholds for choosing. Spread above these counts as "uneven" breathing.
export const PATTERN_RULES = Object.freeze({ depthStd: 0.14, paceCV: 0.2, longExhale: 1.5, slowMs: 8000 });

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Pick one main pattern from session features (from breathFeatures).
 *  uneven depth (around any trend) -> feather (combed waves)
 *  varied pace            -> incalmo (colour bands)
 *  steady + long exhales or slow pace -> filigrana (white lattice)
 *  steady otherwise       -> thread (one spiral turn per breath)
 * When depth and pace both vary, the one further past its threshold wins.
 */
export function choosePattern(f) {
  if (!f || !(f.n >= 1)) return 'plain';
  const fScore = f.n >= 3 ? f.depthJitter / PATTERN_RULES.depthStd : 0;
  const iScore = f.n >= 3 ? f.paceCV / PATTERN_RULES.paceCV : 0;
  if (Math.max(fScore, iScore) >= 1) return fScore >= iScore ? 'feather' : 'incalmo';
  if (f.exhaleRatio >= PATTERN_RULES.longExhale || f.meanMs >= PATTERN_RULES.slowMs) return 'filigrana';
  return 'thread';
}

/**
 * Full pattern spec for a finished vessel.
 * @param breaths committed breaths
 * @param form    buildVessel(breaths, { finish: 1 }).form
 * @param type    optional override (one of PATTERNS)
 */
export function patternFor(breaths, form, type = null) {
  const f = breathFeatures(breaths);
  const t = PATTERNS.includes(type) ? type : choosePattern(f);
  const edges = form.edges && form.edges.length > 1 ? form.edges : [0, 1];
  const lnEx = Math.abs(Math.log(f.exhaleRatio || 1));
  const ex = clamp((f.exhaleRatio - 1) / 1.1, 0, 1);
  // incalmo: each band's tint from its own pace (mostly) and depth, as -1..1
  const body = breaths.slice(0, MAX_PATTERN_BANDS);
  const shifts = body.map((b) => {
    const pace = (b.durationMs - f.meanMs) / Math.max(1, f.meanMs * Math.max(f.paceCV, 0.12));
    const dep = (b.depth - f.depth) / Math.max(0.12, f.depthStd);
    return clamp(0.7 * pace + 0.3 * dep, -1, 1);
  });
  return normalizePattern({
    type: t,
    edges,
    region: [form.y0 + 0.02, form.lipY - 0.05],
    lipY: form.lipY,
    width: lerp(0.011, 0.016, f.depth),
    amp: clamp(0.35 + 1.6 * f.depthStd + 0.35 * lnEx, 0.35, 1.1),
    combs: 2 * Math.round(clamp(2 + f.n * 0.25, 2, 5)),
    count: Math.round(clamp(18 + 8 * ex, 18, 26)),
    twist: lerp(0.6, 1.1, clamp(f.meanMs / 9000, 0, 1)),
    shifts,
    tone: f.depth >= 0.8 ? 'dark' : 'white',
  }, form.yTop);
}

/**
 * Validate a stored pattern. Missing or junk -> plain glass with a lip wrap near the
 * top of a vessel of height H (old recipes have no pattern at all).
 */
export function normalizePattern(p, H = 2) {
  const top = fin(H) && H > 0.3 ? H : 2;
  const o = p && typeof p === 'object' ? p : {};
  const type = PATTERNS.includes(o.type) ? o.type : 'plain';
  let edges = Array.isArray(o.edges) && o.edges.length >= 2 && o.edges.every(fin) ? o.edges.slice(0, MAX_PATTERN_BANDS + 1) : [0, 1];
  edges = edges.map((e) => clamp(e, 0, 1));
  for (let i = 1; i < edges.length; i++) edges[i] = Math.max(edges[i], edges[i - 1]);
  const region = Array.isArray(o.region) && o.region.length === 2 && o.region.every(fin) && o.region[1] > o.region[0]
    ? o.region : [0.12, top - 0.1];
  const lipY = fin(o.lipY) ? clamp(o.lipY, 0.1, top) : top - 0.05;
  const shifts = Array.isArray(o.shifts) ? o.shifts.slice(0, MAX_PATTERN_BANDS).map((v) => clamp(fin(v) ? v : 0, -1, 1)) : [];
  const n = (x, d, a, b) => round(clamp(fin(x) ? x : d, a, b), 4);
  return {
    type,
    edges: edges.map((e) => round(e, 4)),
    region: region.map((v) => round(v, 4)),
    lipY: round(lipY, 4),
    width: n(o.width, 0.02, 0.005, 0.06),
    amp: n(o.amp, 0.5, 0, 1.5),
    combs: 2 * Math.round(n(o.combs, 6, 2, 12) / 2),
    count: Math.round(n(o.count, 20, 4, 32)),
    twist: n(o.twist, 0.4, 0, 2),
    shifts: shifts.map((v) => round(v, 4)),
    tone: o.tone === 'dark' ? 'dark' : 'white', // thread colour: milk white or deep palette colour
  };
}
