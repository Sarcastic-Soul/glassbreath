// Turns decoded SmartSpectra metrics (protobufjs message or its plain JSON)
// into Glassbreath events. Shared by the live camera and replay paths.
// No SDK imports: everything is injected so it can run under node:test.

import { toMillis } from './timestamps.js';
import { createRollingNormaliser } from './normaliser.js';
import { createPhaseDetector } from './phase.js';
import { createBeatDetector } from './beats.js';
import { smileScore, createEdgeDetector, createChangeDetector } from './face.js';
import { validationPayload, validationName } from './validation.js';

const arr = (x) => (Array.isArray(x) ? x : []);
const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

/**
 * @param {(name: string, payload: object) => void} emit
 * @param {object} [opts]
 * @param {number} [opts.timeOffsetMs=0] added to every sample time (replay shifts to playback time)
 * @param {number} [opts.beatLagMs=1200] beats are played out at sample time + this lag, so batched
 *   arterial samples (~7 per event, ~1.1 s late) come out evenly spaced
 * @param {() => number} [opts.now] wall clock in ms
 * @param {(fn: Function, ms: number) => any} [opts.schedule]
 * @param {(id: any) => void} [opts.cancel]
 * @param {(code: number) => string} [opts.namer] validation code -> name
 */
export function createProcessor(emit, {
  timeOffsetMs = 0,
  beatLagMs = 1200,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
  namer = validationName,
  smileSmoothMs = 250,
} = {}) {
  let offset = timeOffsetMs;
  const norm = createRollingNormaliser();
  const phase = createPhaseDetector();
  const beats = createBeatDetector();
  const blink = createEdgeDetector();
  const talking = createChangeDetector(false);
  const timers = new Set();
  let lastBreathT = -Infinity;
  let lastArtT = -Infinity;
  let lastBlinkT = -Infinity;
  let lastTalkT = -Infinity;
  let lastExprT = -Infinity;
  let smile = null;
  let ready = { breathing: false, pulse: false };

  const tm = (sample) => {
    const ms = toMillis(sample?.timestamp);
    return ms == null ? null : ms + offset;
  };

  function scheduleBeat(beat) {
    const at = beat.t + beatLagMs;
    const delay = at - now();
    const fire = () => emit('beat', { t: beat.t, at, strength: beat.strength });
    if (delay <= 0) { fire(); return; }
    const slot = { id: null, done: false };
    slot.id = schedule(() => { slot.done = true; timers.delete(slot.id); fire(); }, delay);
    if (!slot.done) timers.add(slot.id);
  }

  function setReady(key, value) {
    if (ready[key] === value) return;
    ready = { ...ready, [key]: value };
    emit('ready', { ...ready });
  }

  function handleMetrics(m) {
    if (!m || typeof m !== 'object') return;
    const breathing = m.breathing || {};
    const cardio = m.cardio || {};
    const face = m.face || {};

    // Breathing trace -> breath / breathComplete.
    for (const s of arr(breathing.upperTrace)) {
      const t = tm(s);
      if (t == null || t <= lastBreathT) continue;
      lastBreathT = t;
      const raw = num(s.value);
      const chest = norm.push(t, raw);
      const r = phase.push(t, chest, raw);
      emit('breath', { t, chest, phase: r.phase, depth: r.depth });
      if (r.completed) emit('breathComplete', r.completed);
    }

    const rate = arr(breathing.rate).at(-1);
    if (rate) {
      const stable = !!rate.stable;
      emit('rate', { bpm: num(rate.value), confidence: num(rate.confidence) / 100, stable });
      setReady('breathing', stable);
    }

    const pulse = arr(cardio.pulseRate).at(-1);
    if (pulse) {
      const stable = !!pulse.stable;
      emit('pulse', { bpm: num(pulse.value), confidence: num(pulse.confidence) / 100, stable });
      setReady('pulse', stable);
    }

    for (const s of arr(cardio.arterialPressureTrace)) {
      const t = tm(s);
      if (t == null || t <= lastArtT) continue;
      lastArtT = t;
      const b = beats.push(t, num(s.value));
      if (b) scheduleBeat(b);
    }

    for (const s of arr(face.blinking)) {
      const t = tm(s);
      if (t == null || t <= lastBlinkT) continue;
      lastBlinkT = t;
      if (blink.push(t, s.detected)) emit('blink', { t });
    }

    for (const s of arr(face.talking)) {
      const t = tm(s);
      if (t == null || t <= lastTalkT) continue;
      lastTalkT = t;
      const change = talking.push(s.detected);
      if (change != null) emit('talking', { active: change, t });
    }

    for (const e of arr(face.expression)) {
      const t = tm(e);
      if (t == null || t <= lastExprT) continue;
      const dt = Number.isFinite(lastExprT) ? t - lastExprT : 0;
      lastExprT = t;
      const score = smileScore(e);
      if (score == null) continue;
      smile = smile == null ? score : smile + (score - smile) * (1 - Math.exp(-dt / smileSmoothMs));
      emit('smile', { score: smile, raw: score, t });
    }
  }

  function handleValidation(code, hint) {
    emit('validation', validationPayload(code, hint, namer));
  }

  return {
    handleMetrics,
    handleValidation,
    setTimeOffset(ms) { offset = ms; },
    dispose() {
      for (const id of timers) cancel(id);
      timers.clear();
    },
  };
}
