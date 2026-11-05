// Pure palette mapping (no three.js). Breathing rate picks a calm colour family,
// pulse nudges the hue a little. No colour means "better" or "worse".

// [breaths per minute, hue deg, saturation, lightness]
const STOPS = [
  [5, 186, 0.46, 0.42], // deep teal
  [10, 168, 0.34, 0.5], // sea glass
  [15, 145, 0.26, 0.52], // jade
  [21, 72, 0.3, 0.52], // peridot
  [28, 36, 0.42, 0.5], // honey
  [40, 26, 0.46, 0.46], // amber
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** { breathRate 5..40, pulse 40..110 } -> palette description with sRGB hex colours. */
export function paletteFor({ breathRate, pulse } = {}) {
  const rate = clamp(num(breathRate, 12), 5, 40);
  const bpm = clamp(num(pulse, 72), 40, 110);
  let i = 0;
  while (i < STOPS.length - 2 && rate > STOPS[i + 1][0]) i++;
  const a = STOPS[i], b = STOPS[i + 1];
  const t = clamp((rate - a[0]) / (b[0] - a[0]), 0, 1);
  const p = (bpm - 75) / 35; // -1..1
  const hue = lerp(a[1], b[1], t) + 9 * p;
  const sat = clamp(lerp(a[2], b[2], t) + 0.04 * p, 0, 1);
  const light = clamp(lerp(a[3], b[3], t) + 0.03 * p, 0.2, 0.8);
  return {
    breathRate: Math.round(rate * 10) / 10,
    pulse: Math.round(bpm),
    hue: Math.round(hue * 10) / 10,
    sat: Math.round(sat * 1000) / 1000,
    light: Math.round(light * 1000) / 1000,
    color: hslToHex(hue, sat, light),
    attenuation: hslToHex(hue, clamp(sat + 0.06, 0, 1), clamp(light + 0.28, 0, 0.86)),
    rim: hslToHex(hue + 12, clamp(sat - 0.15, 0, 1), clamp(light + 0.3, 0, 0.92)),
  };
}
