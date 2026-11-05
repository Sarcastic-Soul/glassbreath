import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACHIEVEMENTS, FAMILIES, evaluate, progress, familyOf, finishOf, shapeOf, normalizeState, emptyState, familyProgress,
} from './achievements.js';
import { buildProfile, makeRecipe } from '../glass/vessel-profile.js';

const NOW = 1_800_000_000_000;
const recipeFrom = (breaths) => makeRecipe({ profile: buildProfile(breaths, { finish: 1 }), breaths });
const many = (n, b) => Array.from({ length: n }, () => ({ ...b }));
// An ordinary middle-of-the-road vessel: earns only "First glass".
const plainBreaths = many(5, { depth: 0.5, durationMs: 4000 });
const plain = (extra = {}) => ({ breaths: 5, breathRate: 14, recipe: recipeFrom(plainBreaths), finish: null, pausedMs: 2000, ...extra });
const run1 = (run, state) => evaluate(run, state, { now: NOW });

test('achievement list is well formed', () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.title && a.description);
    assert.match(a.icon, /^ph-[a-z0-9-]+$/);
  }
  assert.equal(FAMILIES.length, 6);
});

test('first glass on the first cooled vessel only', () => {
  const a = run1(plain(), undefined);
  assert.deepEqual(a.unlocked, ['first-glass']);
  assert.equal(a.state.vessels, 1);
  assert.equal(a.state.unlocked['first-glass'], NOW);
  const b = run1(plain(), a.state);
  assert.deepEqual(b.unlocked, []);
  assert.equal(b.state.vessels, 2);
});

test('slow breather at 8/min or slower, patient at 6/min or slower', () => {
  const s = run1(plain(), null).state;
  assert.deepEqual(run1(plain({ breathRate: 8.5 }), s).unlocked, []);
  assert.deepEqual(run1(plain({ breathRate: 8 }), s).unlocked, ['slow-breather']);
  assert.deepEqual(run1(plain({ breathRate: 6 }), s).unlocked, ['slow-breather', 'patient']);
  assert.deepEqual(run1(plain({ breathRate: null }), s).unlocked, []);
  assert.deepEqual(run1(plain({ breathRate: 0 }), s).unlocked, []);
});

test('full ten and steady hand', () => {
  const s = run1(plain(), null).state;
  const ten = (extra) => plain({ breaths: 10, ...extra });
  assert.deepEqual(run1(ten({ pausedMs: 3000 }), s).unlocked, ['full-ten']);
  assert.deepEqual(run1(ten({ pausedMs: 0 }), s).unlocked, ['full-ten', 'steady-hand']);
  assert.deepEqual(run1(ten({ pausedMs: undefined, pauses: 0 }), s).unlocked, ['full-ten', 'steady-hand']);
  assert.deepEqual(run1(ten({ pausedMs: undefined, pauses: 2 }), s).unlocked, ['full-ten']);
  // no pause data at all: cannot tell, so no award
  assert.deepEqual(run1(ten({ pausedMs: undefined }), s).unlocked, ['full-ten']);
  // pause-free but short
  assert.deepEqual(run1(plain({ breaths: 9, pausedMs: 0 }), s).unlocked, []);
});

test('shape helper and tall vase / wide bowl', () => {
  const tallR = recipeFrom(many(10, { depth: 0.15, durationMs: 9000 }));
  const wideR = recipeFrom(many(3, { depth: 1, durationMs: 3000 }));
  const tall = shapeOf(tallR), wide = shapeOf(wideR), mid = shapeOf(recipeFrom(plainBreaths));
  assert.ok(tall.tallness > mid.tallness && mid.tallness > wide.tallness);
  assert.ok(wide.width > tall.width);
  // rebuilds from breaths when there is no profile
  const fromBreaths = shapeOf({ breaths: tallR.breaths });
  assert.ok(Math.abs(fromBreaths.tallness - tall.tallness) < 0.01);
  assert.equal(shapeOf(null), null);
  assert.equal(shapeOf({}), null);

  const s = run1(plain(), null).state;
  assert.deepEqual(run1(plain({ recipe: tallR, breaths: 9 }), s).unlocked, ['tall-vase']);
  assert.deepEqual(run1(plain({ recipe: wideR, breaths: 3 }), s).unlocked, ['wide-bowl']);
  assert.deepEqual(run1(plain({ recipe: undefined }), s).unlocked, []);
});

test('long out-breath needs 5+ breaths with long exhales', () => {
  const s = run1(plain(), null).state;
  const long = many(5, { depth: 0.5, durationMs: 6000, inhaleMs: 2000, exhaleMs: 4000 });
  assert.deepEqual(run1(plain({ recipe: recipeFrom(long) }), s).unlocked, ['long-exhale']);
  assert.deepEqual(run1(plain({ recipe: recipeFrom(long.slice(0, 4)), breaths: 4 }), s).unlocked, []);
});

test('full set needs all 6 colour families, with progress text', () => {
  let state = null;
  const rates = [5, 10, 15, 21, 28];
  for (const r of rates) state = run1(plain({ breathRate: r }), state).state;
  assert.equal(state.families.length, 5);
  assert.equal(progress(state).find((p) => p.id === 'full-set').progressText, '5 of 6 colours');
  assert.equal(state.unlocked['full-set'], undefined);
  // family given by name beats the rate
  const last = run1(plain({ breathRate: 14, family: 'Amber' }), state);
  assert.ok(last.unlocked.includes('full-set'));
  assert.equal(progress(last.state).find((p) => p.id === 'full-set').progressText, '6 of 6 colours');
  assert.ok(familyProgress(last.state).every((f) => f.seen));
});

test('rare find and collector', () => {
  let r = run1(plain({ finish: 'gold' }), null);
  assert.deepEqual(r.unlocked, ['first-glass', 'rare-find']);
  r = run1(plain({ finish: null, recipe: { ...recipeFrom(plainBreaths), meta: { finish: 'crackle' } } }), r.state);
  assert.deepEqual(r.unlocked, []);
  assert.equal(progress(r.state).find((p) => p.id === 'collector').progressText, '2 of 3 finishes');
  r = run1(plain({ finish: 'opal' }), r.state);
  assert.deepEqual(r.unlocked, ['collector']);
  r = run1(plain({ finish: 'gold' }), r.state);
  assert.deepEqual(r.state.finishes.sort(), ['crackle', 'gold', 'opal']);
});

test('sample recordings earn nothing and do not change state', () => {
  const before = run1(plain(), null).state;
  const r = run1({ breaths: 10, breathRate: 5, pausedMs: 0, finish: 'opal', family: 'amber', fromSample: true,
    recipe: recipeFrom(many(10, { depth: 0.15, durationMs: 9000 })) }, before);
  assert.deepEqual(r.unlocked, []);
  assert.deepEqual(r.state, before);
  const fresh = run1({ breaths: 3, fromSample: true }, undefined);
  assert.deepEqual(fresh.unlocked, []);
  assert.equal(fresh.state.vessels, 0);
});

test('robust to missing, old and broken state', () => {
  for (const bad of [undefined, null, 42, 'x', [], { version: 0 }, { unlocked: null, families: 'jade', vessels: 'lots' }]) {
    const r = run1(plain(), bad);
    assert.deepEqual(r.unlocked, ['first-glass']);
    assert.equal(r.state.version, 1);
    assert.equal(r.state.vessels, 1);
  }
  // old shapes: unlocked as an id list, family names, unknown ids and finishes dropped
  const old = { unlocked: ['first-glass', 'speed-demon'], families: ['Sea glass', 'jade', 'jade', 'rainbow'], finishes: ['Gold fleck', 'glitter'], vessels: 3.7 };
  const n = normalizeState(old);
  assert.deepEqual(Object.keys(n.unlocked), ['first-glass']);
  assert.deepEqual(n.families, ['sea-glass', 'jade']);
  assert.deepEqual(n.finishes, ['gold']);
  assert.equal(n.vessels, 3);
  const r = run1(plain(), old);
  assert.deepEqual(r.unlocked, ['rare-find']); // already had a gold finish in the old data
  assert.equal(r.state.unlocked['first-glass'], 1);
  assert.deepEqual(normalizeState(undefined), emptyState());
  // bad run input
  assert.deepEqual(run1(null, null).unlocked, []);
});

test('progress rows', () => {
  const rows = progress(run1(plain({ breathRate: 7 }), null).state);
  assert.equal(rows.length, ACHIEVEMENTS.length);
  const first = rows.find((p) => p.id === 'first-glass');
  assert.equal(first.done, true);
  assert.equal(first.doneAt, NOW);
  assert.equal(rows.find((p) => p.id === 'tall-vase').done, false);
  assert.equal(rows.find((p) => p.id === 'tall-vase').doneAt, null);
  assert.ok(rows.every((p) => p.icon && p.title && p.description));
});

test('familyOf and finishOf', () => {
  assert.equal(familyOf('Deep teal'), 'deep-teal');
  assert.equal(familyOf('sea_glass'), 'sea-glass');
  assert.equal(familyOf(5), 'deep-teal');
  assert.equal(familyOf(7.4), 'deep-teal');
  assert.equal(familyOf(8), 'sea-glass');
  assert.equal(familyOf(12), 'sea-glass');
  assert.equal(familyOf(16), 'jade');
  assert.equal(familyOf(22), 'peridot');
  assert.equal(familyOf(30), 'honey');
  assert.equal(familyOf(40), 'amber');
  assert.equal(familyOf({ palette: { breathRate: 20 } }), 'peridot');
  assert.equal(familyOf('nope'), null);
  assert.equal(familyOf(null), null);
  assert.equal(finishOf('Gold fleck'), 'gold');
  assert.equal(finishOf({ meta: { finish: 'opal' } }), 'opal');
  assert.equal(finishOf({ finish: { kind: 'crackle' } }), 'crackle');
  assert.equal(finishOf({ meta: { name: 'Peridot' } }), null);
  assert.equal(finishOf(null), null);
});
