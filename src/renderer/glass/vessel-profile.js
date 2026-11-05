// Pure vessel profile math (no three.js). Unit-tested by vessel-profile.test.mjs.
//
// A profile is a list of [r, y] pairs: radius from the vessel axis and height along it.
// y = 0 is the far end of the gather (the vessel's base once it stands upright) and the
// largest y is the mouth, where the blowpipe attaches. Each committed breath becomes one
// "band" of the body, built from the base toward the pipe.

export const PROFILE_POINTS = 48;
export const MAX_BANDS = 12;
export const RECIPE_VERSION = 1;
export const LIMITS = Object.freeze({ minR: 0.07, maxR: 1.12, pipeR: 0.05, maxHeight: 6 });

const GATHER_R = 0.34;
const GATHER_H = 0.38;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const smoothstep = (t) => t * t * (3 - 2 * t);

/** Clean up a breath record so every field is a finite, bounded number. */
export function normalizeBreath(b = {}) {
  const durationMs = Math.round(clamp(num(b.durationMs, 4000), 800, 20000));
  const inhaleMs = Math.round(clamp(num(b.inhaleMs, durationMs * 0.45), 200, durationMs));
  const exhaleMs = Math.round(clamp(num(b.exhaleMs, durationMs - inhaleMs), 200, 20000));
  return { depth: round(clamp(num(b.depth, 0.5), 0, 1), 4), durationMs, inhaleMs, exhaleMs };
}

/** Map one breath to a band: deeper = wider, longer = taller, longer exhale = smoother. */
export function bandFromBreath(b) {
  const n = normalizeBreath(b);
  return {
    r: lerp(0.34, 1.0, Math.pow(n.depth, 0.85)),
    h: lerp(0.15, 0.36, clamp((n.durationMs - 1800) / 8000, 0, 1)),
    smooth: clamp((n.exhaleMs - 700) / 5000, 0, 1),
  };
}

/**
 * Build the sparse control points of the vessel.
 * @param {object[]} breaths committed breaths (raw breathComplete-like objects)
 * @param {{live?: {swell:number, depth:number}|null, finish?: number}} opts
 *   live: the breath in progress (swell 0..1, peak-held by the caller)
 *   finish: 0 = hot on the pipe, 1 = cut and finished (flat base, open mouth)
 */
export function buildControls(breaths = [], { live = null, finish = 0 } = {}) {
  finish = clamp(num(finish, 0), 0, 1);
  const norm = breaths.map(normalizeBreath);
  const body = norm.slice(0, MAX_BANDS);
  const extra = norm.slice(MAX_BANDS);
  const bands = body.map(bandFromBreath);
  if (bands.length) bands[0].h = Math.max(bands[0].h + 0.12, GATHER_H); // bases are a little taller

  const swell = live ? clamp(num(live.swell, 0), 0, 1) : 0;
  if (live && bands.length < MAX_BANDS) {
    const first = bands.length === 0;
    const base = first ? GATHER_R : bands[bands.length - 1].r * 0.9;
    const tgt = Math.max(base, bandFromBreath({ depth: num(live.depth, 0.5) }).r);
    const e = smoothstep(swell);
    bands.push({
      r: lerp(base, tgt, e),
      h: first ? lerp(GATHER_H, 0.46, e) : lerp(0.05, 0.26, e),
      smooth: 1,
      live: true,
    });
  } else if (live && extra.length === 0 && bands.length >= MAX_BANDS) {
    // Full body: the live breath swells the shoulder a little.
    bands[bands.length - 1].r *= 1 + 0.04 * smoothstep(swell);
  }
  if (!bands.length) bands.push({ r: GATHER_R, h: GATHER_H, smooth: 0 });

  // Soften neighbouring committed bands so random depths read as a flowing form.
  const raw = bands.map((b) => b.r);
  for (let k = 1; k < bands.length - 1; k++) {
    if (bands[k].live || bands[k + 1].live) continue;
    bands[k].r = 0.5 * raw[k] + 0.25 * (raw[k - 1] + raw[k + 1]);
  }
  // Neighbour clamp keeps slopes plausible (no sudden shelves).
  for (let k = 1; k < bands.length; k++) {
    const prev = bands[k - 1].r;
    const step = 0.9 * bands[k].h;
    bands[k].r = clamp(bands[k].r, prev - step, prev + step);
  }
  for (const b of bands) b.r = clamp(b.r, LIMITS.minR * 2, LIMITS.maxR);

  // Neck: from the last band toward the pipe / mouth.
  const tail = bands.slice(-3);
  const tailR = avg(tail.map((b) => b.r));
  let neckRatio = lerp(0.32, 0.82, clamp((tailR - 0.34) / 0.66, 0, 1));
  let neckLen = lerp(0.24, 0.5, avg(tail.map((b) => b.smooth)));
  if (extra.length) {
    const w = Math.min(1, extra.length / 4) * 0.7;
    const eb = extra.map(bandFromBreath);
    neckRatio = lerp(neckRatio, lerp(0.22, 0.9, avg(extra.map((x) => x.depth))), w);
    neckLen = lerp(neckLen, lerp(0.3, 0.85, avg(eb.map((x) => x.smooth))), w);
  }
  neckLen *= clamp(bands.length / 4, 0.55, 1);
  const rLast = bands[bands.length - 1].r;
  const rNeck = clamp(rLast * neckRatio, 0.12, 0.85);
  const lastDepth = body.length ? body[body.length - 1].depth : 0.5;
  const mouthOpen = rNeck * lerp(1.03, 1.2, lastDepth);
  const mouth = lerp(LIMITS.pipeR + 0.035, mouthOpen, smoothstep(finish));

  const flatK = lerp(0.3, 0.62, finish);
  const pts = [[0, 0], [bands[0].r * flatK, 0]];
  let y = 0.05 + 0.1 * bands[0].r;
  const rings = [];
  for (let k = 0; k < bands.length; k++) {
    const b = bands[k];
    if (k === 0) {
      // rounded heel so the gather reads as an egg, not a kite
      pts.push([b.r * lerp(0.8, 0.94, finish), y + b.h * 0.12]);
      pts.push([b.r, y + b.h * 0.55]);
    } else pts.push([b.r, y + b.h / 2]);
    y += b.h;
    const next = bands[k + 1];
    // a faint ring where one breath meets the next (sharper exhale = clearer ring);
    // applied after smoothing so it stays a fine line instead of a ribbed bulge
    if (next && !b.live && !next.live) rings.push({ y, depth: 0.006 + 0.016 * (1 - b.smooth) });
  }
  pts.push([lerp(rLast, rNeck, 0.85), y + neckLen * 0.5]);
  pts.push([mouth, y + neckLen]);
  return { controls: pts, rings, height: y + neckLen, bandCount: bands.length };
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
  // arc-length resample
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

/** Breaths (+ live breath) -> smooth outer profile of PROFILE_POINTS [r, y] pairs. */
export function buildProfile(breaths = [], opts = {}) {
  const { controls, rings } = buildControls(breaths, opts);
  const p = sampleCurve(controls, opts.points ?? PROFILE_POINTS);
  // Laplacian relax on radius so bands flow into one blown form, leaving the base
  // and mouth exact. A wider kernel on the body, a light one near the ends.
  for (let pass = 0; pass < 3; pass++) {
    const r = p.map((q) => q[0]);
    for (let i = 3; i < p.length - 3; i++) {
      p[i][0] = (r[i - 2] + 4 * r[i - 1] + 6 * r[i] + 4 * r[i + 1] + r[i + 2]) / 16;
    }
    p[2][0] = 0.25 * r[1] + 0.5 * r[2] + 0.25 * r[3];
    p[p.length - 3][0] = 0.25 * r[p.length - 4] + 0.5 * r[p.length - 3] + 0.25 * r[p.length - 2];
  }
  for (const ring of rings) {
    for (let i = 2; i < p.length - 2; i++) {
      const t = (p[i][1] - ring.y) / 0.07;
      p[i][0] *= 1 - ring.depth * Math.exp(-t * t);
    }
  }
  return clampProfile(p);
}

export function profileHeight(profile) {
  return profile.length ? profile[profile.length - 1][1] : 0;
}

export function profileMaxR(profile) {
  return profile.reduce((m, p) => Math.max(m, p[0]), 0);
}

/**
 * Outer profile -> closed wall profile for a lathe: outer surface up, a rounded lip,
 * then the inner surface back down to the axis. Length = 2 * outer.length + 2.
 */
export function wallProfile(outer, { wall = 0.034, base = 0.1 } = {}) {
  const n = outer.length;
  const normals = outer.map((_, i) => {
    const a = outer[Math.max(0, i - 1)], b = outer[Math.min(n - 1, i + 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dr, dy) || 1;
    return [dy / len, -dr / len];
  });
  // soft max against the base so the inside floor curves into the wall (no boxy corner)
  const smax = (a, b, k) => {
    const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
    return lerp(a, b, h) + k * h * (1 - h);
  };
  const inner = outer.map(([r, y], i) => {
    const [nr, ny] = normals[i];
    return [Math.max(0.003, r - wall * nr), smax(base, y - wall * ny, 0.12)];
  });
  // inner must stay inside the outer wall and descend monotonically when reversed
  for (let i = 0; i < n; i++) inner[i][0] = Math.min(inner[i][0], Math.max(0.003, outer[i][0] - wall * 0.4));
  for (let i = n - 2; i >= 0; i--) inner[i][1] = Math.min(inner[i][1], inner[i + 1][1]);
  inner[0] = [0, base];
  const [rT, yT] = outer[n - 1];
  const [rI, yI] = inner[n - 1];
  const lift = wall * 0.45;
  const lip = [
    [lerp(rT, rI, 0.2), Math.max(yT, yI) + lift * 0.8],
    [lerp(rT, rI, 0.8), Math.max(yT, yI) + lift * 0.8],
  ];
  return [...outer.map((p) => [p[0], p[1]]), ...lip, ...inner.reverse()];
}

function round(v, d) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** Rare surface finishes. Anything else (including a missing field) means plain glass. */
export const FINISHES = Object.freeze(['gold', 'crackle', 'opal']);
export const normalizeFinish = (f) => (FINISHES.includes(f) ? f : null);

/** Plain JSON recipe that fully rebuilds a vessel. */
export function makeRecipe({ profile, palette = null, breaths = [], finish = null, createdAt } = {}) {
  if (!Array.isArray(profile) || profile.length < 8) throw new Error('profile missing');
  return {
    version: RECIPE_VERSION,
    profile: profile.map(([r, y]) => [round(r, 4), round(y, 4)]),
    palette: palette ? { ...palette } : null,
    breaths: breaths.map(normalizeBreath),
    finish: normalizeFinish(finish),
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
  clampProfile(profile);
  return {
    version: RECIPE_VERSION,
    profile: profile.map(([r, y]) => [round(r, 4), round(y, 4)]),
    palette: obj.palette && typeof obj.palette === 'object' ? { ...obj.palette } : null,
    breaths: Array.isArray(obj.breaths) ? obj.breaths.map(normalizeBreath) : [],
    finish: normalizeFinish(obj.finish), // optional: older recipes have none
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date(0).toISOString(),
  };
}
