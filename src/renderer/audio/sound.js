// Glassbreath sound module. Everything is synthesized with WebAudio, no files.
// All public methods are safe no-ops before unlock() or when audio is missing.

// ---------- Pure helpers (no WebAudio, unit tested) ----------

export const DEFAULT_VOLUME = 0.6;

export function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function centsToRatio(cents) {
  return Math.pow(2, cents / 1200);
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

// Major pentatonic steps, so repeated tinks always sound in tune together.
const PENTA = [0, 2, 4, 7, 9];

// Snap a semitone offset (from the root) to the nearest pentatonic note.
export function snapToPentatonic(semis) {
  const oct = Math.floor(semis / 12);
  const rem = semis - oct * 12;
  let best = PENTA[0];
  let bestDist = Infinity;
  for (const p of [...PENTA, 12]) {
    const d = Math.abs(rem - p);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return oct * 12 + best;
}

// Tink pitch: shallow breath = high (about G6), deep breath = up to an
// octave lower (about G5). Snapped to G major pentatonic.
export function tinkFrequency(depth) {
  const d = clamp01(depth);
  const top = 91; // G6
  const semis = snapToPentatonic(12 - d * 12); // 12 = top, 0 = an octave down
  return midiToHz(top - 12 + semis);
}

// Tink envelope: deeper breath = fuller (more low partial) and longer ring.
export function tinkEnvelope(depth) {
  const d = clamp01(depth);
  return {
    attack: 0.004,
    decay: 0.22 + d * 0.3, // seconds to near silence
    peak: 0.17 + d * 0.05,
    body: 0.35 + d * 0.45, // level of the sub partial (half frequency)
  };
}

// Furnace targets for a breath level 0..1.
export function breathTargets(level) {
  const l = clamp01(level);
  return {
    roarGain: 0.25 + 0.2 * l,
    cutoff: 380 * Math.pow(2, l * 1.7), // about 380 Hz .. 1240 Hz
    rumbleGain: 0.05 + 0.04 * l,
  };
}

// Cooling crackle: clicks per second at t seconds after coolStart.
// Busy at first, thinning out over about 6 s, then a few stray ticks.
export const COOL_AUTO_STOP = 8;
export function crackleRate(t) {
  if (!(t >= 0) || t >= COOL_AUTO_STOP) return 0;
  return 13 * Math.exp(-t / 2.2) + (t < 6 ? 1.2 : 0.6);
}

// Click loudness also fades as the glass settles.
export function crackleLevel(t) {
  if (!(t >= 0) || t >= COOL_AUTO_STOP) return 0;
  return 0.04 + 0.1 * Math.exp(-t / 3);
}

// Bell for the cut: partial ratio, relative level, decay time (s).
export const CUT_PARTIALS = [
  { ratio: 1, level: 1, decay: 2.2 },
  { ratio: 2.0, level: 0.45, decay: 1.4 },
  { ratio: 3.01, level: 0.18, decay: 0.8 },
];
export const CUT_FREQ = 659.25; // E5
export const CUT_PEAK = 0.13;

// Achievement: warm rising fifth, C5 then G5.
export const ACHIEVEMENT_NOTES = [
  { freq: 523.25, at: 0, decay: 0.9 },
  { freq: 783.99, at: 0.15, decay: 1.2 },
];

// Rare sparkle partials (C7 major-ish cluster), staggered starts.
export function sparklePartials(rand = Math.random) {
  const base = [2093.0, 2637.0, 3136.0, 3951.1, 4698.6, 5274.0];
  return base.map((f, i) => ({
    freq: f * centsToRatio((rand() * 2 - 1) * 7),
    at: i * 0.07 + rand() * 0.03,
    decay: 1.1 + rand() * 0.7,
    level: 0.032 * (1 - i * 0.08),
  }));
}

// ---------- WebAudio engine ----------

function getAudioCtor() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

export function createSound() {
  let ctx = null;
  let failed = false;
  let enabled = true;
  let volume = DEFAULT_VOLUME;

  let master = null; // volume + mute
  let fxBus = null; // one-shots, so stopAll can duck them
  let noiseBuf = null;
  const live = new Set(); // running one-shot sources

  // Furnace state
  let furnaceWanted = false;
  let fur = null; // { src, lp, roar, rumbleOsc, rumble, lfo, lfoDepth, bus }
  let furnaceStopTimer = 0;
  let lastLevel = -1;

  // Cooling state
  let coolTimer = 0;
  let coolStartAt = 0;
  let coolNextAt = 0;
  let coolFilter = null;
  let coolGainBus = null;

  const now = () => ctx.currentTime;
  const ready = () => !!ctx && ctx.state !== 'closed';

  // Wrap a method so it never throws.
  const safe = (fn) => (...args) => {
    try { return fn(...args); } catch (err) {
      if (typeof console !== 'undefined') console.warn('[sound]', err);
      return undefined;
    }
  };

  function build() {
    const Ctor = getAudioCtor();
    if (!Ctor) { failed = true; return false; }
    ctx = new Ctor({ latencyHint: 'interactive' });

    // Gentle safety limiter so stacked sounds never clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.2;
    limiter.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = 0; // fade in below
    master.connect(limiter);
    master.gain.setTargetAtTime(enabled ? volume : 0, ctx.currentTime, 0.05);

    fxBus = ctx.createGain();
    fxBus.gain.value = 1;
    fxBus.connect(master);

    // One white-noise buffer, reused by the furnace and the crackle.
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  // Track a one-shot source and clean up its nodes when it ends.
  function track(src, ...nodes) {
    live.add(src);
    src.onended = () => {
      live.delete(src);
      try { src.disconnect(); } catch {}
      for (const n of nodes) { try { n.disconnect(); } catch {} }
    };
  }

  // A single decaying sine voice into dest.
  function ping(freq, at, peak, attack, decay, dest = fxBus, type = 'sine') {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    osc.connect(g).connect(dest);
    osc.start(at);
    osc.stop(at + attack + decay + 0.05);
    track(osc, g);
  }

  // ----- furnace -----

  function startFurnaceNodes() {
    const t = now();
    const tg = breathTargets(0);
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(master);

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = tg.cutoff;
    lp.Q.value = 0.7;
    const roar = ctx.createGain();
    roar.gain.value = tg.roarGain;
    src.connect(lp).connect(roar).connect(bus);

    // Slow flicker on the roar, like a living flame.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.27;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.05;
    lfo.connect(lfoDepth).connect(roar.gain);

    // Low rumble. Triangle so small speakers still hear its harmonics.
    const rumbleOsc = ctx.createOscillator();
    rumbleOsc.type = 'triangle';
    rumbleOsc.frequency.value = 52;
    const rumble = ctx.createGain();
    rumble.gain.value = tg.rumbleGain;
    rumbleOsc.connect(rumble).connect(bus);

    src.start(t, Math.random() * 1.5);
    lfo.start(t);
    rumbleOsc.start(t);
    fur = { src, lp, roar, rumbleOsc, rumble, lfo, lfoDepth, bus };
    lastLevel = 0;
  }

  function stopFurnaceNodes() {
    if (!fur) return;
    const f = fur;
    fur = null;
    for (const n of [f.src, f.lfo, f.rumbleOsc]) { try { n.stop(); } catch {} }
    for (const n of Object.values(f)) { try { n.disconnect(); } catch {} }
  }

  function applyFurnace() {
    if (!ready()) return;
    clearTimeout(furnaceStopTimer);
    if (furnaceWanted) {
      if (!fur) startFurnaceNodes();
      fur.bus.gain.setTargetAtTime(1, now(), 0.45); // ~1.5 s to full
    } else if (fur) {
      fur.bus.gain.setTargetAtTime(0, now(), 0.4);
      // Free the nodes once fully faded.
      furnaceStopTimer = setTimeout(() => { if (!furnaceWanted) stopFurnaceNodes(); }, 2600);
    }
  }

  // ----- cooling crackle -----

  function scheduleCrackle() {
    if (!ready() || !coolFilter) return;
    const horizon = now() + 0.12;
    while (coolNextAt < horizon) {
      const t = coolNextAt - coolStartAt;
      const rate = crackleRate(t);
      if (rate <= 0) { stopCool(true); return; }
      if (coolNextAt >= now()) crackleClick(coolNextAt, crackleLevel(t));
      // Random (Poisson) gap to the next click.
      coolNextAt += -Math.log(1 - Math.random()) / rate;
    }
  }

  function crackleClick(at, level) {
    if (Math.random() < 0.22) {
      // Occasional bright "tick" from glass contracting.
      ping(2800 + Math.random() * 2600, at, level * 0.5, 0.001, 0.035, coolGainBus);
      return;
    }
    const dur = 0.006 + Math.random() * 0.02;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level * (0.5 + Math.random() * 0.5), at + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(g).connect(coolFilter);
    src.start(at, Math.random() * 1.9, dur + 0.01);
    track(src, g);
  }

  function stopCool(fade) {
    clearInterval(coolTimer);
    coolTimer = 0;
    if (!coolFilter) return;
    const filt = coolFilter;
    const bus = coolGainBus;
    coolFilter = null;
    coolGainBus = null;
    if (fade && ready()) bus.gain.setTargetAtTime(0, now(), 0.15);
    setTimeout(() => {
      try { filt.disconnect(); } catch {}
      try { bus.disconnect(); } catch {}
    }, 1200);
  }

  // ----- public API -----

  const api = {
    unlock: safe(() => {
      if (failed) return Promise.resolve(false);
      if (!ctx && !build()) return Promise.resolve(false);
      if (ctx.state === 'closed') return Promise.resolve(false);
      applyFurnace();
      if (ctx.state === 'suspended') {
        return ctx.resume().then(() => true, () => false);
      }
      return Promise.resolve(true);
    }),

    setEnabled: safe((on) => {
      enabled = !!on;
      if (ready()) master.gain.setTargetAtTime(enabled ? volume : 0, now(), 0.06);
    }),

    isEnabled: () => enabled,

    setVolume: safe((v) => {
      volume = clamp01(v);
      if (ready() && enabled) master.gain.setTargetAtTime(volume, now(), 0.06);
    }),

    furnace: safe((on) => {
      furnaceWanted = !!on;
      applyFurnace();
    }),

    breathe: safe((level) => {
      if (!ready() || !fur) return;
      const l = clamp01(level);
      if (Math.abs(l - lastLevel) < 0.004) return; // skip tiny changes
      lastLevel = l;
      const tg = breathTargets(l);
      const t = now();
      fur.roar.gain.setTargetAtTime(tg.roarGain, t, 0.15);
      fur.lp.frequency.setTargetAtTime(tg.cutoff, t, 0.15);
      fur.rumble.gain.setTargetAtTime(tg.rumbleGain, t, 0.25);
    }),

    bandSet: safe((depth) => {
      if (!ready()) return;
      const f = tinkFrequency(depth) * centsToRatio((Math.random() * 2 - 1) * 6);
      const e = tinkEnvelope(depth);
      const t = now() + 0.005;
      ping(f, t, e.peak * 0.6, e.attack, e.decay);
      ping(f * 2.76, t, e.peak * 0.25, e.attack, e.decay * 0.45); // glassy overtone
      ping(f * 0.5, t, e.peak * 0.4 * e.body, 0.008, e.decay * 1.2); // body
    }),

    cut: safe(() => {
      if (!ready()) return;
      const t = now() + 0.01;
      for (const p of CUT_PARTIALS) {
        ping(CUT_FREQ * p.ratio, t, CUT_PEAK * p.level, 0.012, p.decay);
      }
    }),

    coolStart: safe(() => {
      if (!ready()) return;
      stopCool(true);
      coolGainBus = ctx.createGain();
      coolGainBus.gain.value = 1;
      coolGainBus.connect(fxBus);
      coolFilter = ctx.createBiquadFilter();
      coolFilter.type = 'bandpass';
      coolFilter.frequency.value = 3200;
      coolFilter.Q.value = 2.5;
      coolFilter.connect(coolGainBus);
      coolStartAt = now() + 0.05;
      coolNextAt = coolStartAt;
      scheduleCrackle();
      coolTimer = setInterval(safe(scheduleCrackle), 50);
    }),

    coolStop: safe(() => stopCool(true)),

    achievement: safe(() => {
      if (!ready()) return;
      const t = now() + 0.01;
      for (const n of ACHIEVEMENT_NOTES) {
        ping(n.freq, t + n.at, 0.09, 0.02, n.decay, fxBus, 'triangle');
        ping(n.freq * 2, t + n.at, 0.025, 0.02, n.decay * 0.6);
      }
    }),

    rare: safe(() => {
      if (!ready()) return;
      const t = now() + 0.01;
      for (const p of sparklePartials()) {
        ping(p.freq, t + p.at, p.level, 0.03, p.decay);
      }
    }),

    stopAll: safe(() => {
      furnaceWanted = false;
      applyFurnace();
      stopCool(true);
      if (!ready()) return;
      fxBus.gain.setTargetAtTime(0, now(), 0.08);
      setTimeout(safe(() => {
        if (!ready()) return;
        for (const s of [...live]) { try { s.stop(); } catch {} }
        fxBus.gain.setTargetAtTime(1, now(), 0.02); // nothing is playing now
      }), 500);
    }),

    dispose: safe(() => {
      clearTimeout(furnaceStopTimer);
      stopCool(false);
      stopFurnaceNodes();
      live.clear();
      if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
      ctx = null;
      failed = true; // stay a no-op after dispose
    }),
  };

  return api;
}
