import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp01, tinkFrequency, tinkEnvelope, breathTargets, crackleRate,
  crackleLevel, snapToPentatonic, sparklePartials, createSound, COOL_AUTO_STOP,
} from './sound.js';

test('clamp01 handles junk', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(NaN), 0);
  assert.equal(clamp01(undefined), 0);
  assert.equal(clamp01(0.4), 0.4);
});

test('tink pitch falls with depth and stays in range', () => {
  const hi = tinkFrequency(0);
  const lo = tinkFrequency(1);
  assert.ok(hi > lo);
  assert.ok(Math.abs(hi / lo - 2) < 1e-9); // one octave span
  let prev = Infinity;
  for (let d = 0; d <= 1; d += 0.05) {
    const f = tinkFrequency(d);
    assert.ok(f <= prev);
    prev = f;
  }
});

test('pentatonic snap lands on scale notes', () => {
  const ok = new Set([0, 2, 4, 7, 9, 12]);
  for (let s = 0; s <= 12; s += 0.25) assert.ok(ok.has(snapToPentatonic(s)));
});

test('deeper tink is longer and fuller', () => {
  const a = tinkEnvelope(0);
  const b = tinkEnvelope(1);
  assert.ok(b.decay > a.decay && b.body > a.body);
  assert.ok(b.peak <= 0.25);
});

test('breath targets rise smoothly', () => {
  const a = breathTargets(0);
  const b = breathTargets(1);
  assert.ok(b.roarGain > a.roarGain && b.cutoff > a.cutoff && b.rumbleGain > a.rumbleGain);
  assert.ok(b.cutoff < 1500 && a.cutoff > 300);
});

test('crackle thins out and stops', () => {
  assert.ok(crackleRate(0) > crackleRate(3));
  assert.ok(crackleRate(3) > crackleRate(7));
  assert.equal(crackleRate(COOL_AUTO_STOP), 0);
  assert.equal(crackleLevel(COOL_AUTO_STOP + 1), 0);
});

test('sparkle partials are staggered', () => {
  const p = sparklePartials(() => 0.5);
  assert.ok(p.length >= 5);
  for (let i = 1; i < p.length; i++) assert.ok(p[i].at > p[i - 1].at);
});

test('all methods are safe no-ops without WebAudio', async () => {
  const s = createSound();
  for (const m of ['furnace', 'breathe', 'bandSet', 'cut', 'coolStart', 'coolStop',
    'achievement', 'rare', 'stopAll', 'setVolume', 'setEnabled']) {
    assert.doesNotThrow(() => s[m](0.5));
  }
  assert.equal(await s.unlock(), false);
  s.setEnabled(false);
  assert.equal(s.isEnabled(), false);
  assert.doesNotThrow(() => s.dispose());
});
