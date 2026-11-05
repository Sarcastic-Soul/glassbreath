// Share card: a 1080x1350 picture of one vessel with its name and breath count,
// plus a dialog to copy it, save it, or start a post. Nothing leaves the computer
// until the user presses one of those buttons.
import { paceText } from './names.js';

const W = 1080;
const H = 1350;
const COLORS = { ground: '#16120f', ink: '#efe5d6', soft: '#b9ab98', chalk: '#e9e2d4', molten: '#ff7b1c', line: '#3a3029' };
const DATE_FMT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function fontsReady() {
  try {
    await Promise.all([
      document.fonts.load('800 120px "Big Shoulders Display"'),
      document.fonts.load('500 40px "Big Shoulders Text"'),
      document.fonts.load('400 40px "Kalam"'),
    ]);
  } catch { /* fall back to whatever is loaded */ }
}

/**
 * @param {{pngDataUrl:string, name:string, number?:number, breaths:number, breathRate?:number|null,
 *          createdAt?:number, showPace?:boolean, fromSample?:boolean}} v
 * @returns {Promise<string>} PNG data URL
 */
export async function makeShareCard(v) {
  await fontsReady();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');

  g.fillStyle = COLORS.ground;
  g.fillRect(0, 0, W, H);

  // Warm furnace light behind the vessel.
  const glow = g.createRadialGradient(W / 2, 560, 40, W / 2, 560, 520);
  glow.addColorStop(0, 'rgba(255, 140, 50, 0.20)');
  glow.addColorStop(0.55, 'rgba(255, 110, 30, 0.06)');
  glow.addColorStop(1, 'rgba(255, 110, 30, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  // Header.
  g.fillStyle = COLORS.ink;
  g.font = '800 44px "Big Shoulders Display"';
  g.textBaseline = 'alphabetic';
  g.fillText('GLASSBREATH', 72, 112);
  g.fillStyle = COLORS.soft;
  g.font = '500 30px "Big Shoulders Text"';
  g.textAlign = 'right';
  g.fillText(v.createdAt ? DATE_FMT.format(new Date(v.createdAt)) : '', W - 72, 110);
  g.textAlign = 'left';

  // Vessel, fitted into a box and resting on a shelf line.
  const img = await loadImage(v.pngDataUrl);
  const boxW = 640;
  const boxH = 700;
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const iw = img.width * scale;
  const ih = img.height * scale;
  const shelfY = 900;
  g.drawImage(img, (W - iw) / 2, shelfY - ih, iw, ih);
  g.fillStyle = COLORS.line;
  g.fillRect(72, shelfY + 6, W - 144, 3);

  // Name and details.
  g.fillStyle = COLORS.chalk;
  g.font = '400 40px "Kalam"';
  g.fillText(v.number ? `No. ${v.number}` : 'Cooled', 72, 990);
  g.fillStyle = COLORS.ink;
  g.font = '800 128px "Big Shoulders Display"';
  g.fillText(String(v.name || 'Glass').toUpperCase(), 66, 1108);

  const parts = [`${v.breaths} breath${v.breaths === 1 ? '' : 's'}`];
  if (v.showPace && Number.isFinite(v.breathRate)) parts.push(paceText(v.breathRate));
  g.fillStyle = COLORS.soft;
  g.font = '500 40px "Big Shoulders Text"';
  g.fillText(parts.join(', '), 72, 1172);

  // Footer.
  g.fillStyle = COLORS.molten;
  g.fillRect(72, 1232, 64, 6);
  g.fillStyle = COLORS.soft;
  g.font = '500 30px "Big Shoulders Text"';
  g.fillText(
    v.fromSample ? 'Blown from a sample breathing recording in Glassbreath.' : 'Blown with my breathing, read by a webcam.',
    72, 1284,
  );
  g.fillText('Made with Presage SmartSpectra.', 72, 1322);

  return canvas.toDataURL('image/png');
}

export function shareText(v) {
  const how = v.fromSample ? 'from a sample breathing recording' : 'with my breathing, read by a webcam';
  return `I blew a ${v.name} glass vessel in ${v.breaths} slow breaths, ${how}. Made with Glassbreath and the Presage SmartSpectra SDK.`;
}

/** Wires the share dialog. Returns open(vessel). */
export function createShareDialog({ dialog, preview, paceToggle, status, copyBtn, saveBtn, xBtn, bskyBtn, store }) {
  let current = null;
  let cardUrl = '';
  let busy = false;

  const say = (text) => { status.textContent = text; };

  async function render() {
    if (!current) return;
    cardUrl = await makeShareCard({ ...current, showPace: paceToggle.checked });
    preview.src = cardUrl;
  }

  async function act(fn) {
    if (busy || !cardUrl) return;
    busy = true;
    try { await fn(); } catch (e) { console.error('[share] failed', e); say('That did not work. Try again.'); }
    busy = false;
  }

  const fileName = () => `glassbreath-${current.number ?? 'vessel'}-${String(current.name || 'glass').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;

  copyBtn.addEventListener('click', () => act(async () => {
    await store.copyImage(cardUrl);
    say('Picture copied. Paste it anywhere.');
  }));
  saveBtn.addEventListener('click', () => act(async () => {
    const saved = await store.saveImage(cardUrl, fileName());
    say(saved ? `Saved as ${saved}.` : 'Not saved.');
  }));
  const post = (target, label) => act(async () => {
    await store.copyImage(cardUrl);
    await store.openShare(target, shareText(current));
    say(`Picture copied. ${label} opened in your browser: paste the picture into the post.`);
  });
  xBtn.addEventListener('click', () => post('x', 'X'));
  bskyBtn.addEventListener('click', () => post('bluesky', 'Bluesky'));
  paceToggle.addEventListener('change', () => { render(); });

  async function open(vessel) {
    current = vessel;
    cardUrl = '';
    preview.removeAttribute('src');
    paceToggle.checked = false;
    say('Nothing is shared until you press a button below.');
    dialog.showModal();
    await render();
  }

  return { open };
}
