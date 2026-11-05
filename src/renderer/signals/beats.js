// Beat (peak) detector for the relative arterial waveform. This is only the
// waveform's shape: never present it as blood pressure. No SDK imports.
//
// Streaming: centre on a rolling mean, arm when the signal dips below the
// mean, track the max while above it, and confirm a peak once the signal has
// fallen `dropStd` standard deviations below that max. A refractory period
// stops double counts. Works the same whether samples come one by one or in
// batches (the SDK delivers this trace ~7 samples at a time).

export function createBeatDetector({
  windowMs = 5000,
  minIntervalMs = 333, // 180 bpm ceiling
  riseStd = 0.35, // peak must clear mean + riseStd * std
  dropStd = 0.35, // confirm when signal drops this far below the max
  strengthStd = 2.5, // peak height (in std) that maps to strength 1
} = {}) {
  let buf = [];
  let sum = 0;
  let sumSq = 0;
  let lastT = null;
  let armed = false;
  let cand = null; // { t, v }
  let lastBeatT = -Infinity;

  return {
    /** Feed one sample; returns { t, strength } when a beat is confirmed, else null. */
    push(t, v) {
      if (!Number.isFinite(t) || !Number.isFinite(v)) return null;
      if (lastT != null && t <= lastT) return null;
      if (lastT != null && t - lastT > 2000) { buf = []; sum = 0; sumSq = 0; armed = false; cand = null; }
      lastT = t;
      buf.push([t, v]); sum += v; sumSq += v * v;
      while (buf.length && t - buf[0][0] > windowMs) { const o = buf.shift()[1]; sum -= o; sumSq -= o * o; }
      const n = buf.length;
      if (n < 10) return null;
      const mean = sum / n;
      const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
      if (!(std > 0)) return null;

      if (v < mean) { armed = true; }
      if (!armed) return null;
      if (v > mean + riseStd * std && (!cand || v > cand.v)) cand = { t, v };
      if (cand && cand.v - v >= dropStd * std) {
        const peak = cand;
        cand = null;
        armed = v < mean;
        if (peak.t - lastBeatT < minIntervalMs) return null;
        lastBeatT = peak.t;
        const strength = Math.max(0, Math.min(1, (peak.v - mean) / (strengthStd * std)));
        return { t: peak.t, strength };
      }
      return null;
    },
    reset() { buf = []; sum = 0; sumSq = 0; lastT = null; armed = false; cand = null; lastBeatT = -Infinity; },
  };
}
