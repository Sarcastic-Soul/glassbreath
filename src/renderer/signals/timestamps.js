// Turns SDK sample timestamps into plain numbers.
// The SDK sends int64 microseconds as a protobufjs Long, a decimal string
// (after toJSON), a bigint, or a plain number. No SDK imports here.

const TWO_32 = 4294967296;

/** Returns microseconds as a finite number, or null if it can't be read. */
export function toMicros(t) {
  if (t == null) return null;
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  if (typeof t === 'bigint') return Number(t);
  if (typeof t === 'string') {
    const s = t.trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof t === 'object') {
    if (typeof t.toNumber === 'function') {
      const n = t.toNumber();
      return Number.isFinite(n) ? n : null;
    }
    // Long-like plain object { low, high, unsigned } (e.g. after structured clone).
    if (typeof t.low === 'number' && typeof t.high === 'number') {
      const low = t.low >>> 0;
      const n = t.unsigned ? (t.high >>> 0) * TWO_32 + low : t.high * TWO_32 + low;
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/** Returns milliseconds (float) or null. */
export function toMillis(t) {
  const us = toMicros(t);
  return us == null ? null : us / 1000;
}
