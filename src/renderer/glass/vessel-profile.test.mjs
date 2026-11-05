import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfile, buildVessel, vesselForm, wallProfile, makeRecipe, parseRecipe, normalizeBreath, normalizeFinish,
  profileHeight, profileMaxR, PROFILE_POINTS, FOOT_POINTS, LIP_POINTS, MAX_BANDS, LIMITS,
} from './vessel-profile.js';
import { breathFeatures } from './features.js';
import { choosePattern, patternFor, normalizePattern, PATTERNS } from './pattern.js';
import { SAMPLES, sampleRecipe } from './samples.js';
import { paletteFor } from './palette.js';

const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function randomBreaths(n, seed) {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const durationMs = 1500 + r() * 9000;
    const inhaleMs = durationMs * (0.3 + r() * 0.3);
    return { depth: r(), durationMs, inhaleMs, exhaleMs: durationMs - inhaleMs };
  });
}

function assertSane(p) {
  assert.equal(p.length, PROFILE_POINTS);
  assert.deepEqual(p[0], [0, 0]);
  for (let i = 0; i < p.length; i++) {
    const [r, y] = p[i];
    assert.ok(Number.isFinite(r) && Number.isFinite(y), `finite at ${i}`);
    assert.ok(r >= 0 && r <= LIMITS.maxR + 1e-9, `r clamp at ${i}: ${r}`);
    if (i > 0) assert.ok(y >= p[i - 1][1], `monotonic y at ${i}`);
  }
}

test('empty gather is a small closed blob', () => {
  const p = buildProfile([]);
  assertSane(p);
  assert.ok(profileMaxR(p) > 0.25 && profileMaxR(p) < 0.5);
  assert.ok(profileHeight(p) > 0.3 && profileHeight(p) < 1.2);
});

test('each breath makes the gather and the finished vessel taller', () => {
  const breaths = randomBreaths(MAX_BANDS, 7);
  let prevHot = 0, prevDone = 0;
  for (let k = 0; k <= breaths.length; k++) {
    const hot = profileHeight(buildProfile(breaths.slice(0, k)));
    const done = profileHeight(buildProfile(breaths.slice(0, k), { finish: 1 }));
    assert.ok(hot > prevHot - 1e-9, `hot height grows at ${k}`);
    if (k > 0) assert.ok(done > prevDone - 1e-9, `finished height grows at ${k}`);
    prevHot = hot; prevDone = done;
  }
});

test('finished vessel stands on a stepped foot and has a neck and flared lip', () => {
  for (let s = 1; s < 20; s++) {
    const { profile: p, form } = buildVessel(randomBreaths(3 + (s % 9), s), { finish: 1 });
    const foot = p.slice(0, FOOT_POINTS);
    const footR = Math.max(...foot.map((q) => q[0]));
    const waist = p[FOOT_POINTS - 1][0];
    assert.ok(waist < footR * 0.9, `seed ${s}: stem narrower than foot`);
    assert.equal(p[1][1], 0, 'flat underside');
    const body = p.slice(FOOT_POINTS);
    const belly = Math.max(...body.map((q) => q[0]));
    assert.ok(belly > footR * 1.4, `seed ${s}: belly wider than foot`);
    const top = p[p.length - 1][0];
    const neckMin = Math.min(...p.filter((q) => q[1] > form.yNeck0).map((q) => q[0]));
    assert.ok(top > neckMin * 1.03, `seed ${s}: lip flares`);
  }
});

test('breathing decides the form', () => {
  const even = (n, b) => Array.from({ length: n }, () => ({ durationMs: 5000, inhaleMs: 2200, exhaleMs: 2800, ...b }));
  // count -> height
  assert.ok(profileHeight(buildProfile(even(10, {}), { finish: 1 })) > profileHeight(buildProfile(even(3, {}), { finish: 1 })) * 1.6);
  // long exhales -> longer, slimmer neck
  const short = vesselForm(even(8, { inhaleMs: 2500, exhaleMs: 2500 }));
  const long = vesselForm(even(8, { inhaleMs: 1600, exhaleMs: 3400 }));
  assert.ok(long.neckFrac > short.neckFrac + 0.08 && long.rN < short.rN);
  // deepening -> widest point higher than easing off
  const ramp = (a, b) => Array.from({ length: 8 }, (_, i) => ({ depth: a + ((b - a) * i) / 7, durationMs: 5000 }));
  assert.ok(vesselForm(ramp(0.3, 0.9)).tb > vesselForm(ramp(0.9, 0.3)).tb + 0.3);
});

test('clamps hold for extreme and garbage input', () => {
  const extreme = [
    { depth: 1, durationMs: 1e9 }, { depth: 0, durationMs: 1 }, { depth: 1, durationMs: 900 },
    { depth: NaN, durationMs: 'x' }, { depth: -5 }, { depth: 99, exhaleMs: -3 },
    ...randomBreaths(20, 3),
  ];
  for (const finish of [0, 0.5, 1]) {
    const p = buildProfile(extreme, { finish, live: { swell: 1, depth: 1 } });
    assertSane(p);
    assert.ok(profileHeight(p) < LIMITS.maxHeight);
  }
});

test('profiles are smooth (bounded second difference)', () => {
  for (let s = 1; s < 40; s++) {
    const p = buildProfile(randomBreaths(10, s), { finish: 1 });
    assertSane(p);
    for (let i = 1; i < p.length - 1; i++) {
      const d2 = Math.abs(p[i + 1][0] - 2 * p[i][0] + p[i - 1][0]);
      if (i > FOOT_POINTS) assert.ok(d2 < 0.06, `seed ${s} point ${i} d2=${d2}`); // body: no bumps
    }
  }
});

test('deeper breaths make a wider vessel', () => {
  const shallow = Array.from({ length: 8 }, () => ({ depth: 0.15, durationMs: 4000 }));
  const deep = Array.from({ length: 8 }, () => ({ depth: 0.95, durationMs: 4000 }));
  assert.ok(profileMaxR(buildProfile(deep)) > profileMaxR(buildProfile(shallow)) + 0.3);
});

test('live swell widens the current band, cut opens the mouth', () => {
  const b = randomBreaths(4, 11);
  const rest = buildProfile(b, { live: { swell: 0, depth: 0.9 } });
  const full = buildProfile(b, { live: { swell: 1, depth: 0.9 } });
  assert.ok(profileHeight(full) > profileHeight(rest));
  const hot = buildProfile(b, { finish: 0 });
  const done = buildProfile(b, { finish: 1 });
  assert.ok(done[done.length - 1][0] > hot[hot.length - 1][0]);
});

test('wall profile closes back to the axis inside the outer wall', () => {
  const outer = buildProfile(randomBreaths(9, 5), { finish: 1 });
  const w = wallProfile(outer);
  assert.equal(w.length, outer.length * 2 + LIP_POINTS);
  const inner = w.slice(outer.length + LIP_POINTS);
  assert.equal(inner[inner.length - 1][0], 0);
  for (let i = 1; i < inner.length; i++) assert.ok(inner[i][1] <= inner[i - 1][1] + 1e-9, 'inner descends');
  for (const [r] of w) assert.ok(r >= 0);
});

test('recipe round-trips exactly through JSON', () => {
  const breaths = randomBreaths(11, 21);
  const profile = buildProfile(breaths, { finish: 1 });
  const palette = paletteFor({ breathRate: 9, pulse: 66 });
  const recipe = makeRecipe({ profile, palette, breaths, createdAt: '2026-11-05T00:00:00.000Z' });
  const back = parseRecipe(JSON.stringify(recipe));
  assert.deepEqual(back, recipe);
  assert.deepEqual(parseRecipe(back), recipe);
  // rounding error is tiny
  for (let i = 0; i < profile.length; i++) {
    assert.ok(Math.abs(back.profile[i][0] - profile[i][0]) < 1e-4);
  }
  // breaths alone rebuild the same shape
  const rebuilt = buildProfile(back.breaths, { finish: 1 });
  for (let i = 0; i < profile.length; i++) assert.ok(Math.abs(rebuilt[i][1] - profile[i][1]) < 1e-3);
  assert.throws(() => parseRecipe({ version: 99 }));
  assert.throws(() => parseRecipe('{"version":1,"profile":[[1,"a"]]}'));
});

test('recipe finish round-trips and is optional', () => {
  const profile = buildProfile(randomBreaths(5, 4), { finish: 1 });
  for (const finish of ['gold', 'crackle', 'opal']) {
    const recipe = makeRecipe({ profile, finish, createdAt: '2026-11-05T00:00:00.000Z' });
    assert.equal(recipe.finish, finish);
    assert.deepEqual(parseRecipe(JSON.stringify(recipe)), recipe);
  }
  assert.equal(makeRecipe({ profile }).finish, null);
  // unknown or junk values become plain glass
  for (const bad of ['platinum', 'GOLD', 3, {}, '']) {
    assert.equal(makeRecipe({ profile, finish: bad }).finish, null);
    assert.equal(parseRecipe({ ...makeRecipe({ profile }), finish: bad }).finish, null);
  }
  // a version 1 recipe saved before finishes existed still parses
  const old = makeRecipe({ profile });
  delete old.finish;
  assert.equal(parseRecipe(JSON.stringify(old)).finish, null);
  assert.equal(normalizeFinish(undefined), null);
});

test('pattern choice follows the breathing', () => {
  const base = { n: 8, depth: 0.6, depthStd: 0.02, depthJitter: 0.02, trend: 0, exhaleRatio: 1.25, paceCV: 0.03, meanMs: 5000 };
  assert.equal(choosePattern(base), 'thread');
  assert.equal(choosePattern({ ...base, exhaleRatio: 1.8 }), 'filigrana');
  assert.equal(choosePattern({ ...base, meanMs: 9500 }), 'filigrana');
  assert.equal(choosePattern({ ...base, depthJitter: 0.2, depthStd: 0.2 }), 'feather');
  assert.equal(choosePattern({ ...base, paceCV: 0.3 }), 'incalmo');
  // both uneven: the one further past its threshold wins
  assert.equal(choosePattern({ ...base, depthJitter: 0.3, paceCV: 0.22 }), 'feather');
  assert.equal(choosePattern({ ...base, depthJitter: 0.15, paceCV: 0.5 }), 'incalmo');
  // a steady deepening is a trend, not unevenness
  assert.equal(choosePattern({ ...base, depthStd: 0.2, depthJitter: 0.02, trend: 0.6 }), 'thread');
  assert.equal(choosePattern({ n: 0 }), 'plain');
  assert.equal(choosePattern(null), 'plain');
});

test('pattern spec records breath timing and stays bounded', () => {
  const breaths = [{ durationMs: 3000 }, { durationMs: 9000 }, { durationMs: 6000 }].map(normalizeBreath);
  const { form } = buildVessel(breaths, { finish: 1 });
  const p = patternFor(breaths, form);
  assert.deepEqual(p.edges, [0, 0.1667, 0.6667, 1]);
  assert.ok(p.region[0] < p.region[1] && p.region[1] < p.lipY && p.lipY < profileHeight(buildProfile(breaths, { finish: 1 })));
  assert.equal(p.shifts.length, 3);
  for (const t of PATTERNS) assert.equal(patternFor(breaths, form, t).type, t);
  assert.deepEqual(normalizePattern(p), p, 'idempotent');
  const junk = normalizePattern({ type: 'paisley', edges: [0.5, 'x'], width: 9, combs: 3, shifts: [5, NaN] }, 3);
  assert.equal(junk.type, 'plain');
  assert.deepEqual(junk.edges, [0, 1]);
  assert.ok(junk.width <= 0.06 && junk.combs % 2 === 0);
  assert.equal(normalizePattern(null, 3).lipY, 2.95);
});

test('recipe pattern round-trips; old recipes become plain with a lip wrap', () => {
  const breaths = randomBreaths(7, 9);
  const { profile, form } = buildVessel(breaths, { finish: 1 });
  const pattern = patternFor(breaths, form, 'feather');
  const recipe = makeRecipe({ profile, breaths, pattern, createdAt: '2026-11-05T00:00:00.000Z' });
  assert.deepEqual(parseRecipe(JSON.stringify(recipe)), recipe);
  assert.equal(recipe.pattern.type, 'feather');
  // a version 1 recipe from before patterns, with the old 48-point profile
  const old = { version: 1, profile: buildProfile(breaths, { finish: 1, points: 48 }), breaths, palette: null };
  const back = parseRecipe(JSON.stringify(old));
  assert.equal(back.profile.length, PROFILE_POINTS);
  assert.equal(back.pattern.type, 'plain');
  assert.ok(Math.abs(back.pattern.lipY - (profileHeight(back.profile) - 0.05)) < 1e-3);
});

test('sample sessions look like processor output and give varied vessels', () => {
  assert.ok(SAMPLES.length >= 6 && SAMPLES.length <= 8);
  const types = new Set(), tall = [];
  for (const s of SAMPLES) {
    assert.ok(s.id && s.name && s.breathRate > 3);
    for (const b of s.breaths) {
      for (const k of ['t', 'depth', 'durationMs', 'inhaleMs', 'exhaleMs']) assert.ok(Number.isFinite(b[k]), `${s.id}.${k}`);
      assert.equal(b.inhaleMs + b.exhaleMs, b.durationMs);
    }
    const r = sampleRecipe(s);
    assert.deepEqual(parseRecipe(JSON.stringify(r)), r);
    types.add(r.pattern.type);
    tall.push(profileHeight(r.profile) / (2 * profileMaxR(r.profile)));
    assert.equal(r.pattern.type, choosePattern(breathFeatures(s.breaths)));
  }
  assert.ok(types.size >= 4, `pattern variety ${[...types]}`);
  assert.ok(Math.max(...tall) / Math.min(...tall) > 2.5, 'bowls and tall vases');
});

test('normalizeBreath fills defaults', () => {
  const n = normalizeBreath({});
  assert.equal(n.depth, 0.5);
  assert.ok(n.inhaleMs + n.exhaleMs <= n.durationMs + 1);
});

test('palette families: slow = teal-green, fast = amber', () => {
  const slow = paletteFor({ breathRate: 6, pulse: 70 });
  const fast = paletteFor({ breathRate: 35, pulse: 70 });
  assert.ok(slow.hue > 150 && slow.hue < 200, `slow hue ${slow.hue}`);
  assert.ok(fast.hue > 20 && fast.hue < 50, `fast hue ${fast.hue}`);
  assert.match(slow.color, /^#[0-9a-f]{6}$/);
  const p1 = paletteFor({ breathRate: 12, pulse: 50 });
  const p2 = paletteFor({ breathRate: 12, pulse: 100 });
  assert.notEqual(p1.hue, p2.hue);
  assert.ok(Math.abs(p1.hue - p2.hue) < 25);
});
