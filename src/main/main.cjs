// Glassbreath Electron main process.
// - One sandboxed window; renderer talks to the SmartSpectra SDK through
//   bindSmartSpectraIpc and to us through a few validated IPC handlers.
// - Camera permission: video only, only for our own file:// pages.
// - Gallery: userData/vessels/<id>/{vessel.png, recipe.json}.
// - Achievements: userData/progress.json (kept when the gallery is deleted).

'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const { app, BrowserWindow, session, ipcMain, clipboard, nativeImage, dialog, shell, safeStorage } = require('electron');

const APP_ROOT = path.join(__dirname, '..', '..');

// Packaged builds ship the native runtime under resources/smartspectra/
// (a shared library can't be loaded from inside app.asar). Must be set
// before the SDK is required, because the require loads the library.
if (app.isPackaged && !process.env.SMARTSPECTRA_CAPI_PATH) {
  const lib = { darwin: 'libsmartspectra_capi.dylib', win32: 'smartspectra_capi.dll', linux: 'libsmartspectra_capi.so' }[process.platform];
  if (lib) process.env.SMARTSPECTRA_CAPI_PATH = path.join(process.resourcesPath, 'smartspectra', lib);
  else console.error(`[glassbreath] no packaged SmartSpectra runtime for platform ${process.platform}`);
}

const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

// API key: real env first, then app/.env (never committed).
if (!process.env.SMARTSPECTRA_API_KEY && typeof process.loadEnvFile === 'function') {
  const envPath = path.join(APP_ROOT, '.env');
  try { if (fsSync.existsSync(envPath)) process.loadEnvFile(envPath); }
  catch (e) { console.warn('[glassbreath] could not read .env:', e.message); }
}

const DEBUG = process.env.GLASSBREATH_DEBUG === '1';
const PAGE = process.env.GLASSBREATH_PAGE === 'playground'
  ? path.join(APP_ROOT, 'playground', 'glass.html')
  : path.join(APP_ROOT, 'src', 'renderer', 'index.html');
const FIXTURES_DIR = path.join(APP_ROOT, 'fixtures');

// ---------- validation helpers ----------
const ID_RE = /^\d{13}-[0-9a-f]{8}$/;
const FIXTURE_RE = /^[A-Za-z0-9_-]{1,64}\.jsonl$/;
const PNG_PREFIX = 'data:image/png;base64,';
const MAX_PNG_CHARS = 12 * 1024 * 1024; // ~9 MB of PNG
const MAX_RECIPE_BYTES = 1024 * 1024;
const MAX_FIXTURE_BYTES = 50 * 1024 * 1024;
const MAX_LIST = 500;
const MAX_PROGRESS_BYTES = 64 * 1024;

const vesselsDir = () => path.join(app.getPath('userData'), 'vessels');
const progressFile = () => path.join(app.getPath('userData'), 'progress.json');

function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Write to a temp file in the same folder, then rename over the target,
// so a crash mid-write never leaves a half-written file.
async function writeFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid vessel id');
  const dir = path.join(vesselsDir(), id);
  if (path.dirname(dir) !== vesselsDir()) throw new Error('Invalid vessel id');
  return dir;
}

function isOwnPage(event) {
  const url = event?.senderFrame?.url || '';
  return url.startsWith('file://');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isOwnPage(event)) throw new Error('Untrusted sender');
    return fn(...args);
  });
}

function decodePng(pngDataUrl) {
  if (typeof pngDataUrl !== 'string' || !pngDataUrl.startsWith(PNG_PREFIX) || pngDataUrl.length > MAX_PNG_CHARS) {
    throw new Error('Invalid PNG');
  }
  const b64 = pngDataUrl.slice(PNG_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('Invalid PNG');
  const png = Buffer.from(b64, 'base64');
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('Invalid PNG');
  return png;
}

// Share targets are fixed here; the renderer only picks one and supplies the text.
const SHARE_URLS = {
  x: (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
  bluesky: (text) => `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`,
};

// ---------- API key typed in the app ----------
// Packaged builds have no .env, so the user pastes their own Presage key once.
// It is encrypted with the OS keychain when Electron's safeStorage has one.
const keyFile = () => path.join(app.getPath('userData'), 'presage-key.bin');
const KEY_RE = /^[A-Za-z0-9._~+/=-]{8,256}$/;

async function readSavedKey() {
  let buf;
  try { buf = await fs.readFile(keyFile()); } catch { return ''; }
  try {
    if (buf[0] === 0x45) return safeStorage.decryptString(buf.subarray(1)); // 'E' + encrypted
    if (buf[0] === 0x50) return buf.subarray(1).toString('utf8'); // 'P' + plain (no keychain)
  } catch (e) { console.warn('[glassbreath] saved key unreadable:', e.message); }
  return '';
}

async function writeSavedKey(key) {
  const enc = safeStorage.isEncryptionAvailable();
  const body = enc ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8');
  const tmp = `${keyFile()}.tmp`;
  await fs.mkdir(path.dirname(keyFile()), { recursive: true });
  await fs.writeFile(tmp, Buffer.concat([Buffer.from(enc ? 'E' : 'P'), body]), { mode: 0o600 });
  await fs.rename(tmp, keyFile());
  return enc;
}

// ---------- IPC ----------
function registerIpc() {
  handle('glassbreath:getConfig', async () => ({
    apiKey: process.env.SMARTSPECTRA_API_KEY || (await readSavedKey()),
    keySaved: !process.env.SMARTSPECTRA_API_KEY && !!(await readSavedKey()),
    // Optional for demo recordings: GLASSBREATH_FINISH=gold|crackle|opal forces a rare finish.
    forceFinish: ['gold', 'crackle', 'opal'].includes(process.env.GLASSBREATH_FINISH) ? process.env.GLASSBREATH_FINISH : null,
    enableTelemetry: process.env.GLASSBREATH_TELEMETRY === '1',
    // Optional: GLASSBREATH_REPLAY=synthetic-session.jsonl starts in replay mode.
    replay: FIXTURE_RE.test(process.env.GLASSBREATH_REPLAY || '') ? process.env.GLASSBREATH_REPLAY : null,
    debug: DEBUG,
  }));

  handle('glassbreath:setApiKey', async (key) => {
    const k = String(key ?? '').trim();
    if (!KEY_RE.test(k)) throw new Error('That does not look like a Presage API key.');
    const encrypted = await writeSavedKey(k);
    return { ok: true, encrypted };
  });

  handle('glassbreath:clearApiKey', async () => {
    await fs.rm(keyFile(), { force: true });
    return true;
  });

  handle('glassbreath:readFixture', async (name) => {
    if (typeof name !== 'string' || !FIXTURE_RE.test(name)) throw new Error('Invalid fixture name');
    const file = path.join(FIXTURES_DIR, name);
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_FIXTURE_BYTES) throw new Error('Fixture too large or missing');
    return fs.readFile(file, 'utf8');
  });

  handle('glassbreath:saveVessel', async (payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid payload');
    const { pngDataUrl, recipe } = payload;
    const png = decodePng(pngDataUrl);
    if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw new Error('Invalid recipe');
    const recipeJson = JSON.stringify(recipe);
    if (Buffer.byteLength(recipeJson) > MAX_RECIPE_BYTES) throw new Error('Recipe too large');

    const createdAt = Date.now();
    const id = `${createdAt}-${crypto.randomBytes(4).toString('hex')}`;
    const dir = assertId(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'vessel.png'), png);
    await fs.writeFile(path.join(dir, 'recipe.json'), JSON.stringify({ id, createdAt, recipe }));
    return { id, createdAt };
  });

  handle('glassbreath:listVessels', async () => {
    let names;
    try { names = await fs.readdir(vesselsDir()); } catch { return []; }
    const ids = names.filter((n) => ID_RE.test(n)).sort().reverse().slice(0, MAX_LIST);
    const out = [];
    for (const id of ids) {
      const dir = assertId(id);
      try {
        const [png, meta] = await Promise.all([
          fs.readFile(path.join(dir, 'vessel.png')),
          fs.readFile(path.join(dir, 'recipe.json'), 'utf8'),
        ]);
        const parsed = JSON.parse(meta);
        out.push({ id, createdAt: Number(parsed.createdAt) || Number(id.split('-')[0]), recipe: parsed.recipe ?? null,
          pngDataUrl: PNG_PREFIX + png.toString('base64') });
      } catch { /* skip broken entries */ }
    }
    return out;
  });

  handle('glassbreath:deleteVessel', async (id) => {
    const dir = assertId(id);
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  });

  // Sharing: everything the user shares goes out only through these explicit actions.
  handle('glassbreath:copyImage', (pngDataUrl) => {
    const img = nativeImage.createFromBuffer(decodePng(pngDataUrl));
    if (img.isEmpty()) throw new Error('Invalid PNG');
    clipboard.writeImage(img);
    return true;
  });

  handle('glassbreath:saveImage', async (pngDataUrl, name) => {
    const png = decodePng(pngDataUrl);
    const safe = String(name || 'glassbreath.png').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80);
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save vessel picture',
      defaultPath: path.join(app.getPath('pictures'), safe.endsWith('.png') ? safe : `${safe}.png`),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, png);
    return path.basename(filePath);
  });

  handle('glassbreath:openShare', async (target, text) => {
    const build = SHARE_URLS[target];
    if (!build) throw new Error('Unknown share target');
    await shell.openExternal(build(String(text || '').slice(0, 280)));
    return true;
  });

  // Achievement progress: one small JSON object. Not touched by deleteAll.
  handle('glassbreath:getProgress', async () => {
    try {
      const st = await fs.stat(progressFile());
      if (!st.isFile() || st.size > MAX_PROGRESS_BYTES) return null;
      const parsed = JSON.parse(await fs.readFile(progressFile(), 'utf8'));
      return isPlainObject(parsed) ? parsed : null;
    } catch { return null; }
  });

  handle('glassbreath:saveProgress', async (state) => {
    if (!isPlainObject(state)) throw new Error('Invalid progress');
    const json = JSON.stringify(state);
    if (Buffer.byteLength(json) > MAX_PROGRESS_BYTES) throw new Error('Progress too large');
    await writeFileAtomic(progressFile(), json);
    return true;
  });

  handle('glassbreath:resetProgress', async () => {
    await fs.rm(progressFile(), { force: true });
    return true;
  });

  handle('glassbreath:deleteAll', async () => {
    let names;
    try { names = await fs.readdir(vesselsDir()); } catch { return 0; }
    let n = 0;
    for (const id of names.filter((x) => ID_RE.test(x))) {
      await fs.rm(assertId(id), { recursive: true, force: true });
      n++;
    }
    return n;
  });
}

// ---------- window ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: 'Glassbreath',
    autoHideMenuBar: true,
    backgroundColor: '#15110e',
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  bindSmartSpectraIpc(win);

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());

  win.loadFile(PAGE);
  if (DEBUG) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const types = (details && details.mediaTypes) || [];
    const cameraOnly = types.length === 1 && types[0] === 'video';
    callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    const url = (details && details.requestingUrl) || origin || '';
    if (permission !== 'media') return false;
    return details?.mediaType !== 'audio' && String(url).startsWith('file://');
  });

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

// The SDK's native teardown runs off-thread after a window closes or the
// renderer calls destroy(). Quitting in the middle of it can crash with
// "napi_throw", so hide the window and give it ~2.5 s before the process exits.
let quitDelayed = false;
app.on('before-quit', (e) => {
  if (quitDelayed) return;
  quitDelayed = true;
  e.preventDefault();
  for (const w of BrowserWindow.getAllWindows()) w.hide();
  setTimeout(() => app.quit(), 2500);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
