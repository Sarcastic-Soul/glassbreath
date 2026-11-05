// Glassbreath UI shell: consent -> furnace warm-up -> blowing -> cut + cool -> rack.
// Signals come from the SmartSpectra SDK (or a labelled sample recording);
// the glass module turns them into the vessel.

import { createSignals } from './signals/index.js';
import { createGlassStage, paletteFor, SAMPLES, sampleRecipe } from './glass/index.js';
import { createTrace } from './ui/trace.js';
import { createRack } from './ui/rack.js';
import { vesselName, paceText } from './ui/names.js';
import { createShareDialog } from './ui/share.js';
import { createSound } from './audio/sound.js';
import { evaluate, ACHIEVEMENTS, finishName } from './game/achievements.js';

const TARGET_BREATHS = 10;
const MIN_BREATHS_TO_CUT = 3;
const WARMUP_MS = 30_000;
const SMILE_THRESHOLD = 0.4; // a normal smile scores about 0.4 to 0.6
const SMILE_GRACE_MS = 300; // short dips below the threshold do not reset the hold
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
  cutHint: $('cut-hint'), orb: $('orb'), soundBtn: $('btn-sound'), cam: document.querySelector('#stage .cam'), count: document.querySelector('#stage .count'),
  openRackBtn: $('btn-open-rack'), homeBtn: $('btn-home'), rackBlowBtn: $('btn-rack-blow'), rackCount: $('rack-count'),
  glassLayer: $('glass-layer'), showcaseCap: $('showcase-cap'), toast: $('toast'), leaveDialog: $('leave-dialog'), leaveTitle: $('leave-title'), leaveText: $('leave-text'),
  keyForm: $('key-form'), keyInput: $('key-input'), doneFinish: $('done-finish'), doneAwards: $('done-awards'), smileFill: $('smile-fill'), read: document.querySelector('#stage .read'), readRate: $('read-rate'), readPulse: $('read-pulse'),
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
  smileSince: 0, smileLast: 0, smilePeak: 0,
  hint: '',
  breathPhase: 'hold',
  palette: null,
  kept: false,
};

// ---------- screens ----------
// Each screen shows only the header buttons that make sense there: no rack
// while blowing, so a vessel in progress is never left behind by accident.
function show(screen) {
  for (const s of ['consent', 'stage', 'rack']) els[s].hidden = s !== screen;
  els.body.dataset.screen = screen;
  for (const b of els.nav.querySelectorAll('[data-on]')) b.hidden = !b.dataset.on.split(' ').includes(screen);
  if (screen === 'rack') rack.refresh();
  if (screen === 'consent') showcase.start(); else showcase.stop();
}

els.openRackBtn.addEventListener('click', () => show('rack'));
els.homeBtn.addEventListener('click', () => show('consent'));
els.rackBlowBtn.addEventListener('click', () => { show('consent'); els.cameraBtn.focus({ preventScroll: true }); });

// ---------- home showcase ----------
// The home screen turns finished vessels on the same glass canvas: your own
// recent ones first, topped up with vessels blown from sample breathing.
const SHOWCASE_MS = 8000;
const showcase = (() => {
  let on = false, timer = 0, run = 0, i = 0, list = [];
  async function load() {
    let mine = [];
    try { mine = (await bridge.listVessels()) ?? []; } catch (e) { console.error('[glassbreath] showcase list failed', e); }
    els.rackCount.hidden = !mine.length;
    els.rackCount.textContent = String(mine.length);
    const own = mine.filter((v) => v.recipe).slice(0, 6).map((v, n) => ({
      recipe: v.recipe, cap: `your No. ${mine.length - n}, ${String(v.recipe.meta?.name || 'glass').toLowerCase()}`,
    }));
    const samples = SAMPLES.map((s) => ({ recipe: sampleRecipe(s), cap: `blown from sample breathing: ${s.name.toLowerCase()}` }));
    list = own.length >= 3 ? own : [...own, ...samples];
  }
  function next(r) {
    if (!on || r !== run || !list.length) return;
    const item = list[i++ % list.length];
    els.glassLayer.classList.add('fade');
    setTimeout(() => {
      if (!on || r !== run) return;
      try { glass.loadRecipe(item.recipe); } catch (e) { console.error('[glassbreath] showcase load failed', e); }
      els.showcaseCap.textContent = item.cap;
      els.glassLayer.classList.remove('fade');
    }, reducedMotion ? 0 : 420);
    timer = setTimeout(() => next(r), SHOWCASE_MS);
  }
  async function start() {
    if (on) return;
    on = true;
    const r = ++run;
    await load();
    i = 0;
    next(r);
  }
  function stop() {
    on = false;
    run++;
    clearTimeout(timer);
    els.glassLayer.classList.remove('fade');
  }
  return { start, stop };
})();

// ---------- leaving a session ----------
// Ask first when leaving would throw away glass that is not on the rack yet.
function askLeave(again = false) {
  const p = session.phase;
  const unsaved = p === 'done' && !session.kept;
  const losing = (p === 'blowing' && session.breaths > 0) || p === 'cooling' || unsaved;
  if (!losing) return Promise.resolve(true);
  els.leaveTitle.textContent = unsaved ? (again ? 'Start over without keeping?' : 'Leave without keeping?') : 'Stop this vessel?';
  els.leaveText.textContent = unsaved ? 'This vessel is not on your rack yet.' : 'The glass you have blown so far will be lost.';
  const [stay, go] = els.leaveDialog.querySelectorAll('button');
  stay.textContent = unsaved ? 'Go back' : 'Keep blowing';
  go.textContent = unsaved ? (again ? 'Start over' : 'Leave') : 'Stop';
  els.leaveDialog.returnValue = '';
  els.leaveDialog.showModal();
  return new Promise((resolve) => {
    els.leaveDialog.addEventListener('close', () => resolve(els.leaveDialog.returnValue === 'ok'), { once: true });
  });
}

let toastTimer = 0;
function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

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
els.stopBtn.addEventListener('click', async () => { if (await askLeave()) end(); });

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
    els.keyForm.hidden = false;
    els.keyInput.focus();
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
  els.cam.classList.toggle('nocam', kind !== 'camera');
  resetSession();
  session.phase = 'warming';
  sound.furnace(true);
  glass.embers(true);
  show('stage');
  render();
  await signals.start();
}

async function end(next = 'consent') {
  const s = signals;
  signals = null;
  if (s) {
    try { await s.stop(); } catch { /* reported via error event */ }
    s.destroy();
  }
  els.preview.srcObject = null;
  els.sourceBadge.hidden = true;
  sound.stopAll();
  session.phase = 'off';
  glass.reset();
  trace.clear();
  hideError();
  show(next);
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
    const live = session.phase === 'warming' || session.phase === 'blowing';
    sound.breathe(live && canShape() ? Math.max(0, Math.min(1, b.chest ?? 0)) : 0);
    const ph = b.phase === 'inhale' || b.phase === 'exhale' ? b.phase : 'hold';
    if (ph !== session.breathPhase) { session.breathPhase = ph; if (session.phase === 'blowing') render(); }
  });
  s.on('breathComplete', (c) => {
    if (session.phase !== 'blowing' || !canShape()) return;
    glass.commitBreath(c);
    const depth = Number.isFinite(c?.depth) ? c.depth : 0.5;
    sound.bandSet(depth);
    glass.sparks(0.35 + 0.65 * depth);
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
    console.error('[glassbreath] signal error', JSON.stringify(e));
    showError(friendlyError(e), e.retryable || e?.code === 1);
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
  if (eligible && Number.isFinite(score) && score > session.smilePeak) {
    session.smilePeak = score;
    console.log('[glassbreath] smile peak', score.toFixed(2));
  }
  if (!eligible || !(score >= SMILE_THRESHOLD)) {
    // Keep the hold through a short dip; reset after the grace period.
    if (eligible && session.smileSince && now - session.smileLast < SMILE_GRACE_MS) return;
    session.smileSince = 0;
    els.smileFill.style.width = eligible ? `${Math.round(Math.max(0, Math.min(1, score / SMILE_THRESHOLD)) * 60)}%` : '0%';
    return;
  }
  session.smileLast = now;
  if (!session.smileSince) session.smileSince = now;
  const held = (now - session.smileSince) / SMILE_HOLD_MS;
  els.smileFill.style.width = `${Math.round(60 + Math.min(1, held) * 40)}%`;
  if (held >= 1) cutGlass();
}

// ---------- API key (packaged builds have no .env) ----------
els.keyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = els.keyInput.value.trim();
  els.consentError.hidden = true;
  try {
    await bridge.setApiKey(key);
    config.apiKey = key;
    els.keyInput.value = '';
    els.keyForm.hidden = true;
    begin('camera');
  } catch (err) {
    els.consentError.textContent = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    els.consentError.hidden = false;
  }
});

// ---------- rare finishes ----------
// About 1 vessel in 8 cools with a rare finish.
const FINISH_ODDS = [['gold', 0.05], ['crackle', 0.05], ['opal', 0.025]];
function rollFinish(rand = Math.random()) {
  if (config.forceFinish) return config.forceFinish;
  let acc = 0;
  for (const [name, p] of FINISH_ODDS) { acc += p; if (rand < acc) return name; }
  return null;
}

// ---------- sound ----------
// Synthesized in code. Browsers only allow audio after a click or key press.
const sound = createSound();
const SOUND_KEY = 'glassbreath.sound';
function readSoundPref() { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } }
function setSoundOn(on) {
  sound.setEnabled(on);
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* storage blocked */ }
  els.soundBtn.setAttribute('aria-pressed', String(on));
  els.soundBtn.setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
  els.soundBtn.title = on ? 'Sound on' : 'Sound off';
  els.soundBtn.innerHTML = `<i class="ph ${on ? 'ph-speaker-high' : 'ph-speaker-slash'}" aria-hidden="true"></i>`;
}
setSoundOn(readSoundPref());
els.soundBtn.addEventListener('click', () => { sound.unlock(); setSoundOn(!sound.isEnabled()); });
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { sound.unlock(); }, { passive: true });

// ---------- session flow ----------
function resetSession() {
  Object.assign(session, {
    phase: 'off', validOk: false, talking: false, validMs: 0, lastTick: performance.now(),
    breaths: 0, rates: [], pulses: [], rate: null, pulse: null, smileSince: 0, smileLast: 0, smilePeak: 0, pausedMs: 0, finish: null, hint: '', palette: null, kept: false,
  });
  glass.reset();
  glass.setHeat(0);
  trace.clear();
  els.done.hidden = true;
}

function startBlowing() {
  session.phase = 'blowing';
  glass.embers(false);
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
  session.pausedMs = 0;
  session.finish = null;
  session.phase = 'blowing';
  els.done.hidden = true;
  sound.coolStop();
  sound.furnace(true);
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
  session.finish = rollFinish();
  glass.setFinish(session.finish);
  render();
  sound.cut();
  sound.furnace(false);
  sound.coolStart();
  try { await glass.cut(); } catch (e) { console.error('[glassbreath] cut failed', e); }
  sound.coolStop();
  session.phase = 'done';
  els.doneName.textContent = vesselName(session.palette);
  els.doneMeta.textContent = `${session.breaths} breaths, ${paceText(median(session.rates))}.`;
  els.doneFinish.hidden = !session.finish;
  if (session.finish) { els.doneFinish.querySelector('span').textContent = `Rare finish: ${finishName(session.finish)}`; sound.rare(); }
  els.doneAwards.hidden = true;
  els.doneAwards.replaceChildren();
  els.done.hidden = false;
  awardAchievements();
  els.keepBtn.disabled = false;
  setKeepButton(false);
  els.keepBtn.focus({ preventScroll: true });
  render();
}

// Check achievements for the vessel that just cooled. Sample runs never count.
async function awardAchievements() {
  try {
    const run = {
      breaths: session.breaths, breathRate: median(session.rates), pausedMs: session.pausedMs,
      recipe: glass.snapshot().recipe, finish: session.finish, fromSample: source !== 'camera',
    };
    const { unlocked, state } = evaluate(run, await bridge.getProgress());
    if (run.fromSample) return;
    await bridge.saveProgress(state);
    rack.setProgress?.(state);
    if (!unlocked.length) return;
    const byId = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
    els.doneAwards.replaceChildren(...unlocked.map((id) => {
      const a = byId.get(id);
      const li = document.createElement('li');
      li.innerHTML = `<i class="ph ${a?.icon || 'ph-medal'}" aria-hidden="true"></i><span></span>`;
      li.querySelector('span').textContent = a?.title || id;
      li.title = a?.description || '';
      return li;
    }));
    els.doneAwards.hidden = false;
    setTimeout(() => sound.achievement(), session.finish ? 900 : 300);
  } catch (e) { console.error('[glassbreath] achievements failed', e); }
}

function setKeepButton(kept) {
  els.keepBtn.querySelector('i').className = `ph ${kept ? 'ph-arrow-right' : 'ph-archive-box'}`;
  els.keepBtn.querySelector('span').textContent = kept ? 'See it on the rack' : 'Keep on the rack';
}

els.keepBtn.addEventListener('click', async () => {
  if (session.phase !== 'done') return;
  // Already kept: the same button walks to the rack and turns the camera off.
  if (session.kept) { end('rack'); return; }
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
        finish: session.finish ?? null,
      },
    };
    await bridge.saveVessel({ pngDataUrl: snap.pngDataUrl, recipe });
    session.kept = true;
    setKeepButton(true);
    els.keepBtn.disabled = false;
    toast('Kept on your rack');
    render();
  } catch (e) {
    console.error('[glassbreath] save failed', e);
    els.keepBtn.disabled = false;
    showError('Could not save the vessel. Is the disk full?', false);
  }
});
els.againBtn.addEventListener('click', async () => { if (await askLeave(true)) startNewVessel(); });
els.shareBtn.addEventListener('click', () => {
  if (session.phase !== 'done') return;
  const snap = glass.snapshot();
  const rate = median(session.rates);
  share.open({
    pngDataUrl: snap.pngDataUrl, name: vesselName(session.palette), breaths: session.breaths,
    breathRate: rate == null ? null : Math.round(rate), createdAt: Date.now(), fromSample: source === 'replay', finish: session.finish,
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
  // Time the glass was paused while blowing (bad picture or talking), for "Steady hand".
  if (session.phase === 'blowing' && !canShape()) session.pausedMs += dt;
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
    els.countSub.textContent = 'sit still';
  } else if (p === 'blowing') {
    els.countMain.textContent = `Breath ${session.breaths}`;
    els.countSub.textContent = session.breaths < TARGET_BREATHS ? `of ${TARGET_BREATHS}` : 'smile when you like it';
  } else if (p === 'cooling') {
    els.countMain.textContent = 'Cooling';
    els.countSub.textContent = `${session.breaths} breaths`;
  } else if (p === 'done') {
    els.countMain.textContent = `${session.breaths} breaths`;
    els.countSub.textContent = 'one vessel';
  }
  els.heat.hidden = p !== 'warming';
  if (els.body.dataset.phase !== p) els.body.dataset.phase = p;
  els.count.hidden = p === 'done';
  els.cam.hidden = p === 'cooling' || p === 'done';
  const finished = p === 'done' && session.kept;
  const stopLabel = finished ? 'Finish' : p === 'done' ? 'Leave' : 'Stop';
  if (els.stopBtn.dataset.label !== stopLabel) {
    els.stopBtn.dataset.label = stopLabel;
    els.stopBtn.querySelector('i').className = `ph ${finished ? 'ph-check' : 'ph-x'}`;
    els.stopBtn.querySelector('span').textContent = stopLabel;
  }
  els.read.hidden = p === 'cooling' || p === 'done';

  els.cutHint.hidden = !(p === 'blowing' && session.breaths >= MIN_BREATHS_TO_CUT);

  let hint;
  if (p === 'cooling' || p === 'done') hint = '';
  else if (session.talking) hint = 'Talking pauses it';
  else if (!session.validOk) hint = session.hint || 'Finding you…';
  else if (p === 'warming') hint = 'Good. Breathe slowly';
  else if (session.breaths === 0 && session.breathPhase === 'hold') hint = 'Breathe in slowly';
  else if (session.breathPhase === 'inhale') hint = 'In…';
  else if (session.breathPhase === 'exhale') hint = 'Out…';
  else hint = 'Next breath';
  els.hint.textContent = hint;
  // The orb next to the camera grows on the in-breath and shrinks on the out-breath.
  const orbPhase = (p === 'warming' || p === 'blowing') && session.validOk && !session.talking ? (session.breathPhase || 'hold') : 'off';
  if (els.orb.dataset.phase !== orbPhase) els.orb.dataset.phase = orbPhase;
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
  if (e?.code === 'CAMERA_FAILED') return /NotAllowed/.test(msg)
    ? 'Camera permission was refused. Allow the camera, then try again.'
    : 'The camera could not start. Close other apps using it, then try again.';
  if (e?.code === 1 || /valid state/i.test(msg)) return 'The measurement stopped. Press Try again to restart it.';
  return msg || 'Something went wrong with the measurement.';
}

function showError(text, retryable) {
  els.errorText.textContent = text;
  els.retryBtn.hidden = !retryable;
  els.errorBanner.hidden = false;
}
function hideError() { els.errorBanner.hidden = true; }
// Retry rebuilds the whole SDK session: restarting a session that has
// failed leaves the native SDK in an invalid state.
els.retryBtn.addEventListener('click', async () => {
  hideError();
  if (!signals || !source) return;
  const kind = source;
  const old = signals;
  signals = null;
  try { await old.stop(); } catch { /* reported already */ }
  old.destroy();
  els.preview.srcObject = null;
  await begin(kind);
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
  await fontsLoaded();
  document.body.classList.remove('booting');
})();

// Wait for the page fonts and the icon font, but never more than 2.5 s.
function fontsLoaded() {
  const want = ['800 40px "Big Shoulders Display"', '500 20px "Big Shoulders Text"', '400 20px "Kalam"', '20px "Phosphor"'];
  const loads = Promise.all(want.map((f) => document.fonts.load(f).catch(() => null))).then(() => document.fonts.ready);
  return Promise.race([loads, new Promise((r) => setTimeout(r, 2500))]);
}
