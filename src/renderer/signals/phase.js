// Breath phase detector and breath-cycle segmentation.
//
// Input: one sample at a time, (tMs, chest, raw), where `chest` is the rolling
// normalised trace (about -1..1) and `raw` is the original upperTrace value.
//
// Phase comes from the smoothed slope of `chest`, with hysteresis so small
// wobbles don't flip it:
//   inhale  -> slope clearly rising
//   exhale  -> slope clearly falling
//   hold    -> slope near zero for a while (top or bottom of a breath)
//
// Cycles come from turning points with value hysteresis: a peak is confirmed
// once the signal has dropped `turnHysteresis` below its running max, a trough
// once it has risen that much above its running min. One breath = trough ->
// peak (inhale) -> trough (exhale).
//
// Depth is the breath's raw peak-to-trough size compared with the median of
// the user's recent breaths: a typical breath sits near `typicalDepth`, a big
// one reaches 1. No SDK imports.

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function createPhaseDetector({
  smoothMs = 180, // EMA time constant for the chest value
  slopeWindowMs = 300, // slope is measured across this span
  enterSlope = 0.22, // |slope| (normalised units / s) to enter inhale / exhale
  exitSlope = 0.1, // |slope| below this counts toward hold
  holdAfterMs = 350, // slope must stay small this long before 'hold'
  turnHysteresis = 0.3, // normalised units for confirming peaks / troughs
  minBreathMs = 1500, // shorter cycles are ignored (max 40 breaths/min)
  maxBreathMs = 20000, // longer cycles are dropped (likely a pause or gap)
  historySize = 8, // recent breaths used for depth
  typicalDepth = 0.6, // depth value for a breath equal to the recent median
  gapResetMs = 2000, // a gap this long in sample time resets the state
} = {}) {
  let smooth = null;
  let lastT = null;
  let hist = []; // [t, smooth] for slope
  let phase = 'hold';
  let smallSince = null;

  // Turning point tracking (on smoothed normalised value, raw kept alongside).
  let dir = 0; // +1 looking for a peak, -1 looking for a trough, 0 unknown
  let extreme = null; // { t, v, raw }
  let lastTrough = null; // { t, v, raw }
  let lastPeak = null; // { t, v, raw } peak after lastTrough
  const amps = [];

  function resetState() {
    smooth = null; lastT = null; hist = []; phase = 'hold'; smallSince = null;
    dir = 0; extreme = null; lastTrough = null; lastPeak = null;
  }

  function refAmp() {
    return median(amps);
  }

  function depthOf(amp) {
    const ref = refAmp();
    if (!(ref > 0)) return typicalDepth;
    return clamp01((amp / ref) * typicalDepth);
  }

  /**
   * Feed one sample. Returns { phase, depth, completed } where `completed` is
   * a finished breath ({ t, depth, durationMs, inhaleMs, exhaleMs }) or null.
   */
  function push(t, chest, raw = chest) {
    if (!Number.isFinite(t) || !Number.isFinite(chest)) return { phase, depth: 0, completed: null };
    if (lastT != null && (t <= lastT)) return { phase, depth: liveDepth(raw), completed: null };
    if (lastT != null && t - lastT > gapResetMs) resetState();

    const dt = lastT == null ? 0 : t - lastT;
    lastT = t;
    smooth = smooth == null ? chest : smooth + (chest - smooth) * (1 - Math.exp(-dt / smoothMs));

    // Slope over the window.
    hist.push([t, smooth]);
    while (hist.length > 2 && t - hist[0][0] > slopeWindowMs) hist.shift();
    const span = t - hist[0][0];
    const slope = span > 0 ? ((smooth - hist[0][1]) / span) * 1000 : 0;

    // Phase with hysteresis.
    if (slope > enterSlope) { phase = 'inhale'; smallSince = null; }
    else if (slope < -enterSlope) { phase = 'exhale'; smallSince = null; }
    else if (Math.abs(slope) < exitSlope) {
      smallSince ??= t;
      if (t - smallSince >= holdAfterMs) phase = 'hold';
    } else {
      smallSince = null;
    }

    // Turning points.
    let completed = null;
    if (extreme == null) {
      extreme = { t, v: smooth, raw };
    } else if (dir >= 0) {
      if (smooth > extreme.v) extreme = { t, v: smooth, raw };
      else if (extreme.v - smooth >= turnHysteresis) {
        // Confirmed peak.
        if (lastTrough) lastPeak = { ...extreme };
        dir = -1;
        extreme = { t, v: smooth, raw };
      }
      if (dir === 0 && extreme.v - smooth >= turnHysteresis) dir = -1;
    } else {
      if (smooth < extreme.v) extreme = { t, v: smooth, raw };
      else if (smooth - extreme.v >= turnHysteresis) {
        // Confirmed trough: closes a breath if we saw trough -> peak -> here.
        const trough = { ...extreme };
        if (lastTrough && lastPeak) {
          const durationMs = trough.t - lastTrough.t;
          const inhaleMs = lastPeak.t - lastTrough.t;
          const exhaleMs = trough.t - lastPeak.t;
          if (durationMs >= minBreathMs && durationMs <= maxBreathMs && inhaleMs > 0 && exhaleMs > 0) {
            const amp = lastPeak.raw - (lastTrough.raw + trough.raw) / 2;
            if (amp > 0) {
              const depth = depthOf(amp);
              amps.push(amp);
              if (amps.length > historySize) amps.shift();
              completed = { t: trough.t, depth, durationMs, inhaleMs, exhaleMs };
            }
          }
        }
        lastTrough = trough;
        lastPeak = null;
        dir = 1;
        extreme = { t, v: smooth, raw };
      }
    }
    // Before the first confirmed turn, pick a direction from the slope.
    if (dir === 0 && Math.abs(slope) > enterSlope) dir = slope > 0 ? 1 : -1;

    return { phase, depth: liveDepth(raw), completed };
  }

  // Live size of the breath in progress: rise above the last trough.
  function liveDepth(raw) {
    if (!lastTrough || !Number.isFinite(raw)) return 0;
    const ref = refAmp();
    const rise = raw - lastTrough.raw;
    if (!(ref > 0)) {
      // No history yet: fall back to the normalised value (about -1..1).
      // A typical breath spans ~1.9 normalised units peak to trough.
      return clamp01((((smooth ?? 0) - lastTrough.v) / 1.9) * typicalDepth);
    }
    return clamp01((rise / ref) * typicalDepth);
  }

  return {
    push,
    get phase() { return phase; },
    get recentAmplitudes() { return [...amps]; },
    reset() { resetState(); amps.length = 0; },
  };
}
