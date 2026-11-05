// Generates fixtures/synthetic-session.jsonl: a fake ~90 s SmartSpectra session
// in the same JSONL format record-metrics.mjs writes, so the UI can be built
// without a camera. Rates and batching follow a real probe on this machine:
//   upperTrace 29/s, ~1 sample per event, ~63 ms late
//   arterialPressureTrace 29/s, batches of ~7 at ~4 events/s, ~1.1 s late
//   pulseRate ~1/s, ~1.4 s late; breathing rate ~0.2/s, ~1.5 s late
//   blinking / talking / expression ~30/s, ~73 ms late
// Values are synthetic: not real physiology.
// Usage: node scripts/make-synthetic-fixture.mjs [out] [seconds]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, '..', 'fixtures', 'synthetic-session.jsonl');
const SECONDS = Number(process.argv[3] || 90);

// Small seeded PRNG so the file is the same every run.
let seed = 0x9e3779b9;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rand(); return s - 3; };

const START_MS = 1793860000000; // fixed fake wall clock
const us = (ms) => String(Math.round((START_MS + ms) * 1000)); // toJSON() style int64 string
const SR = 29; // samples per second
const dt = 1000 / SR;

// ---- breathing: rate drifts 11..13 /min, depth varies, slow baseline drift ----
const breaths = [];
{
  let t = 0;
  while (t < SECONDS * 1000 + 6000) {
    const bpm = 12 + Math.sin(t / 23000) + gauss() * 0.4;
    const period = 60000 / bpm;
    const depth = 1 + gauss() * 0.15 + (t > 40000 && t < 55000 ? 0.45 : 0); // a few deep breaths
    breaths.push({ t0: t, period, depth, inhale: 0.42 + gauss() * 0.03 });
    t += period;
  }
}
function chestAt(ms) {
  let b = breaths[0];
  for (const x of breaths) { if (x.t0 <= ms) b = x; else break; }
  const ph = (ms - b.t0) / b.period; // 0..1
  // Inhale rises over `inhale` of the cycle, exhale falls over the rest.
  const shape = ph < b.inhale
    ? 0.5 - 0.5 * Math.cos(Math.PI * (ph / b.inhale))
    : 0.5 + 0.5 * Math.cos(Math.PI * ((ph - b.inhale) / (1 - b.inhale)));
  const baseline = 0.6 * Math.sin(ms / 17000) + 0.0002 * ms / 1000;
  return 2.1 + baseline + b.depth * 1.2 * shape + gauss() * 0.03;
}

// ---- arterial waveform at ~70 bpm with small beat-to-beat variation ----
const beats = [];
{
  let t = 120;
  while (t < SECONDS * 1000 + 3000) {
    beats.push(t);
    t += 60000 / (70 + 2.5 * Math.sin(t / 4000) + gauss() * 1.2);
  }
}
function arterialAt(ms) {
  let v = 0;
  for (const b of beats) {
    const x = (ms - b) / 1000;
    if (x < -0.2 || x > 1.0) continue;
    v += Math.exp(-(((x - 0.12) / 0.06) ** 2)); // systolic peak
    v += 0.35 * Math.exp(-(((x - 0.36) / 0.08) ** 2)); // dicrotic wave
  }
  return 0.2 + v + gauss() * 0.02;
}

// ---- blinks every 3-5 s, ~150 ms long ----
const blinks = [];
for (let t = 1500; t < SECONDS * 1000; t += 3000 + rand() * 2000) blinks.push(t);
const blinking = (ms) => blinks.some((b) => ms >= b && ms < b + 150);
const talking = (ms) => ms > 18000 && ms < 21000; // a short burst of talking

const EXPR = ['ANGRY', 'CONTEMPT', 'DISGUST', 'FEAR', 'HAPPY', 'NEUTRAL', 'SAD', 'SURPRISE'];
function expressionAt(ms) {
  // Smile ramps in at 78 s, held till 84 s.
  const smile = ms < 78000 ? 2 + rand() * 3 : ms < 79500 ? 5 + ((ms - 78000) / 1500) * 80 : ms < 84000 ? 82 + gauss() * 4 : 4;
  const neutral = Math.max(2, 92 - smile);
  return EXPR.map((type) => {
    const c = type === 'HAPPY' ? smile : type === 'NEUTRAL' ? neutral : rand() * 1.5;
    return { type, confidence: Number(c.toFixed(2)) };
  });
}

// ---- breathing rate & pulse ----
const breathRateAt = (ms) => {
  const recent = breaths.filter((b) => b.t0 <= ms && b.t0 > ms - 30000);
  return recent.length ? 60000 / (recent.reduce((s, b) => s + b.period, 0) / recent.length) : 12;
};
const breathConfAt = (ms) => (ms < 30000 ? 0 : Math.min(78, 20 + (ms - 30000) / 400));
const pulseConfAt = (ms) => (ms < 12000 ? Math.max(0, ms / 400) : Math.min(85, 30 + (ms - 12000) / 300));

// ---- build event lines (tMs = arrival time) ----
const lines = [];
const push = (tMs, obj) => lines.push({ tMs: Math.round(tMs), ...obj });

// Validation: camera tuning for the first 2.5 s, then ok ~10x per second.
for (let t = 300; t < SECONDS * 1000; t += 100) {
  push(t, { validation: t < 2500 ? { code: 10, hint: 'Camera tuning.' } : { code: 0, hint: 'Ok' } });
}

const FIRST = 2500; // data starts once tuning is done
// Fast face + chest samples, one per event (~29 events/s).
for (let s = FIRST; s < SECONDS * 1000; s += dt) {
  const arriveUpper = s + 63 + Math.abs(gauss()) * 6;
  push(arriveUpper, { metrics: { breathing: { upperTrace: [{ value: Number(chestAt(s).toFixed(5)), ...(s >= 30000 ? { stable: true } : {}), timestamp: us(s) }] } } });
  const face = {
    blinking: [{ ...(blinking(s) ? { detected: true } : {}), stable: true, timestamp: us(s) }],
    talking: [{ ...(talking(s) ? { detected: true } : {}), stable: true, timestamp: us(s) }],
    expression: [{ stable: true, timestamp: us(s), scores: expressionAt(s) }],
  };
  push(s + 73 + Math.abs(gauss()) * 6, { metrics: { face } });
}

// Arterial trace in batches of ~7 samples, ~4 events/s, ~1.1 s late.
{
  let s = FIRST;
  while (s < SECONDS * 1000) {
    const n = 6 + Math.floor(rand() * 3);
    const batch = [];
    for (let i = 0; i < n; i++, s += dt) {
      const conf = pulseConfAt(s);
      batch.push({ value: Number(arterialAt(s).toFixed(5)), ...(conf >= 40 ? { stable: true } : {}), confidence: Number(conf.toFixed(1)), timestamp: us(s) });
    }
    push(s + 1100 + gauss() * 30, { metrics: { cardio: { arterialPressureTrace: batch } } });
  }
}

// Pulse rate ~1/s, 1.4 s late.
for (let s = FIRST + 1000; s < SECONDS * 1000; s += 1000) {
  const conf = pulseConfAt(s);
  const bpm = 70 + 2.5 * Math.sin(s / 4000) + gauss() * 0.8;
  push(s + 1400, { metrics: { cardio: { pulseRate: [{ value: Number(bpm.toFixed(2)), ...(conf >= 40 ? { stable: true } : {}), confidence: Number(conf.toFixed(1)), timestamp: us(s) }] } } });
}

// Breathing rate every 5 s, 0.9-2.6 s late; confidence 0 until 30 s.
for (let s = FIRST + 5000; s < SECONDS * 1000; s += 5000) {
  const conf = breathConfAt(s);
  const rate = { value: Number(breathRateAt(s).toFixed(2)), timestamp: us(s) };
  if (conf > 0) rate.confidence = Number(conf.toFixed(1));
  if (conf >= 45) rate.stable = true;
  push(s + 900 + rand() * 1700, { metrics: { breathing: { rate: [rate] } } });
}

lines.sort((a, b) => a.tMs - b.tMs);
const text = [JSON.stringify({ header: { startedAtMs: START_MS, synthetic: true, note: 'Generated by scripts/make-synthetic-fixture.mjs; not real data' } })]
  .concat(lines.map((l) => JSON.stringify(l))).join('\n') + '\n';
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text);
console.log(`wrote ${lines.length} lines (${(text.length / 1024).toFixed(0)} KB) to ${out}`);
