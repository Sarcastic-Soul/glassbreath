// Face payload helpers: smile score and edge detection. No SDK imports.
//
// Expression shape (docs_data-types.md): face.expression[] = {
//   stable: bool, timestamp: int64 us,
//   scores: [{ type: ExpressionType, confidence: 0..100 }] }
// ExpressionType HAPPY = 5. After protobufjs toJSON(), `type` is the string
// "HAPPY" and fields with default values (0 / false) may be missing.

export const HAPPY = 5;

/** Smile score 0..1 from one Expression entry, or null when there is none. */
export function smileScore(expression) {
  const scores = expression?.scores;
  if (!Array.isArray(scores) || scores.length === 0) return null;
  for (const s of scores) {
    if (!s) continue;
    const type = s.type;
    if (type === HAPPY || type === 'HAPPY' || type === String(HAPPY)) {
      const c = Number(s.confidence ?? 0);
      if (!Number.isFinite(c)) return 0;
      // SDK confidence is always a percentage in the range 0..100.
      const v = c / 100;
      return Math.max(0, Math.min(1, v));
    }
  }
  return 0; // scores present but HAPPY missing means 0 confidence
}

/**
 * Rising-edge detector for DetectionStatus streams (blinking).
 * push(t, detected) returns true once per new blink.
 */
export function createEdgeDetector({ minGapMs = 150 } = {}) {
  let prev = false;
  let lastEdge = -Infinity;
  return {
    push(t, detected) {
      const d = !!detected;
      const rising = d && !prev;
      prev = d;
      if (rising && t - lastEdge >= minGapMs) { lastEdge = t; return true; }
      return false;
    },
    reset() { prev = false; lastEdge = -Infinity; },
  };
}

/** Change detector for boolean state (talking). push returns the new value on change, else null. */
export function createChangeDetector(initial = false) {
  let state = initial;
  return {
    push(v) {
      const b = !!v;
      if (b === state) return null;
      state = b;
      return b;
    },
    get value() { return state; },
  };
}
