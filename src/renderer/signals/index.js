// Glassbreath signals: live camera (SmartSpectra renderer SDK) or replay.
// Usage:
//   const s = createSignals({ apiKey, enableTelemetry: false, source: 'camera' });
//   s.on('breath', ({ t, chest, phase, depth }) => ...);
//   await s.start();
// See build-notes/CONTRACT.md for every event.

import {
  SmartSpectraSDK, ProcessingStatus, ValidationCode, SmartSpectraErrorCode,
  breathingMetrics, cardioMetrics, faceMetrics,
} from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import { createEmitter } from './emitter.js';
import { createProcessor } from './processor.js';
import { createReplaySource } from './replay.js';
import { makeValidationNamer } from './validation.js';

export { smileScore } from './face.js';

const STATUS_NAMES = Object.fromEntries(Object.entries(ProcessingStatus).map(([k, v]) => [v, k.replace(/^k/, '')]));
const INVALID_STATE = SmartSpectraErrorCode?.kInvalidState ?? 1;

// The SDK wants about 30 fps. Many laptop webcams offer 1280x720 at 30 fps only in
// MJPEG and fall back to 10 fps raw, which the SDK rejects ("at least 25 frames per
// second"). Asking for a minimum frame rate makes the browser pick a fast mode.
// The SDK copies every frame on the renderer thread (drawImage + getImageData +
// IPC). At 1280x720 that cannot keep 25+ fps on an average laptop, and below
// 25 fps the SDK marks every frame invalid. 640x360, scaled by Chrome from the
// camera's native mode, is 4x less work and still shows the chest clearly.
const CAMERA_TRIES = [
  { width: { ideal: 640 }, height: { ideal: 360 }, resizeMode: 'crop-and-scale', frameRate: { min: 25, ideal: 30 }, facingMode: 'user' },
  { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { min: 25, ideal: 30 }, facingMode: 'user' },
  { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 }, facingMode: 'user' },
];

// Once processing runs, the SDK locks exposure with applyConstraints({ advanced }).
// That call replaces every constraint, so the track jumps back to the camera's
// native 1280x720. Merge our size and frame rate back into any later call.
function keepSize(stream, base) {
  const track = stream.getVideoTracks()[0];
  if (track && typeof track.applyConstraints === 'function') {
    const apply = track.applyConstraints.bind(track);
    track.applyConstraints = (c = {}) => apply({ ...base, ...c });
  }
  return stream;
}

// The SDK locks exposure and white balance once processing runs, and many webcam
// drivers keep that manual setting after the app closes. The next session would
// then start from the old (often dark) exposure and never adjust. Ask for auto
// modes first, so the camera adjusts to the room before the SDK locks it again.
async function unlockAuto(stream, base) {
  const track = stream.getVideoTracks()[0];
  if (!track || typeof track.getCapabilities !== 'function') return;
  const caps = track.getCapabilities() || {};
  const want = {};
  if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) want.exposureMode = 'continuous';
  if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('continuous')) want.whiteBalanceMode = 'continuous';
  if (!Object.keys(want).length) return;
  try { await track.applyConstraints({ ...base, advanced: [want] }); }
  catch (e) { console.warn('[signals] could not switch the camera to auto exposure', e); }
}

async function openCamera() {
  let lastErr;
  for (const video of CAMERA_TRIES) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      await unlockAuto(stream, video);
      return keepSize(stream, video);
    }
    catch (e) {
      lastErr = e;
      // Only a constraint mismatch is worth another try; denial or busy camera is final.
      if (e?.name !== 'OverconstrainedError' && e?.name !== 'ConstraintNotSatisfiedError') break;
    }
  }
  throw lastErr;
}

export function createSignals({ apiKey, enableTelemetry = false, source = 'camera', replayLoop = false } = {}) {
  const em = createEmitter();
  const emit = (name, payload) => em.emit(name, payload);
  const isReplay = source && typeof source === 'object' && typeof source.replayUrl === 'string';
  const processor = createProcessor(emit, { namer: makeValidationNamer(ValidationCode) });
  let sdk = null;
  let replay = null;
  let stopping = false;
  let destroyed = false;
  let stream = null;

  function releaseCamera() {
    for (const t of stream?.getTracks?.() ?? []) { try { t.stop(); } catch { /* already stopped */ } }
    stream = null;
  }

  function status(name) { emit('status', { name, replay: !!isReplay }); }

  function fail(code, message, retryable) {
    emit('error', { code, message: String(message || 'Unknown error'), retryable: !!retryable });
  }

  function buildSdk() {
    sdk = new SmartSpectraSDK({
      apiKey,
      requestedMetrics: [...new Set([...breathingMetrics, ...cardioMetrics, ...faceMetrics])],
      enableTelemetry: !!enableTelemetry,
    });
    sdk.on('streamAvailable', (stream) => emit('stream', stream));
    sdk.on('processingStatus', (s) => status(STATUS_NAMES[s] ?? `Status${s}`));
    sdk.on('validationStatus', (code, _ts, hint) => processor.handleValidation(code, hint));
    sdk.on('metrics', (buf) => {
      let m;
      try { m = decodeMetrics(buf); } catch (e) { console.warn('[signals] decode failed', e); return; }
      processor.handleMetrics(m);
    });
    sdk.on('error', (code, message, retryable) => {
      // The native SDK reports kInvalidState once while it moves from Running
      // to Stopping (its camera/frame path is still delivering). Harmless.
      if (stopping && code === INVALID_STATE) return;
      fail(code, message, retryable);
    });
  }

  function buildReplay() {
    replay = createReplaySource({
      url: source.replayUrl,
      loop: replayLoop,
      onMetrics: (m) => processor.handleMetrics(m),
      onValidation: (code, hint) => processor.handleValidation(code, hint),
      onTimeOffset: (ms) => processor.setTimeOffset(ms),
      onEnd: () => status('ReplayEnded'),
    });
  }

  return {
    on: em.on,
    off: em.off,
    get isReplay() { return !!isReplay; },

    async start() {
      if (destroyed) throw new Error('signals destroyed');
      stopping = false;
      if (isReplay) {
        if (!replay) buildReplay();
        status('Starting');
        try { await replay.start(); status('Running'); }
        catch (e) { fail('REPLAY_LOAD_FAILED', e?.message || e, true); }
        return;
      }
      if (!apiKey) { fail('NO_API_KEY', 'No SmartSpectra API key. Set SMARTSPECTRA_API_KEY or app/.env.', false); return; }
      try {
        if (!sdk) buildSdk();
        if (!stream || stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
          stream = await openCamera();
          sdk.useMediaStream(stream);
          emit('stream', stream);
        }
        await sdk.start();
      } catch (e) {
        if (e?.name === 'NotAllowedError' || e?.name === 'NotReadableError' || e?.name === 'NotFoundError') {
          fail('CAMERA_FAILED', `${e.name}: ${e.message}`, true);
          return;
        }
        fail(e?.code ?? 'START_FAILED', e?.message || e, e?.retryable ?? true);
      }
    },

    async stop() {
      stopping = true;
      if (replay) { replay.stop(); status('Idle'); return; }
      if (!sdk) return;
      try { await sdk.stop(); }
      catch (e) { if (e?.code !== INVALID_STATE) fail(e?.code ?? 'STOP_FAILED', e?.message || e, true); }
      finally { releaseCamera(); }
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopping = true;
      replay?.stop();
      processor.dispose();
      try { sdk?.destroy(); } catch { /* already gone */ }
      sdk = null;
      releaseCamera();
      em.clear();
    },
  };
}
