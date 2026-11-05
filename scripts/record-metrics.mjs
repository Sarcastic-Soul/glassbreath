// Records a live SmartSpectra session to JSONL for replay (no camera needed later).
// Usage: node --env-file-if-exists=.env scripts/record-metrics.mjs out.jsonl
// Env: RECORD_SECONDS (default 90), SMARTSPECTRA_API_KEY.
// Lines: {"header":{...}}, {"tMs":n,"metrics":{...}}, {"tMs":n,"validation":{code,hint}}
//
// Shutdown note: the native SDK reports error 1 (kInvalidState, "SmartSpectra is
// not in a valid state for this operation") once, right as it moves from
// Running to Stopping. It happens with stopAsync() and with destroy() alone, and
// the session still reaches Idle. So: mark that we are stopping before the
// call, ignore that one code while stopping, await stopAsync(), then
// destroy(), and only then close the file and exit.
import fs from 'node:fs';
import path from 'node:path';
import {
  SmartSpectraSDK, CameraSelection, SmartSpectraErrorCode, breathingMetrics, cardioMetrics, faceMetrics, decodeMetrics,
} from '@smartspectra/node-sdk';

const out = process.argv[2];
if (!out) { console.error('usage: record-metrics.mjs <out.jsonl>'); process.exit(2); }
const seconds = Number(process.env.RECORD_SECONDS ?? 90);
if (!process.env.SMARTSPECTRA_API_KEY) { console.error('SMARTSPECTRA_API_KEY missing'); process.exit(2); }

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const file = fs.createWriteStream(out);
const startedAtMs = Date.now();
const tMs = () => Date.now() - startedAtMs;
const write = (obj) => file.write(JSON.stringify(obj) + '\n');
write({ header: { startedAtMs, sdkVersion: SmartSpectraSDK.version, note: 'Glassbreath recording' } });

let stopping = false;
let events = 0;
const sdk = new SmartSpectraSDK({
  apiKey: process.env.SMARTSPECTRA_API_KEY,
  requestedMetrics: [...new Set([...breathingMetrics, ...cardioMetrics, ...faceMetrics])],
  enableTelemetry: false,
});
let lastCode = null;
sdk.on('validationStatus', (code, _ts, hint) => {
  write({ tMs: tMs(), validation: { code, hint } });
  if (code !== lastCode) console.log(`validation ${code} ${hint}`);
  lastCode = code;
});
sdk.on('metrics', (buf) => {
  const m = decodeMetrics(buf);
  if (Buffer.isBuffer(m)) return;
  const json = m.toJSON();
  // Landmarks are big and unused by Glassbreath; drop them to keep files small.
  if (json.face) delete json.face.landmarks;
  write({ tMs: tMs(), metrics: json });
  if (++events % 280 === 0) console.log(`${(tMs() / 1000).toFixed(0)}s, ${events} events`);
});
sdk.on('error', (code, msg, retryable) => {
  if (stopping && code === SmartSpectraErrorCode.kInvalidState) return; // expected at Stop
  console.error('error:', code, msg, retryable);
});

const cams = SmartSpectraSDK.availableCameras();
if (!cams.length) { console.error('no camera found'); process.exit(1); }
sdk.useCamera(CameraSelection.byId(cams[0].id));
sdk.start();
console.log(`Recording ${seconds}s to ${out}. Sit with face and chest in view; breathe slowly.`);

let done = false;
async function shutdown(reason) {
  if (done) return;
  done = true;
  stopping = true;
  console.log(`stopping (${reason})...`);
  try { await sdk.stopAsync(); } catch (e) { if (e?.code !== SmartSpectraErrorCode.kInvalidState) console.error('stop:', e.message); }
  try { await sdk.destroy(); } catch (e) { console.error('destroy:', e.message); }
  await new Promise((r) => file.end(r));
  console.log(`wrote ${events} metrics events to ${out}`);
  process.exit(0);
}
const timer = setTimeout(() => shutdown('time'), seconds * 1000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { clearTimeout(timer); shutdown(sig); });
