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

export function createSignals({ apiKey, enableTelemetry = false, source = 'camera', replayLoop = false } = {}) {
  const em = createEmitter();
  const emit = (name, payload) => em.emit(name, payload);
  const isReplay = source && typeof source === 'object' && typeof source.replayUrl === 'string';
  const processor = createProcessor(emit, { namer: makeValidationNamer(ValidationCode) });
  let sdk = null;
  let replay = null;
  let stopping = false;
  let destroyed = false;

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
        await sdk.start();
      } catch (e) {
        fail(e?.code ?? 'START_FAILED', e?.message || e, e?.retryable ?? true);
      }
    },

    async stop() {
      stopping = true;
      if (replay) { replay.stop(); status('Idle'); return; }
      if (!sdk) return;
      try { await sdk.stop(); }
      catch (e) { if (e?.code !== INVALID_STATE) fail(e?.code ?? 'STOP_FAILED', e?.message || e, true); }
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopping = true;
      replay?.stop();
      processor.dispose();
      try { sdk?.destroy(); } catch { /* already gone */ }
      sdk = null;
      em.clear();
    },
  };
}
