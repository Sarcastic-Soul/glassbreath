// Smoke test: proves the native runtime loads, lists cameras, and (if an API key
// is set) runs a short live measurement printing pulse / breathing / HRV.
import {
  SmartSpectraSDK, CameraSelection, breathingMetrics, cardioMetrics, decodeMetrics,
} from '@smartspectra/node-sdk';

const cameras = SmartSpectraSDK.availableCameras();
console.log('Cameras:', cameras);

if (process.argv.includes('--cameras-only')) process.exit(0);

const apiKey = process.env.SMARTSPECTRA_API_KEY;
if (!apiKey) {
  console.error('SMARTSPECTRA_API_KEY not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const seconds = Number(process.env.SMOKE_SECONDS ?? 45);
const sdk = new SmartSpectraSDK({
  apiKey,
  requestedMetrics: [...breathingMetrics, ...cardioMetrics],
  enableTelemetry: false,
});

sdk.on('processingStatus', (s) => console.log('status:', s));
sdk.on('validationStatus', (code, _ts, hint) => console.log('validation:', code, hint));
sdk.on('error', (code, msg, retryable) => console.error('error:', code, msg, 'retryable=', retryable));
sdk.on('metrics', (buf) => {
  const m = decodeMetrics(buf);
  if (Buffer.isBuffer(m)) return;
  const p = m.cardio?.pulseRate?.at(-1);
  const b = m.breathing?.rate?.at(-1);
  const h = m.cardio?.hrv?.at(-1);
  console.log({
    pulse: p?.value?.toFixed?.(1), pulseConf: p?.confidence?.toFixed?.(2),
    breath: b?.value?.toFixed?.(1), breathConf: b?.confidence?.toFixed?.(2),
    rmssd: h?.rmssd,
  });
});

const shutdown = async () => {
  await sdk.stopAsync();
  await sdk.destroy();
  process.exit(0);
};
process.on('SIGINT', shutdown);

sdk.useCamera(cameras[0] ? CameraSelection.byId(cameras[0].id) : CameraSelection.default);
sdk.start();
console.log(`Measuring for ${seconds}s. Sit still, face the camera, good light.`);
setTimeout(shutdown, seconds * 1000);
