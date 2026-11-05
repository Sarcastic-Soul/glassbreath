// Glass playground: drive the glass stage with synthetic breathing.
import { createGlassStage, SAMPLES, sampleRecipe } from '../src/renderer/glass/index.js';

const $ = (id) => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || location.hash.includes('reduced');
const glass = createGlassStage($('glass'), { reducedMotion: reduced });
window.__glass = glass;
if (location.hash.includes('clean')) { $('panel').classList.add('hidden'); $('autoBeat').checked = false; }

const bind = (id, fn) => {
  const el = $(id), out = $(id + 'Out');
  const run = () => { if (out) out.textContent = el.value; fn(Number(el.value)); };
  el.addEventListener('input', run);
  run();
};

bind('heat', (v) => { glass.setHeat(v); $('heatOut').textContent = v.toFixed(2); });
const palette = () => glass.setPalette({ breathRate: Number($('pRate').value), pulse: Number($('pPulse').value) });
bind('pRate', palette);
bind('pPulse', palette);
$('freeze').addEventListener('change', (e) => glass.freeze(e.target.checked));
$('beat').addEventListener('click', () => glass.heartbeat(1));
$('cut').addEventListener('click', async () => { await glass.cut(); $('stats').dataset.cut = 'done'; });
// reset clears the finish and embers, so re-apply what the controls say
const applyFx = () => { glass.setFinish($('finish').value || null); glass.setPattern($('pattern').value || null); glass.embers($('embers').checked); };
$('reset').addEventListener('click', () => { blowId++; glass.reset(); applyFx(); sim.cycleStart = performance.now(); });
$('embers').addEventListener('change', (e) => glass.embers(e.target.checked));
$('finish').addEventListener('change', (e) => glass.setFinish(e.target.value || null));
$('pattern').addEventListener('change', (e) => glass.setPattern(e.target.value || null));
bind('sparkK', () => {});
const sparks = () => glass.sparks(Number($('sparkK').value));
$('sparks').addEventListener('click', sparks);

let lastRecipe = null;
try { lastRecipe = JSON.parse(localStorage.getItem('glassbreath:lastRecipe') || 'null'); } catch { lastRecipe = null; }
$('snap').addEventListener('click', () => {
  const { pngDataUrl, recipe } = glass.snapshot();
  lastRecipe = recipe;
  try { localStorage.setItem('glassbreath:lastRecipe', JSON.stringify(recipe)); } catch { /* private mode */ }
  $('shot').src = pngDataUrl;
  $('shot').hidden = false;
  console.log('recipe', recipe);
});
$('load').addEventListener('click', () => { if (lastRecipe) glass.loadRecipe(lastRecipe); });

// --- synthetic breathing -------------------------------------------------------
const sim = { on: false, cycleStart: performance.now(), period: 6667, depth: 0.7, inhale: 0.42 };
function newCycle(now) {
  const bpm = Number($('bpm').value);
  sim.cycleStart = now;
  sim.period = (60000 / bpm) * (0.8 + Math.random() * 0.4);
  sim.depth = 0.25 + Math.random() * 0.75;
  sim.inhale = 0.35 + Math.random() * 0.15;
}
bind('bpm', () => {});
$('sim').addEventListener('change', (e) => { sim.on = e.target.checked; newCycle(performance.now()); });

function chestAt(u) {
  // u in 0..1 of the cycle: rise over the inhale, fall over the exhale
  const i = sim.inhale;
  const x = u < i ? 0.5 - 0.5 * Math.cos(Math.PI * (u / i)) : 0.5 + 0.5 * Math.cos(Math.PI * ((u - i) / (1 - i)));
  return -1 + 2 * x * sim.depth;
}

setInterval(() => {
  if (!sim.on) return;
  const now = performance.now();
  let u = (now - sim.cycleStart) / sim.period;
  if (u >= 1) {
    const inhaleMs = Math.round(sim.period * sim.inhale);
    glass.commitBreath({ depth: sim.depth, durationMs: Math.round(sim.period), inhaleMs, exhaleMs: Math.round(sim.period) - inhaleMs });
    if ($('autoSparks').checked) sparks();
    newCycle(now);
    u = 0;
  }
  const chest = chestAt(u) + (Math.random() - 0.5) * 0.04;
  glass.breath({ chest, phase: u < sim.inhale ? 'inhale' : 'exhale', depth: sim.depth });
}, 33);

$('commit').addEventListener('click', () => {
  glass.commitBreath({ depth: 0.3 + Math.random() * 0.7, durationMs: 4000 + Math.random() * 4000, exhaleMs: 2500 + Math.random() * 3000 });
  if ($('autoSparks').checked) sparks();
});

setInterval(() => { if ($('autoBeat').checked) glass.heartbeat(0.7); }, 60000 / 68);
setInterval(() => {
  const s = glass.getStats();
  $('stats').textContent = `${s.fps} fps · ${s.calls} calls · ${s.triangles} tris · ${s.mode} · ${s.breaths} breaths · ${s.particles} fx`;
}, 500);

// --- sample sessions -------------------------------------------------------------
for (const smp of SAMPLES) $('sample').append(new Option(`${smp.name} (${smp.breaths.length})`, smp.id));
const pick = () => SAMPLES.find((x) => x.id === $('sample').value) || SAMPLES[0];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Blow a sample breath by breath (sped up 4x), then cut it. Palette slider overrides. */
let blowId = 0;
async function blowSample(smp = pick(), { speed = 4 } = {}) {
  const id = ++blowId; // a newer blow cancels this one
  $('sim').checked = false; sim.on = false;
  glass.reset(); applyFx();
  for (const b of smp.breaths) {
    const dur = b.durationMs / speed, inh = b.inhaleMs / speed, t0 = performance.now();
    for (let el = 0; el < dur; el = performance.now() - t0) {
      const u = el < inh ? 0.5 - 0.5 * Math.cos(Math.PI * el / inh) : 0.5 + 0.5 * Math.cos(Math.PI * (el - inh) / (dur - inh));
      glass.breath({ chest: -1 + 2 * u * b.depth, depth: b.depth });
      await wait(33);
      if (id !== blowId) return;
    }
    glass.commitBreath(b);
    if ($('autoSparks').checked) sparks();
  }
  glass.setPalette({ breathRate: smp.breathRate, pulse: Number($('pPulse').value) });
  await glass.cut();
}
$('blow').addEventListener('click', () => blowSample());

/**
 * Render every sample as a finished vessel. Returns { id: pngDataUrl, sheet: pngDataUrl }.
 * opts: { pattern, finish, width, height, pulse }
 */
async function gallery({ pattern = $('pattern').value || null, finish = $('finish').value || null, width = 360, height = 480, pulse = 70 } = {}) {
  blowId++;
  const out = {}, imgs = [];
  for (const smp of SAMPLES) {
    glass.loadRecipe(sampleRecipe(smp, { pattern, finish, pulse }));
    const { pngDataUrl, recipe } = glass.snapshot({ width, height });
    out[smp.id] = pngDataUrl;
    const img = new Image();
    img.src = pngDataUrl;
    await img.decode();
    imgs.push({ img, label: `${smp.name}  ·  ${recipe.pattern.type}` });
  }
  const cols = 4, rows = Math.ceil(imgs.length / cols), lab = 30;
  const c = document.createElement('canvas');
  c.width = cols * width; c.height = rows * (height + lab);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#17120f'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.font = '15px system-ui, sans-serif'; ctx.fillStyle = '#cfc3b5'; ctx.textAlign = 'center';
  imgs.forEach(({ img, label }, i) => {
    const x = (i % cols) * width, y = Math.floor(i / cols) * (height + lab);
    ctx.drawImage(img, x, y);
    ctx.fillText(label, x + width / 2, y + height + 20);
  });
  out.sheet = c.toDataURL('image/png');
  $('shot').src = out.sheet; $('shot').hidden = false;
  return out;
}
$('gallery').addEventListener('click', () => gallery());
window.__samples = { SAMPLES, sampleRecipe, blowSample, gallery };
