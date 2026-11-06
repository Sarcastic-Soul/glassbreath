// Signal processing tests with synthetic data. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Long from 'long';

import { toMicros, toMillis } from '../src/renderer/signals/timestamps.js';
import { createRollingNormaliser } from '../src/renderer/signals/normaliser.js';
import { createPhaseDetector } from '../src/renderer/signals/phase.js';
import { createBeatDetector } from '../src/renderer/signals/beats.js';
import { smileScore, createEdgeDetector } from '../src/renderer/signals/face.js';
import { validationPayload, validationName } from '../src/renderer/signals/validation.js';
import { createProcessor } from '../src/renderer/signals/processor.js';
import { parseJsonl, recordingStartMs, createReplaySource } from '../src/renderer/signals/replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let seed = 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = (a) => (rand() - 0.5) * 2 * a;

test('timestamps: numbers, strings, Long, Long-like, bigint, junk', () => {
  const us = 1793860000123456;
  assert.equal(toMicros(us), us);
  assert.equal(toMicros(String(us)), us);
  assert.equal(toMicros(Long.fromNumber(us)), us);
  const l = Long.fromNumber(us);
  assert.equal(toMicros({ low: l.low, high: l.high, unsigned: false }), us);
  assert.equal(toMicros(BigInt(us)), us);
  assert.equal(toMillis(String(us)), us / 1000);
  for (const bad of [null, undefined, 'abc', NaN, {}, '']) assert.equal(toMicros(bad), null);
});

test('normaliser: scales different units the same and stays bounded', () => {
  for (const scale of [0.001, 1, 5000]) {
    const n = createRollingNormaliser();
    let max = -Infinity; let min = Infinity;
    for (let t = 0; t < 60000; t += 34) {
      const v = scale * (3 + Math.sin((2 * Math.PI * t) / 5000));
      const x = n.push(t, v);
      if (t > 20000) { max = Math.max(max, x); min = Math.min(min, x); }
      assert.ok(Number.isFinite(x));
      assert.ok(Math.abs(x) <= 1.25);
    }
    assert.ok(max > 0.85 && max < 1.05, `max ${max}`);
    assert.ok(min < -0.85 && min > -1.05, `min ${min}`);
  }
  const flat = createRollingNormaliser();
  for (let t = 0; t < 5000; t += 34) assert.equal(flat.push(t, 7), 0);
});

function runBreathing(signal, ms, step = 34) {
  const n = createRollingNormaliser();
  const p = createPhaseDetector();
  const done = []; const phases = new Set(); let maxLive = 0;
  for (let t = 0; t < ms; t += step) {
    const raw = signal(t);
    const r = p.push(t, n.push(t, raw), raw);
    phases.add(r.phase);
    maxLive = Math.max(maxLive, r.depth);
    if (r.completed) done.push(r.completed);
  }
  return { done, phases, maxLive };
}

test('phase detector: 12 breaths/min noisy sine gives ~12 breaths per minute', () => {
  const { done, phases, maxLive } = runBreathing((t) => 10 + Math.sin((2 * Math.PI * t) / 5000) + noise(0.08), 60000);
  // First cycle or two are lost while the detector finds its first trough.
  assert.ok(done.length >= 10 && done.length <= 12, `breaths ${done.length}`);
  for (const b of done.slice(1)) {
    assert.ok(Math.abs(b.durationMs - 5000) < 600, `duration ${b.durationMs}`);
    assert.ok(b.inhaleMs > 1500 && b.exhaleMs > 1500);
    assert.ok(Math.abs(b.depth - 0.6) < 0.15, `depth ${b.depth}`);
  }
  assert.ok(phases.has('inhale') && phases.has('exhale'));
  assert.ok(maxLive > 0.4 && maxLive <= 1);
});

test('phase detector: a deeper breath scores deeper than the user\'s usual', () => {
  const amp = (t) => (t > 40000 && t < 45000 ? 2 : 1);
  const { done } = runBreathing((t) => 10 + amp(t) * Math.sin((2 * Math.PI * t) / 5000) + noise(0.05), 60000);
  const deep = done.find((b) => b.t > 42000 && b.t < 47000);
  assert.ok(deep, 'deep breath found');
  const normal = done.filter((b) => b.t < 38000).map((b) => b.depth);
  assert.ok(deep.depth > Math.max(...normal) + 0.2, `deep ${deep.depth} vs ${normal}`);
});

test('phase detector: holds are reported during a pause', () => {
  const p = createPhaseDetector();
  const n = createRollingNormaliser();
  const phases = [];
  for (let t = 0; t < 40000; t += 34) {
    const raw = t < 20000 ? Math.sin((2 * Math.PI * t) / 5000) : 0;
    phases.push([t, p.push(t, n.push(t, raw), raw).phase]);
  }
  assert.equal(phases.filter(([t]) => t > 22000).at(-1)[1], 'hold');
});

test('beat detector: 70 bpm waveform gives ~70 beats/min, in batches too', () => {
  for (const batch of [1, 7]) {
    const d = createBeatDetector();
    const beats = [];
    const samples = [];
    for (let t = 0; t < 60000; t += 1000 / 29) {
      const x = ((t / 1000) * 70) / 60;
      const ph = x - Math.floor(x);
      samples.push([t, Math.exp(-(((ph - 0.15) / 0.07) ** 2)) + 0.3 * Math.exp(-(((ph - 0.45) / 0.09) ** 2)) + noise(0.03)]);
    }
    for (let i = 0; i < samples.length; i += batch) {
      for (const [t, v] of samples.slice(i, i + batch)) { const b = d.push(t, v); if (b) beats.push(b); }
    }
    assert.ok(beats.length >= 66 && beats.length <= 71, `batch ${batch}: ${beats.length} beats`);
    const gaps = beats.slice(1).map((b, i) => b.t - beats[i].t);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(Math.abs(mean - 60000 / 70) < 30, `mean gap ${mean}`);
    for (const b of beats) assert.ok(b.strength >= 0 && b.strength <= 1);
  }
});

test('smile score: numeric enum, JSON string enum, missing parts', () => {
  assert.equal(smileScore({ scores: [{ type: 6, confidence: 90 }, { type: 5, confidence: 80 }] }), 0.8);
  assert.equal(smileScore({ scores: [{ type: 'HAPPY', confidence: 42 }] }), 0.42);
  assert.equal(smileScore({ scores: [{ type: 5, confidence: 0.8 }] }), 0.008);
  assert.equal(smileScore({ scores: [{ type: 'HAPPY', confidence: 1 }] }), 0.01);
  assert.equal(smileScore({ scores: [{ type: '5', confidence: 1.01 }] }), 0.0101);
  assert.equal(smileScore({ scores: [{ type: 'NEUTRAL', confidence: 99 }] }), 0);
  assert.equal(smileScore({ scores: [{ type: 'HAPPY' }] }), 0); // default value omitted by toJSON
  assert.equal(smileScore({}), null);
  assert.equal(smileScore(null), null);
  assert.equal(smileScore({ scores: [] }), null);
  assert.equal(smileScore({ scores: [{ type: 5, confidence: 150 }] }), 1);
});

test('blink edges: one event per closed-eye run', () => {
  const e = createEdgeDetector();
  const seq = [0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0];
  const hits = seq.map((d, i) => e.push(i * 33, d)).filter(Boolean).length;
  assert.equal(hits, 2); // the flicker at index 5 is within 150 ms of the first
});

test('validation names', () => {
  assert.deepEqual(validationPayload(0, 'Ok'), { code: 0, name: 'Ok', hint: 'Ok', ok: true });
  assert.equal(validationName(7), 'ChestNotVisible');
  assert.equal(validationPayload(12).ok, false);
  assert.equal(validationName(99), 'Unknown99');
});

test('processor + synthetic fixture: breaths, rate, pulse, beats, blinks, smile', () => {
  const text = fs.readFileSync(path.join(here, '..', 'fixtures', 'synthetic-session.jsonl'), 'utf8');
  const parsed = parseJsonl(text);
  assert.ok(parsed.lines.length > 5000);
  assert.equal(recordingStartMs(parsed), parsed.header.startedAtMs);
  const counts = {}; const last = {};
  let clock = 0;
  const proc = createProcessor((name, p) => { counts[name] = (counts[name] || 0) + 1; last[name] = p; },
    { now: () => clock, schedule: (fn) => { fn(); return 0; } });
  let maxSmile = 0;
  for (const l of parsed.lines) {
    clock = parsed.header.startedAtMs + l.tMs;
    if (l.metrics) proc.handleMetrics(l.metrics); else proc.handleValidation(l.validation.code, l.validation.hint);
    if (last.smile) maxSmile = Math.max(maxSmile, last.smile.score);
  }
  assert.ok(counts.breath > 2000);
  assert.ok(counts.breathComplete >= 14 && counts.breathComplete <= 19, `breaths ${counts.breathComplete}`);
  assert.ok(counts.beat >= 90 && counts.beat <= 106, `beats ${counts.beat}`);
  assert.ok(counts.blink >= 15, `blinks ${counts.blink}`);
  assert.ok(maxSmile > 0.7, `smile ${maxSmile}`);
  assert.equal(last.ready.breathing, true);
  assert.equal(last.ready.pulse, true);
  assert.ok(Math.abs(last.rate.bpm - 12) < 2);
  assert.ok(last.rate.confidence > 0.45 && last.rate.confidence <= 1);
  assert.ok(Math.abs(last.pulse.bpm - 70) < 5);
  assert.equal(last.validation.ok, true);
});

test('processor: beats are played out at sample time + lag', () => {
  const fired = []; const sched = [];
  const clock = 1_000_000;
  const proc = createProcessor((name, p) => { if (name === 'beat') fired.push(p); },
    { now: () => clock, schedule: (fn, ms) => { sched.push(ms); return sched.length; }, beatLagMs: 1200 });
  const trace = [];
  for (let t = clock - 3000; t < clock; t += 1000 / 29) {
    const ph = ((t / 1000) * 1.2) % 1;
    trace.push({ value: Math.exp(-(((ph - 0.2) / 0.07) ** 2)), timestamp: String(Math.round(t * 1000)) });
  }
  proc.handleMetrics({ cardio: { arterialPressureTrace: trace } });
  // Old beats (sample + lag < now) fire at once; recent ones are scheduled.
  assert.ok(fired.length >= 1);
  for (const b of fired) assert.ok(b.at <= clock && b.at === b.t + 1200);
  for (const ms of sched) assert.ok(ms > 0 && ms <= 1200);
});

test('replay source: plays lines in order with a time offset', async () => {
  const text = [
    JSON.stringify({ header: { startedAtMs: 1000 } }),
    JSON.stringify({ tMs: 0, validation: { code: 0, hint: 'Ok' } }),
    'not json',
    JSON.stringify({ tMs: 50, metrics: { breathing: { upperTrace: [{ value: 1, timestamp: '1050000' }] } } }),
  ].join('\n');
  let clock = 5000; const seen = []; let offset = null; let ended = false;
  const r = createReplaySource({
    url: 'x.jsonl', load: async () => text, now: () => clock,
    schedule: (fn, ms) => { clock += ms; queueMicrotask(fn); return 1; }, cancel: () => {},
    onMetrics: () => seen.push('m'), onValidation: () => seen.push('v'),
    onTimeOffset: (o) => { offset = o; }, onEnd: () => { ended = true; },
  });
  await r.start();
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(seen, ['v', 'm']);
  assert.equal(offset, 4000);
  assert.ok(ended);
});
