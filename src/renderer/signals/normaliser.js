// Rolling normaliser: centres a signal on its recent mean and scales it by its
// recent spread, so a typical breath swings about -1..1 whatever the user's
// raw trace units are. Window is in sample time (ms), not wall time.

export function createRollingNormaliser({ windowMs = 20000, spread = 1.5, clamp = 1.25, minStd = 1e-9 } = {}) {
  let buf = []; // [t, v]
  let head = 0;
  let sum = 0;
  let sumSq = 0;

  function trim(now) {
    while (head < buf.length && now - buf[head][0] > windowMs) {
      const v = buf[head][1];
      sum -= v; sumSq -= v * v;
      head++;
    }
    if (head > 512 && head > buf.length / 2) { buf = buf.slice(head); head = 0; }
  }

  return {
    /** Adds a sample and returns its normalised value. */
    push(t, v) {
      if (!Number.isFinite(t) || !Number.isFinite(v)) return 0;
      buf.push([t, v]);
      sum += v; sumSq += v * v;
      trim(t);
      const n = buf.length - head;
      const mean = sum / n;
      const variance = Math.max(0, sumSq / n - mean * mean);
      const std = Math.sqrt(variance);
      if (n < 3 || std <= Math.max(minStd, Math.abs(mean) * 1e-9)) return 0;
      const x = (v - mean) / (spread * std);
      return Math.max(-clamp, Math.min(clamp, x));
    },
    get count() { return buf.length - head; },
    reset() { buf = []; head = 0; sum = 0; sumSq = 0; },
  };
}
