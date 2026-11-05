// Measures how fast each signal arrives: events/sec, samples/sec per field,
// and delay between a sample's timestamp and when we receive it.
import {
  SmartSpectraSDK, CameraSelection, breathingMetrics, cardioMetrics, faceMetrics, decodeMetrics,
} from '@smartspectra/node-sdk';

const seconds = Number(process.env.PROBE_SECONDS ?? 60);
const fields = {
  upperTrace: (m) => m.breathing?.upperTrace,
  breathRate: (m) => m.breathing?.rate,
  pulseRate: (m) => m.cardio?.pulseRate,
  arterial: (m) => m.cardio?.arterialPressureTrace,
  blinking: (m) => m.face?.blinking,
  talking: (m) => m.face?.talking,
  expression: (m) => m.face?.expression,
  landmarks: (m) => m.face?.landmarks,
};
const stats = Object.fromEntries(Object.keys(fields).map((k) => [k, { events: 0, samples: 0, delays: [] }]));
let events = 0;
let firstEventAt = null;
const samplesShown = {};
const ts = (t) => (t == null ? null : typeof t === 'object' && t.toNumber ? t.toNumber() : Number(t));

const sdk = new SmartSpectraSDK({
  apiKey: process.env.SMARTSPECTRA_API_KEY,
  requestedMetrics: [...new Set([...breathingMetrics, ...cardioMetrics, ...faceMetrics])],
  enableTelemetry: false,
});
sdk.on('validationStatus', (code, _t, hint) => console.log('validation:', code, hint));
sdk.on('error', (code, msg) => console.error('error:', code, msg));
sdk.on('metrics', (buf) => {
  const m = decodeMetrics(buf);
  if (Buffer.isBuffer(m)) return;
  const nowUs = Date.now() * 1000;
  events++;
  firstEventAt ??= Date.now();
  for (const [k, get] of Object.entries(fields)) {
    const arr = get(m);
    if (!arr?.length) continue;
    const s = stats[k];
    s.events++;
    s.samples += arr.length;
    const newest = ts(arr.at(-1).timestamp);
    if (newest) s.delays.push((nowUs - newest) / 1000);
    if (!samplesShown[k]) { samplesShown[k] = true; console.log(`first ${k}:`, JSON.stringify(arr.at(-1))); }
  }
});
sdk.useCamera(CameraSelection.byId(SmartSpectraSDK.availableCameras()[0].id));
sdk.start();
console.log(`Probing ${seconds}s. Sit still facing camera, breathe slowly, blink now and then.`);
setTimeout(async () => {
  const span = (Date.now() - (firstEventAt ?? Date.now())) / 1000 || 1;
  console.log(`\nmetrics events: ${events} over ${span.toFixed(1)}s = ${(events / span).toFixed(1)}/s`);
  for (const [k, s] of Object.entries(stats)) {
    if (!s.events) { console.log(`${k}: none`); continue; }
    const d = s.delays.sort((a, b) => a - b);
    const med = d[Math.floor(d.length / 2)];
    console.log(`${k}: ${(s.samples / span).toFixed(1)} samples/s, in ${s.events} events, median delay ${med?.toFixed(0)} ms, p90 ${d[Math.floor(d.length * 0.9)]?.toFixed(0)} ms`);
  }
  try { await sdk.stopAsync(); } catch {}
  try { await sdk.destroy(); } catch {}
  process.exit(0);
}, seconds * 1000);
