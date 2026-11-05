// Pure vessel profile math (no three.js). Unit-tested by vessel-profile.test.mjs.
//
// A profile is a list of [r, y] pairs: radius from the vessel axis and height along it.
// y = 0 is the base and the largest y is the mouth, where the blowpipe attaches.
//
// The whole session decides one smooth form (see vesselForm). While hot it is a gather
// on the pipe; finish 0..1 morphs it into the finished vessel with a foot, neck and lip.
// Both outlines use the same point layout (foot section, then body), so the morph is clean.
import { normalizeBreath, breathFeatures, mean, round } from './features.js';
import { normalizePattern } from './pattern.js';

export { normalizeBreath, breathFeatures };
export const PROFILE_POINTS = 72;
export const FOOT_POINTS = 14; // outer points from the axis to the top of the foot
export const LIP_POINTS = 7; // rolled lip bead between the outer and inner wall
export const MAX_BANDS = 12;
export const RECIPE_VERSION = 1;
export const LIMITS = Object.freeze({ minR: 0.07, maxR: 1.12, pipeR: 0.05, maxHeight: 6 });

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const smoothstep = (t) => t * t * (3 - 2 * t);
const sat = (v) => clamp(v, 0, 1);

/**
 * Breaths (+ live breath) -> form parameters.
 *  depth   -> belly width (deep = full, shallow = slim)
 *  count   -> height (few = bowl or jar, many = tall vase)
 *  trend   -> where the widest point sits (deepening = high shoulder, easing = low belly)
 *  exhale/inhale -> neck length and slenderness (long exhales = long elegant neck)
 *  depth spread  -> organic swells along the body
 */
export function vesselForm(breaths = [], { live = null } = {}) {
  const norm = breaths.map(normalizeBreath);
  const f = breathFeatures(norm);
  const s = live ? sat(num(live.swell, 0)) : 0;
  const liveDepth = live ? sat(num(live.depth, 0.5)) : 0.5;
  const n = f.n;
  const nEff = Math.min(n, MAX_BANDS) + s * (n < MAX_BANDS ? 1 : 0.3);
  const depth = n + s > 0 ? (f.depth * n + liveDepth * s) / (n + s) : 0.5;

  const Rb = lerp(0.42, 1.04, Math.pow(depth, 0.9));
  const extra = Math.max(0, n - MAX_BANDS);
  const pace = sat((f.meanMs - 3000) / 7000);
  const H = (0.82 + 0.235 * nEff + 0.03 * Math.min(extra, 10)) * lerp(0.93, 1.08, pace);
  const bowl = sat((4.5 - nEff) / 3); // 1 for one or two breaths, 0 from about five
  const ex = sat((f.exhaleRatio - 1) / 1.1);
  const neckFrac = lerp(0.12 + 0.17 * ex, 0.07, bowl);
  const rN = Math.max(0.15, Rb * lerp(lerp(0.6, 0.36, ex), 0.84, bowl));
  const rLip = rN * lerp(lerp(1.14, 1.32, ex), 1.08, bowl);
  const tb = lerp(clamp(0.45 + 0.3 * clamp(f.trend / 0.35, -1, 1), 0.18, 0.74), 0.5, bowl);
  const footR = clamp(Rb * lerp(0.56, 0.46, sat((Rb - 0.45) / 0.55)), 0.22, 0.5);

  // organic swells: each breath's depth (lightly smoothed) against the mean, placed by timing
  const body = norm.slice(0, 16);
  const total = body.reduce((a, b) => a + b.durationMs, 0) || 1;
  let acc = 0;
  const devs = body.map((b, i) => {
    const t = (acc + b.durationMs / 2) / total;
    acc += b.durationMs;
    const nb = [body[i - 1], b, body[i + 1]].filter(Boolean);
    const d = mean(nb.map((x, k) => x.depth * (x === b ? 2 : 1))) * nb.length / (nb.length + 1);
    return { t, d: d - f.depth };
  });
  const edges = [0];
  acc = 0;
  for (const b of body) { acc += b.durationMs; edges.push(acc / total); }
  return { n, nEff, swell: s, depth, Rb, H, rN, rLip, tb, neckFrac, footR, devs, edges, bowl };
}

// Monotone cubic (Fritsch-Carlson) through knots [[x, y], ...]: smooth, no overshoot.
function monotone(knots) {
  const n = knots.length;
  const xs = knots.map((k) => k[0]), ys = knots.map((k) => k[1]);
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** Evenly resample a dense polyline by arc length into n points (ends kept). */
function resample(dense, n) {
  const acc = [0];
  for (let i = 1; i < dense.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  }
  const total = acc[acc.length - 1];
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (total * k) / (n - 1);
    while (j < acc.length - 2 && acc[j + 1] < s) j++;
    const seg = acc[j + 1] - acc[j] || 1;
    const t = clamp((s - acc[j]) / seg, 0, 1);
    out.push([lerp(dense[j][0], dense[j + 1][0], t), lerp(dense[j][1], dense[j + 1][1], t)]);
  }
  return out;
}

/** Key heights of the finished vessel, for the outline and for the pattern. */
export function formHeights(F) {
  const footH = 0.05 + 0.015 * F.footR;
  const y0 = footH + 0.07; // top of the stem where the body starts
  const yTop = Math.max(F.H, y0 + 0.5);
  const neckH = Math.max(0.12, (yTop - y0) * F.neckFrac);
  const yNeck0 = yTop - neckH;
  return { footH, y0, yTop, yNeck0, yNeckMin: yNeck0 + neckH * 0.5, lipY: yTop - 0.028 };
}

// Radius along the body, from the stem (y0) to the lip (yTop), with organic swells.
function bodyRadius(F, Y, { round: rounder = false } = {}) {
  const { y0, yTop, yNeck0, yNeckMin } = Y;
  const rS = rounder ? F.Rb * 0.8 : F.footR * 0.8;
  const yB = y0 + (yNeck0 - y0) * F.tb;
  const rNeck0 = lerp(F.rN, F.Rb, 0.12 + 0.18 * F.bowl);
  const knots = [
    [y0, rS],
    // deep breaths fill the belly out toward a globe, shallow ones keep it a slim ovoid
    [y0 + (yB - y0) * 0.45, lerp(rS, F.Rb, rounder ? 0.9 : lerp(0.7, 0.9, F.depth))],
    [yB, F.Rb],
    [yB + (yNeck0 - yB) * 0.55, lerp(F.Rb, rNeck0, lerp(0.5, 0.3, F.depth))],
    [yNeck0, rNeck0],
    [yNeckMin, F.rN],
    [yTop, F.rLip],
  ];
  for (let i = 1; i < knots.length; i++) knots[i][0] = Math.max(knots[i][0], knots[i - 1][0] + 0.02);
  const base = monotone(knots);
  const sigma = 0.16;
  return (y) => {
    let r = base(y);
    const t = (y - y0) / Math.max(1e-3, yNeck0 - y0);
    if (F.devs.length > 1 && t > 0 && t < 1) {
      let w = 0, v = 0;
      for (const d of F.devs) { const g = Math.exp(-(((t - d.t) / sigma) ** 2)); w += g; v += g * d.d; }
      r *= 1 + 0.55 * (v / Math.max(w, 1e-6)) * Math.sqrt(Math.sin(Math.PI * t));
    }
    return r;
  };
}

/** Finished outline: stepped foot, flowing body, neck and flared lip. */
function finishedOutline(F, n) {
  const Y = formHeights(F);
  const fr = F.footR, rS = fr * 0.8;
  const foot = sampleCurve([
    [0, 0], [fr * 0.5, 0], [fr * 0.86, 0], [fr * 0.97, 0.008], [fr, 0.026],
    [fr * 0.985, Y.footH * 0.8], [fr * 0.93, Y.footH], [fr * 0.84, Y.footH + 0.014],
    [rS * 0.97, Y.footH + 0.04], [rS, Y.y0],
  ], FOOT_POINTS);
  const R = bodyRadius(F, Y);
  const dense = [];
  for (let k = 0; k <= 320; k++) { const y = lerp(Y.y0, Y.yTop, k / 320); dense.push([R(y), y]); }
  const body = resample(dense, n - FOOT_POINTS + 1).slice(1);
  return [...foot, ...body];
}

/** Hot outline: a round gather that closes onto the pipe. */
function hotOutline(F, n) {
  const Y = formHeights(F);
  const Hh = 0.72 + 0.2 * F.nEff;
  const scale = lerp(0.34, F.Rb * 0.88, sat(F.nEff / 2.5)) / F.Rb;
  const R = bodyRadius(F, Y, { round: true });
  const at = (u) => {
    let r = R(lerp(Y.y0, Y.yNeck0, Math.min(u / 0.86, 1))) * scale * (1 + 0.05 * F.swell);
    const cap = Math.min(0.45, 0.32 / Math.max(0.5, Hh) + 0.18); // rounder end on a small gather
    if (u < cap) r *= Math.sqrt(Math.max(0, 1 - (1 - u / cap) ** 2));
    // round shoulder that closes onto the pipe like a real gather
    if (u > 0.45) { const k = (u - 0.45) / 0.55; r *= Math.pow(Math.max(0, 1 - k * k), 0.6); }
    r = Math.max(r, u > 0.5 ? LIMITS.pipeR + 0.035 : 0);
    return [r, u * Hh];
  };
  const dense = (u0, u1, k) => Array.from({ length: k + 1 }, (_, i) => at(lerp(u0, u1, i / k)));
  const split = 0.14;
  return [...resample(dense(0, split, 60), FOOT_POINTS), ...resample(dense(split, 1, 300), n - FOOT_POINTS + 1).slice(1)];
}

/**
 * Breaths (+ live breath) -> { profile, form }.
 * @param {{live?: {swell:number, depth:number}|null, finish?: number, points?: number}} opts
 *   live: the breath in progress (swell 0..1, peak-held by the caller)
 *   finish: 0 = hot gather on the pipe, 1 = cut and finished
 */
export function buildVessel(breaths = [], { live = null, finish = 0, points = PROFILE_POINTS } = {}) {
  finish = sat(num(finish, 0));
  const F = vesselForm(breaths, { live });
  const e = smoothstep(finish);
  let p;
  if (e >= 1) p = finishedOutline(F, points);
  else if (e <= 0) p = hotOutline(F, points);
  else {
    const a = hotOutline(F, points), b = finishedOutline(F, points);
    p = a.map((q, i) => [lerp(q[0], b[i][0], e), lerp(q[1], b[i][1], e)]);
  }
  return { profile: clampProfile(p), form: { ...F, ...formHeights(F) } };
}

/** Breaths (+ live breath) -> smooth outer profile of PROFILE_POINTS [r, y] pairs. */
export function buildProfile(breaths = [], opts = {}) {
  return buildVessel(breaths, opts).profile;
}

/** Centripetal Catmull-Rom through points, then resample evenly by arc length. */
export function sampleCurve(controls, n = PROFILE_POINTS) {
  const P = controls.map(([r, y]) => [r, y]);
  if (P.length < 2) throw new Error('need at least two control points');
  const first = [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]];
  const l = P.length - 1;
  const last = [2 * P[l][0] - P[l - 1][0], 2 * P[l][1] - P[l - 1][1]];
  const Q = [first, ...P, last];
  const dense = [];
  const per = 10;
  for (let i = 1; i < Q.length - 2; i++) {
    const [p0, p1, p2, p3] = [Q[i - 1], Q[i], Q[i + 1], Q[i + 2]];
    const d = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    for (let s = 0; s < per; s++) {
      const t = t1 + ((t2 - t1) * s) / per;
      dense.push(cr(p0, p1, p2, p3, 0, t1, t2, t3, t));
    }
  }
  dense.push(P[l]);
  return resample(dense, n);
}

function cr(p0, p1, p2, p3, t0, t1, t2, t3, t) {
  const L = (a, b, ta, tb) => {
    const w = tb - ta || 1e-6;
    return [((tb - t) * a[0] + (t - ta) * b[0]) / w, ((tb - t) * a[1] + (t - ta) * b[1]) / w];
  };
  const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
  const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
  return L(B1, B2, t1, t2);
}

/** Clamp a sampled profile so it can never look broken. Mutates and returns it. */
export function clampProfile(profile) {
  let yMax = 0;
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    p[1] = clamp(Math.max(p[1], yMax), 0, LIMITS.maxHeight);
    yMax = p[1];
    p[0] = clamp(p[0], 0, LIMITS.maxR);
    if (i > 0 && p[1] > 0.04) p[0] = Math.max(p[0], LIMITS.minR * 0.7);
  }
  profile[0][0] = 0;
  profile[0][1] = 0;
  return profile;
}

export function profileHeight(profile) {
  return profile.length ? profile[profile.length - 1][1] : 0;
}

export function profileMaxR(profile) {
  return profile.reduce((m, p) => Math.max(m, p[0]), 0);
}

/**
 * Outer profile -> closed wall profile for a lathe: outer surface up, a rolled lip
 * bead, then the inner surface back down to the axis. The inside floor sits at `base`,
 * so a foot stays solid glass. Length = 2 * outer.length + LIP_POINTS.
 */
export function wallProfile(outer, { wall = 0.04, base = 0.1 } = {}) {
  const n = outer.length;
  const H = outer[n - 1][1] || 1;
  const normals = outer.map((_, i) => {
    const a = outer[Math.max(0, i - 1)], b = outer[Math.min(n - 1, i + 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dr, dy) || 1;
    return [dy / len, -dr / len];
  });
  // a little thicker low down and at the rim, like a real blown wall
  const wAt = (y) => wall * (1.25 - 0.4 * clamp(y / H, 0, 1) + 0.5 * smoothstep(clamp((y / H - 0.9) / 0.1, 0, 1)));
  const inner = outer.map(([r, y], i) => {
    const [nr, ny] = normals[i];
    const w = wAt(y);
    return [Math.max(0.003, Math.min(r - w * nr, r - w * 0.4)), y - w * ny];
  });
  // floor: everything below the base becomes a gently dished floor into the wall
  let k = inner.findIndex((p, i) => i > 0 && p[1] >= base + 0.04);
  if (k < 1) k = Math.max(1, Math.floor(n / 4));
  const [rk, yk] = inner[k];
  for (let i = 0; i < k; i++) {
    const t = i / k;
    inner[i] = [rk * t, base + (yk - base) * t * t * t];
  }
  for (let i = n - 2; i >= 0; i--) inner[i][1] = Math.min(inner[i][1], inner[i + 1][1]);
  for (let i = 0; i < n; i++) inner[i][0] = Math.max(0, Math.min(inner[i][0], outer[i][0] - 0.003));
  inner[0] = [0, Math.min(base, inner[1][1])];
  // rolled lip: a rounded bead a touch wider than the wall
  const [rT, yT] = outer[n - 1];
  const [rI, yI] = inner[n - 1];
  const cx = (rT + rI) / 2, cy = Math.max(yT, yI);
  const hw = Math.max(0.006, (rT - rI) / 2);
  const lip = [];
  for (let j = 1; j <= LIP_POINTS; j++) {
    const a = (Math.PI * j) / (LIP_POINTS + 1);
    lip.push([cx + hw * 1.15 * Math.cos(a), cy + hw * 1.1 * Math.sin(a)]);
  }
  return [...outer.map((p) => [p[0], p[1]]), ...lip, ...inner.reverse()];
}

/** Rare surface finishes. Anything else (including a missing field) means plain glass. */
export const FINISHES = Object.freeze(['gold', 'crackle', 'opal']);
export const normalizeFinish = (f) => (FINISHES.includes(f) ? f : null);

/** Plain JSON recipe that fully rebuilds a vessel. */
export function makeRecipe({ profile, palette = null, breaths = [], finish = null, pattern = null, createdAt } = {}) {
  if (!Array.isArray(profile) || profile.length < 8) throw new Error('profile missing');
  const prof = profile.map(([r, y]) => [round(r, 4), round(y, 4)]);
  return {
    version: RECIPE_VERSION,
    profile: prof,
    palette: palette ? { ...palette } : null,
    breaths: breaths.map(normalizeBreath),
    finish: normalizeFinish(finish),
    pattern: normalizePattern(pattern, profileHeight(prof)),
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

/** Validate + normalise a recipe (object or JSON string). Throws on garbage. */
export function parseRecipe(input) {
  const obj = typeof input === 'string' ? JSON.parse(input) : input;
  if (!obj || typeof obj !== 'object') throw new Error('recipe must be an object');
  if (obj.version !== RECIPE_VERSION) throw new Error(`unsupported recipe version ${obj.version}`);
  let profile = Array.isArray(obj.profile) ? obj.profile : null;
  if (!profile || profile.length < 8) {
    if (Array.isArray(obj.breaths)) profile = buildProfile(obj.breaths, { finish: 1 });
    else throw new Error('recipe has no profile');
  }
  profile = profile.map((p) => {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error('bad profile point');
    return [p[0], p[1]];
  });
  // older recipes used fewer points: resample so the stage's fixed mesh fits
  if (profile.length !== PROFILE_POINTS) profile = resample(profile, PROFILE_POINTS);
  clampProfile(profile);
  const prof = profile.map(([r, y]) => [round(r, 4), round(y, 4)]);
  return {
    version: RECIPE_VERSION,
    profile: prof,
    palette: obj.palette && typeof obj.palette === 'object' ? { ...obj.palette } : null,
    breaths: Array.isArray(obj.breaths) ? obj.breaths.map(normalizeBreath) : [],
    finish: normalizeFinish(obj.finish), // optional: older recipes have none
    pattern: normalizePattern(obj.pattern, profileHeight(prof)), // optional: plain + lip wrap
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date(0).toISOString(),
  };
}
