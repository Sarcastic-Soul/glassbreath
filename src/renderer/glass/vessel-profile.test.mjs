import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfile, buildControls, wallProfile, makeRecipe, parseRecipe, normalizeBreath,
  profileHeight, profileMaxR, PROFILE_POINTS, MAX_BANDS, LIMITS,
} from './vessel-profile.js';
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

test('bands grow monotonically toward the pipe', () => {
  const breaths = randomBreaths(MAX_BANDS, 7);
  let prevH = 0;
  for (let k = 0; k <= breaths.length; k++) {
    const { controls, height } = buildControls(breaths.slice(0, k));
    assert.ok(height > prevH - 1e-9, `height grows at ${k}`);
    prevH = height;
    for (let i = 1; i < controls.length; i++) assert.ok(controls[i][1] >= controls[i - 1][1], 'controls ordered');
  }
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
      assert.ok(d2 < 0.12, `seed ${s} point ${i} d2=${d2}`);
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
  assert.equal(w.length, outer.length * 2 + 2);
  const inner = w.slice(outer.length + 2);
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
