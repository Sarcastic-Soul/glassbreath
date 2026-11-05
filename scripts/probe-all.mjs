// Requests every metric bundle and reports which groups/fields the API key actually returns.
import {
  SmartSpectraSDK, CameraSelection, breathingMetrics, cardioMetrics, faceMetrics,
  edaMetrics, micromotionMetrics, decodeMetrics,
} from '@smartspectra/node-sdk';

const seconds = Number(process.env.PROBE_SECONDS ?? 40);
const seen = {};
let last;
const sdk = new SmartSpectraSDK({
  apiKey: process.env.SMARTSPECTRA_API_KEY,
  requestedMetrics: [...new Set([...breathingMetrics, ...cardioMetrics, ...faceMetrics, ...edaMetrics, ...micromotionMetrics])],
  enableTelemetry: false,
});
sdk.on('validationStatus', (code, _ts, hint) => console.log('validation:', code, hint));
sdk.on('error', (code, msg, r) => console.error('error:', code, msg, r));
sdk.on('metrics', (buf) => {
  const m = decodeMetrics(buf);
  if (Buffer.isBuffer(m)) return;
  last = m;
  for (const [group, val] of Object.entries(m.toJSON ? m.toJSON() : m)) {
    if (!val || typeof val !== 'object') continue;
    for (const [field, v] of Object.entries(val)) {
      if (Array.isArray(v) ? v.length : v != null) (seen[group] ??= new Set()).add(field);
    }
  }
});
sdk.useCamera(CameraSelection.byId(SmartSpectraSDK.availableCameras()[0].id));
sdk.start();
setTimeout(async () => {
  await sdk.stopAsync();
  console.log('FIELDS SEEN:', Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v]])));
  const j = last?.toJSON ? last.toJSON() : last;
  console.log('LAST SAMPLE:', JSON.stringify({
    pulse: j?.cardio?.pulseRate?.at(-1), breath: j?.breathing?.rate?.at(-1), hrv: j?.cardio?.hrv?.at(-1),
    expression: j?.face?.expression?.at(-1), blinking: j?.face?.blinking?.at(-1), eda: j?.eda?.trace?.at(-1),
  }));
  await sdk.destroy();
  process.exit(0);
}, seconds * 1000);
