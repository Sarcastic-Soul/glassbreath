// Glassbreath UI shell: consent -> furnace warm-up -> blowing -> cut + cool -> rack.
// Signals come from the SmartSpectra SDK (or a labelled sample recording);
// the glass module turns them into the vessel.

import { createSignals } from './signals/index.js';
import { createGlassStage, paletteFor } from './glass/index.js';
import { createTrace } from './ui/trace.js';
import { createRack } from './ui/rack.js';
import { vesselName, paceText } from './ui/names.js';
import { createShareDialog } from './ui/share.js';

const TARGET_BREATHS = 10;
const MIN_BREATHS_TO_CUT = 3;
const WARMUP_MS = 30_000;
const SMILE_THRESHOLD = 0.55;
const SMILE_HOLD_MS = 700;
const SAMPLE_RECORDING = '../../fixtures/sample-session.jsonl';
const SYNTHETIC_RECORDING = '../../fixtures/synthetic-session.jsonl';

const $ = (id) => document.getElementById(id);
const els = {
  body: document.body,
  sourceBadge: $('source-badge'), sourceLabel: $('source-label'), nav: $('nav'), stopBtn: $('btn-stop'),
  consent: $('consent'), stage: $('stage'), rack: $('rack'),
  cameraBtn: $('btn-camera'), replayBtn: $('btn-replay'), teleToggle: $('tele-toggle'), teleText: $('tele-text'),
  dataBtn: $('btn-data'), dataDialog: $('data-dialog'), consentError: $('consent-error'),
  glassCanvas: $('glass'), traceCanvas: $('trace'), preview: $('preview'), camTag: $('cam-tag'), hint: $('hint'),
  countMain: $('count-main'), countSub: $('count-sub'), heat: $('heat'), heatFill: $('heat-fill'), heatText: $('heat-text'),
  cutHint: $('cut-hint'), smileFill: $('smile-fill'), read: document.querySelector('#stage .read'), readRate: $('read-rate'), readPulse: $('read-pulse'),
  done: $('done'), doneName: $('done-name'), doneMeta: $('done-meta'), keepBtn: $('btn-keep'), againBtn: $('btn-again'), shareBtn: $('btn-share'),
  errorBanner: $('error-banner'), errorText: $('error-text'), retryBtn: $('btn-retry'),
};

const bridge = window.glassbreath;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const glass = createGlassStage(els.glassCanvas, { reducedMotion });
const trace = createTrace(els.traceCanvas);
const rack = createRack({
  shelf: $('shelf'), empty: $('rack-empty'), sub: $('rack-sub'),
  deleteAllBtn: $('btn-delete-all'), confirmDialog: $('confirm-dialog'), store: bridge,
  onShare: (v) => share.open(v),
});
const share = createShareDialog({
  dialog: $('share-dialog'), preview: $('share-preview'), paceToggle: $('share-pace'), status: $('share-status'),
  copyBtn: $('share-copy'), saveBtn: $('share-save'), xBtn: $('share-x'), bskyBtn: $('share-bsky'), store: bridge,
});

let config = { apiKey: '', enableTelemetry: false, replay: null };
let signals = null;
let source = null; // 'camera' | 'replay'

const session = {
  phase: 'off', // off | warming | blowing | cooling | done
  validOk: false,
  talking: false,
  validMs: 0,
  lastTick: 0,
  breaths: 0,
  rates: [],
  pulses: [],
  rate: null,
  pulse: null,
  smileSince: 0,
  hint: '',
  breathPhase: 'hold',
  palette: null,
  kept: false,
};

// ---------- screens ----------
function show(screen) {
  for (const s of ['consent', 'stage', 'rack']) els[s].hidden = s !== screen;
  els.body.dataset.screen = screen;
  els.nav.hidden = screen === 'consent';
  for (const b of els.nav.querySelectorAll('[data-go]')) b.classList.toggle('on', b.dataset.go === screen);
  if (screen === 'rack') rack.refresh();
}

els.nav.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]')?.dataset.go;
  if (!go) return;
  if (go === 'stage' && session.phase === 'done') startNewVessel();
  show(go);
});

// ---------- consent ----------
function updateTeleText() {
  els.teleText.textContent = els.teleToggle.checked
    ? 'Share anonymous usage counts with Presage: on. No video or readings are ever sent.'
    : 'Share anonymous usage counts with Presage: off.';
}
els.teleToggle.addEventListener('change', updateTeleText);
els.dataBtn.addEventListener('click', () => els.dataDialog.showModal());
els.cameraBtn.addEventListener('click', () => begin('camera'));
els.replayBtn.addEventListener('click', () => begin('replay'));
els.stopBtn.addEventListener('click', () => end());

async function pickRecording() {
  // Prefer a real recorded session if one is bundled, else the synthetic one.
  for (const name of [config.replay && `../../fixtures/${config.replay}`, SAMPLE_RECORDING, SYNTHETIC_RECORDING]) {
    if (!name) continue;
    try { await bridge.readFixture(name.split('/').pop()); return name; } catch { /* try next */ }
  }
  return SYNTHETIC_RECORDING;
}

async function begin(kind) {
  els.consentError.hidden = true;
  if (kind === 'camera' && !config.apiKey) {
    els.consentError.textContent = 'No Presage API key found. Add SMARTSPECTRA_API_KEY to app/.env (see README), then restart. You can still try the sample recording.';
    els.consentError.hidden = false;
    return;
  }
  source = kind;
  const replayUrl = kind === 'replay' ? await pickRecording() : null;
  signals = createSignals({
    apiKey: config.apiKey,
    enableTelemetry: els.teleToggle.checked,
    source: kind === 'camera' ? 'camera' : { replayUrl },
    replayLoop: true,
  });
  wireSignals(signals);
  els.sourceBadge.hidden = false;
  els.sourceBadge.classList.toggle('replay', kind === 'replay');
  els.sourceLabel.textContent = kind === 'camera' ? 'Live camera' : 'Sample recording (not live)';
  // A recording has no video, so drop the empty preview box.
  els.preview.hidden = kind !== 'camera';
  els.camTag.hidden = kind !== 'camera';
  els.stopBtn.innerHTML = kind === 'camera'
    ? '<i class="ph ph-power"></i>Turn off camera'
    : '<i class="ph ph-stop"></i>Stop recording';
  resetSession();
  session.phase = 'warming';
  show('stage');
  render();
  await signals.start();
}

async function end() {
  const s = signals;
  signals = null;
  if (s) {
    try { await s.stop(); } catch { /* reported via error event */ }
    s.destroy();
  }
  els.preview.srcObject = null;
  els.sourceBadge.hidden = true;
  session.phase = 'off';
  glass.reset();
  trace.clear();
  hideError();
  show('consent');
}

// ---------- signals ----------
function wireSignals(s) {
  s.on('stream', (stream) => {
    els.preview.srcObject = stream;
    els.preview.play().catch(() => {});
  });
  s.on('validation', (v) => {
    session.validOk = v.ok;
    session.hint = v.ok ? '' : (v.hint || v.name || 'Adjusting…');
    applyFreeze();
  });
  s.on('talking', ({ active }) => {
    session.talking = !!active;
    applyFreeze();
  });
  s.on('breath', (b) => {
    trace.push(b.t, b.chest);
    if (canShape()) glass.breath(b);
    const ph = b.phase === 'inhale' || b.phase === 'exhale' ? b.phase : 'hold';
    if (ph !== session.breathPhase) { session.breathPhase = ph; if (session.phase === 'blowing') render(); }
  });
  s.on('breathComplete', (c) => {
    if (session.phase !== 'blowing' || !canShape()) return;
    glass.commitBreath(c);
    session.breaths += 1;
    render();
    flashCount();
  });
  s.on('rate', (r) => {
    if (r.stable && Number.isFinite(r.bpm)) { session.rate = r.bpm; pushRecent(session.rates, r.bpm); }
    render();
  });
  s.on('pulse', (p) => {
    if (p.stable && Number.isFinite(p.bpm)) { session.pulse = p.bpm; pushRecent(session.pulses, p.bpm); }
    render();
  });
  s.on('beat', ({ strength }) => {
    if (session.phase === 'warming' || session.phase === 'blowing') glass.heartbeat(strength ?? 1);
  });
  s.on('smile', ({ score }) => onSmile(score));
  s.on('ready', ({ breathing }) => {
    if (breathing && session.phase === 'warming') startBlowing();
  });
  s.on('status', ({ name }) => {
    if (name === 'ReplayEnded' && session.phase === 'blowing' && session.breaths >= MIN_BREATHS_TO_CUT) cutGlass();
  });
  s.on('error', (e) => {
    console.error('[glassbreath] signal error', e);
    showError(friendlyError(e), e.retryable);
  });
}

function pushRecent(list, v) {
  list.push(v);
  if (list.length > 40) list.shift();
}

function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function canShape() {
  return session.validOk && !session.talking;
}

function applyFreeze() {
  const live = session.phase === 'warming' || session.phase === 'blowing';
  glass.freeze(live && !canShape());
  render();
}

function onSmile(score) {
  const eligible = session.phase === 'blowing' && session.breaths >= MIN_BREATHS_TO_CUT;
  const now = performance.now();
  if (!eligible || !(score >= SMILE_THRESHOLD)) {
    session.smileSince = 0;
    els.smileFill.style.width = eligible ? `${Math.round(Math.max(0, Math.min(1, score / SMILE_THRESHOLD)) * 60)}%` : '0%';
    return;
  }
  if (!session.smileSince) session.smileSince = now;
  const held = (now - session.smileSince) / SMILE_HOLD_MS;
  els.smileFill.style.width = `${Math.round(60 + Math.min(1, held) * 40)}%`;
  if (held >= 1) cutGlass();
}

// ---------- session flow ----------
function resetSession() {
  Object.assign(session, {
    phase: 'off', validOk: false, talking: false, validMs: 0, lastTick: performance.now(),
    breaths: 0, rates: [], pulses: [], rate: null, pulse: null, smileSince: 0, hint: '', palette: null, kept: false,
  });
  glass.reset();
  glass.setHeat(0);
  trace.clear();
  els.done.hidden = true;
}

function startBlowing() {
  session.phase = 'blowing';
  glass.setHeat(1);
  render();
}

function startNewVessel() {
  glass.reset();
  glass.setHeat(1);
  session.breaths = 0;
  session.smileSince = 0;
  session.palette = null;
  session.kept = false;
  session.phase = 'blowing';
  els.done.hidden = true;
  render();
}

async function cutGlass() {
  if (session.phase !== 'blowing' || session.breaths < MIN_BREATHS_TO_CUT) return;
  session.phase = 'cooling';
  session.smileSince = 0;
  const breathRate = median(session.rates) ?? session.rate ?? 12;
  const pulse = median(session.pulses) ?? session.pulse ?? 72;
  session.palette = paletteFor({ breathRate, pulse });
  glass.freeze(false);
  glass.setPalette({ breathRate, pulse });
  render();
  try { await glass.cut(); } catch (e) { console.error('[glassbreath] cut failed', e); }
  session.phase = 'done';
  els.doneName.textContent = vesselName(session.palette);
  els.doneMeta.textContent = `${session.breaths} breaths, ${paceText(median(session.rates))}.`;
  els.done.hidden = false;
  els.keepBtn.disabled = false;
  els.keepBtn.focus({ preventScroll: true });
  render();
}

els.keepBtn.addEventListener('click', async () => {
  if (session.phase !== 'done' || session.kept) return;
  els.keepBtn.disabled = true;
  try {
    const snap = glass.snapshot();
    // Keep only what rebuilds the art: drop the pulse estimate from the stored palette.
    const { pulse: _pulse, ...palette } = snap.recipe.palette ?? {};
    const rate = median(session.rates);
    const recipe = {
      ...snap.recipe,
      palette,
      meta: {
        name: vesselName(session.palette),
        breaths: session.breaths,
        breathRate: rate == null ? null : Math.round(rate),
        source,
      },
    };
    await bridge.saveVessel({ pngDataUrl: snap.pngDataUrl, recipe });
    session.kept = true;
    show('rack');
  } catch (e) {
    console.error('[glassbreath] save failed', e);
    els.keepBtn.disabled = false;
    showError('Could not save the vessel. Is the disk full?', false);
  }
});
els.againBtn.addEventListener('click', () => startNewVessel());
els.shareBtn.addEventListener('click', () => {
  if (session.phase !== 'done') return;
  const snap = glass.snapshot();
  const rate = median(session.rates);
  share.open({
    pngDataUrl: snap.pngDataUrl, name: vesselName(session.palette), breaths: session.breaths,
    breathRate: rate == null ? null : Math.round(rate), createdAt: Date.now(), fromSample: source === 'replay',
  });
});

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || els.body.dataset.screen !== 'stage') return;
  if (e.target instanceof HTMLButtonElement) return;
  e.preventDefault();
  cutGlass();
});

// Warm-up clock: only counts time the SDK says the picture is good.
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min(250, now - session.lastTick);
  session.lastTick = now;
  if (session.phase !== 'warming') return;
  if (canShape()) session.validMs += dt;
  const heat = Math.min(1, session.validMs / WARMUP_MS);
  glass.setHeat(heat);
  els.heatFill.style.width = `${Math.round(heat * 100)}%`;
  els.heatText.textContent = `${Math.min(30, Math.floor(session.validMs / 1000))} of 30 s`;
  // Fallback if the SDK's stable flag is slow: two extra seconds after the window fills.
  if (session.validMs >= WARMUP_MS + 2000) startBlowing();
}
requestAnimationFrame(tick);

// ---------- rendering ----------
function render() {
  const p = session.phase;
  if (p === 'warming') {
    els.countMain.textContent = 'Warming up';
    els.countSub.textContent = 'sit still, breathe slowly';
  } else if (p === 'blowing') {
    els.countMain.textContent = `Breath ${session.breaths}`;
    els.countSub.textContent = session.breaths < TARGET_BREATHS ? `of ${TARGET_BREATHS}` : 'smile when you like it';
  } else if (p === 'cooling') {
    els.countMain.textContent = 'Cooling';
    els.countSub.textContent = `${session.breaths} breaths`;
  } else if (p === 'done') {
    els.countMain.textContent = `${session.breaths} breaths`;
    els.countSub.textContent = 'blown into one vessel';
  }
  els.heat.hidden = p !== 'warming';
  els.read.hidden = p === 'cooling' || p === 'done';

  els.cutHint.hidden = !(p === 'blowing' && session.breaths >= MIN_BREATHS_TO_CUT);

  let hint;
  if (p === 'cooling' || p === 'done') hint = '';
  else if (session.talking) hint = 'Talking pauses the glass. Breathe quietly.';
  else if (!session.validOk) hint = session.hint || 'Finding you…';
  else if (p === 'warming') hint = 'Good. Sit still and breathe slowly.';
  else if (session.breaths === 0 && session.breathPhase === 'hold') hint = 'Breathe in slowly to swell the glass.';
  else if (session.breathPhase === 'inhale') hint = 'In… the glass swells.';
  else if (session.breathPhase === 'exhale') hint = 'Out, slowly… the band sets.';
  else hint = 'Next breath when you are ready.';
  els.hint.textContent = hint;
  els.hint.classList.toggle('ok', canShape());

  setReadout(els.readRate, session.rate);
  setReadout(els.readPulse, session.pulse);
}

function setReadout(el, v) {
  const ok = Number.isFinite(v);
  el.textContent = ok ? `about ${Math.round(v)} / min` : 'warming up';
  el.classList.toggle('wait', !ok);
}

function flashCount() {
  if (reducedMotion) return;
  els.countMain.classList.remove('tick');
  void els.countMain.offsetWidth; // restart the animation
  els.countMain.classList.add('tick');
}

// ---------- errors ----------
function friendlyError(e) {
  const msg = String(e?.message || '');
  if (e?.code === 'NO_API_KEY') return 'No Presage API key found. Add it to app/.env and restart.';
  if (/auth/i.test(msg)) return 'Presage could not check the API key. Check the key and your internet connection.';
  if (/camera|getUserMedia|NotAllowed|NotFound|NotReadable/i.test(msg)) return 'The camera could not start. Close other apps using it, then try again.';
  if (e?.code === 'REPLAY_LOAD_FAILED') return 'The sample recording could not be loaded.';
  return msg || 'Something went wrong with the measurement.';
}

function showError(text, retryable) {
  els.errorText.textContent = text;
  els.retryBtn.hidden = !retryable;
  els.errorBanner.hidden = false;
}
function hideError() { els.errorBanner.hidden = true; }
els.retryBtn.addEventListener('click', async () => {
  hideError();
  if (!signals) return;
  try { await signals.stop(); } catch { /* ignore */ }
  await signals.start();
});

window.addEventListener('beforeunload', () => {
  try { signals?.destroy(); } catch { /* already gone */ }
  glass.dispose();
  trace.dispose();
});

// ---------- boot ----------
(async () => {
  try { config = { ...config, ...(await bridge.getConfig()) }; } catch (e) { console.error('[glassbreath] config failed', e); }
  els.teleToggle.checked = !!config.enableTelemetry;
  updateTeleText();
  show('consent');
})();
