// Replay of a recorded JSONL session at real speed. Never touches the camera
// or the SDK. File format (one JSON object per line):
//   {"header": {"startedAtMs": <epoch ms>, ...}}            optional, first line
//   {"tMs": <ms since start>, "metrics": <decoded Metrics as plain JSON>}
//   {"tMs": <ms since start>, "validation": {"code": 0, "hint": "..."}}
// Sample timestamps inside `metrics` are shifted so they line up with the
// playback wall clock, so replay events look exactly like live ones.

import { toMillis } from './timestamps.js';

export function parseJsonl(text) {
  const header = {};
  const lines = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.header && typeof obj.header === 'object') { Object.assign(header, obj.header); continue; }
    const tMs = Number(obj.tMs);
    if (!Number.isFinite(tMs) || tMs < 0) continue;
    if (obj.metrics && typeof obj.metrics === 'object') lines.push({ tMs, metrics: obj.metrics });
    else if (obj.validation && typeof obj.validation === 'object') lines.push({ tMs, validation: obj.validation });
  }
  lines.sort((a, b) => a.tMs - b.tMs);
  return { header, lines };
}

function firstSampleMs(metrics) {
  let min = Infinity;
  for (const group of Object.values(metrics || {})) {
    if (!group || typeof group !== 'object') continue;
    for (const list of Object.values(group)) {
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        const t = toMillis(s?.timestamp);
        if (t != null && t < min) min = t;
      }
    }
  }
  return min;
}

/** Estimated wall-clock ms at which the recording started. */
export function recordingStartMs({ header, lines }) {
  if (Number.isFinite(Number(header.startedAtMs))) return Number(header.startedAtMs);
  for (const l of lines) {
    if (!l.metrics) continue;
    const t = firstSampleMs(l.metrics);
    if (Number.isFinite(t)) return t - l.tMs;
  }
  return 0;
}

async function defaultLoad(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    // file:// fetch is blocked in some Chromium setups; fall back to the
    // Electron preload, which reads only files under app/fixtures.
    const bridge = typeof window !== 'undefined' ? window.glassbreath : null;
    const name = String(url).split(/[\\/]/).pop();
    if (bridge?.readFixture && /^[\w.-]+\.jsonl$/.test(name)) return bridge.readFixture(name);
    throw err;
  }
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {(m: object) => void} o.onMetrics
 * @param {(code: number, hint: string) => void} o.onValidation
 * @param {(offsetMs: number) => void} o.onTimeOffset called before the first line
 * @param {() => void} [o.onEnd]
 * @param {boolean} [o.loop=false]
 */
export function createReplaySource({ url, onMetrics, onValidation, onTimeOffset, onEnd, loop = false,
  load = defaultLoad, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id) }) {
  let parsed = null;
  let timer = null;
  let running = false;
  let idx = 0;
  let playStart = 0;

  function tick() {
    timer = null;
    if (!running) return;
    const elapsed = now() - playStart;
    while (idx < parsed.lines.length && parsed.lines[idx].tMs <= elapsed) {
      const l = parsed.lines[idx++];
      if (l.metrics) onMetrics(l.metrics);
      else onValidation(Number(l.validation.code ?? 0), String(l.validation.hint ?? ''));
    }
    if (idx >= parsed.lines.length) {
      if (loop && parsed.lines.length) { begin(); return; }
      running = false;
      onEnd?.();
      return;
    }
    timer = schedule(tick, Math.max(0, parsed.lines[idx].tMs - (now() - playStart)));
  }

  function begin() {
    idx = 0;
    playStart = now();
    onTimeOffset?.(playStart - recordingStartMs(parsed));
    tick();
  }

  return {
    async start() {
      if (running) return;
      if (!parsed) parsed = parseJsonl(await load(url));
      if (!parsed.lines.length) throw new Error('Replay file has no usable lines');
      running = true;
      begin();
    },
    stop() {
      running = false;
      if (timer != null) cancel(timer);
      timer = null;
    },
    get durationMs() { return parsed?.lines.at(-1)?.tMs ?? 0; },
  };
}
