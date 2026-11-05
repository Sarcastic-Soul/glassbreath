// Achievements for finished vessels. Pure logic: no DOM, no IPC.
// Calm by design: nothing rewards breathing faster, and there are no streaks
// or daily goals. Sample-recording runs never earn anything.
//
// evaluate(run, state) -> { unlocked: [ids], state }
// progress(state)      -> one row per achievement for the UI
import { buildProfile, profileHeight, profileMaxR } from '../glass/vessel-profile.js';

export const STATE_VERSION = 1;
export const TARGET_BREATHS = 10;
/** Paused time below this is treated as camera flicker, not a real pause. */
export const PAUSE_GRACE_MS = 750;

// Shape thresholds, picked from simulated sessions with buildProfile
// (tallness = height / diameter). Median vessel is about 1.6; a 10-breath
// slow, shallow vessel is 2.8+; three deep breaths make about 0.6.
export const SHAPE = Object.freeze({ tallMin: 2.6, tallMaxWidth: 0.7, wideMax: 0.8, wideMinWidth: 0.85 });

// Same order and pace stops as glass/palette.js. Colours are the palette at each stop.
export const FAMILIES = Object.freeze([
  { key: 'deep-teal', name: 'Deep teal', rate: 5, color: '#3a939c' },
  { key: 'sea-glass', name: 'Sea glass', rate: 10, color: '#54ab9a' },
  { key: 'jade', name: 'Jade', rate: 15, color: '#65a47f' },
  { key: 'peridot', name: 'Peridot', rate: 21, color: '#9ba960' },
  { key: 'honey', name: 'Honey', rate: 28, color: '#b58a4a' },
  { key: 'amber', name: 'Amber', rate: 40, color: '#ab6e3f' },
]);

export const FINISHES = Object.freeze([
  { key: 'gold', name: 'Gold fleck' },
  { key: 'crackle', name: 'Crackle' },
  { key: 'opal', name: 'Opal' },
]);

export const ACHIEVEMENTS = Object.freeze([
  { id: 'first-glass', title: 'First glass', description: 'Cool your first vessel.', icon: 'ph-fire' },
  { id: 'slow-breather', title: 'Slow breather', description: 'Cool a vessel at 8 breaths a minute or slower.', icon: 'ph-wind' },
  { id: 'patient', title: 'Patient', description: 'Cool a vessel at 6 breaths a minute or slower.', icon: 'ph-hourglass-medium' },
  { id: 'long-exhale', title: 'Long out-breath', description: 'Blow 5 or more breaths where the out-breath is half again as long as the in-breath.', icon: 'ph-waves' },
  { id: 'full-ten', title: 'Full ten', description: 'Blow all 10 breaths into one vessel.', icon: 'ph-stack' },
  { id: 'steady-hand', title: 'Steady hand', description: 'Blow 10 breaths without the glass pausing.', icon: 'ph-hand-palm' },
  { id: 'tall-vase', title: 'Tall vase', description: 'Shape a tall, narrow vessel.', icon: 'ph-arrows-vertical' },
  { id: 'wide-bowl', title: 'Wide bowl', description: 'Shape a wide, low vessel.', icon: 'ph-bowl-food' },
  { id: 'full-set', title: 'Full set', description: 'Cool a vessel in all 6 colour families.', icon: 'ph-palette' },
  { id: 'rare-find', title: 'Rare find', description: 'Cool a vessel with a rare finish.', icon: 'ph-sparkle' },
  { id: 'collector', title: 'Collector', description: 'Find all three rare finishes: gold fleck, crackle and opal.', icon: 'ph-diamonds-four' },
]);

const IDS = new Set(ACHIEVEMENTS.map((a) => a.id));
const squash = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
const FAMILY_BY_SQUASH = new Map(FAMILIES.flatMap((f) => [[squash(f.key), f.key], [squash(f.name), f.key]]));
const FINISH_ALIASES = new Map([
  ['gold', 'gold'], ['goldfleck', 'gold'], ['goldflecks', 'gold'],
  ['crackle', 'crackle'], ['crackled', 'crackle'],
  ['opal', 'opal'], ['opalescent', 'opal'],
]);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Colour family key from a key or name ("sea-glass", "Sea glass"), a breathing
 * rate (number), or an object with family / breathRate / palette.breathRate.
 * Returns null when nothing usable is given.
 */
export function familyOf(input) {
  if (input == null) return null;
  if (typeof input === 'string') {
    const hit = FAMILY_BY_SQUASH.get(squash(input));
    if (hit) return hit;
    const n = Number(input);
    return input.trim() && Number.isFinite(n) ? familyOf(n) : null;
  }
  if (finite(input)) {
    if (input <= 0) return null;
    // Nearest pace stop, split halfway between neighbours.
    for (let i = 0; i < FAMILIES.length - 1; i++) {
      if (input < (FAMILIES[i].rate + FAMILIES[i + 1].rate) / 2) return FAMILIES[i].key;
    }
    return FAMILIES[FAMILIES.length - 1].key;
  }
  if (typeof input === 'object') {
    for (const v of [input.family, input.key, input.meta?.family, input.palette?.family]) {
      const k = typeof v === 'string' ? familyOf(v) : null;
      if (k) return k;
    }
    for (const v of [input.breathRate, input.meta?.breathRate, input.palette?.breathRate]) {
      const k = finite(v) ? familyOf(v) : null;
      if (k) return k;
    }
  }
  return null;
}

/** Rare finish key ('gold' | 'crackle' | 'opal') from a string, recipe or run, else null. */
export function finishOf(input) {
  if (input == null) return null;
  if (typeof input === 'string') return FINISH_ALIASES.get(squash(input)) ?? null;
  if (typeof input === 'object') {
    for (const v of [input.kind, input.type, input.name, input.finish, input.meta?.finish, input.palette?.finish]) {
      if (v == null || v === input) continue;
      const k = typeof v === 'string' ? finishOf(v) : (typeof v === 'object' ? finishOf(v) : null);
      if (k) return k;
    }
  }
  return null;
}

export function finishName(input) {
  const k = finishOf(input);
  return FINISHES.find((f) => f.key === k)?.name ?? null;
}

/**
 * Shape of a vessel recipe: { tallness, width, height } or null.
 * tallness = height / diameter; width = largest radius (vessel units, max about 1.1).
 * Uses recipe.profile when present, otherwise rebuilds from recipe.breaths.
 */
export function shapeOf(recipe) {
  if (!recipe || typeof recipe !== 'object') return null;
  let profile = Array.isArray(recipe.profile) && recipe.profile.length >= 8 ? recipe.profile : null;
  if (profile && !profile.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]))) profile = null;
  if (!profile && Array.isArray(recipe.breaths) && recipe.breaths.length) {
    try { profile = buildProfile(recipe.breaths, { finish: 1 }); } catch { profile = null; }
  }
  if (!profile) return null;
  const height = profileHeight(profile);
  const width = profileMaxR(profile);
  if (!(width > 0) || !(height > 0)) return null;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { tallness: r3(height / (2 * width)), width: r3(width), height: r3(height) };
}

export function emptyState() {
  return { version: STATE_VERSION, unlocked: {}, families: [], finishes: [], vessels: 0 };
}

/** Clean any stored value (missing, old, or broken) into a valid state object. */
export function normalizeState(state) {
  const out = emptyState();
  if (!state || typeof state !== 'object' || Array.isArray(state)) return out;
  const unlocked = state.unlocked;
  if (unlocked && typeof unlocked === 'object' && !Array.isArray(unlocked)) {
    for (const [id, at] of Object.entries(unlocked)) {
      if (!IDS.has(id)) continue;
      out.unlocked[id] = finite(at) && at > 0 ? at : (at === true ? 1 : 0);
      if (!out.unlocked[id]) delete out.unlocked[id];
    }
  } else if (Array.isArray(unlocked)) {
    for (const id of unlocked) if (IDS.has(id)) out.unlocked[id] = 1; // very old: list of ids
  }
  if (Array.isArray(state.families)) {
    out.families = [...new Set(state.families.map((f) => (typeof f === 'string' ? familyOf(f) : null)).filter(Boolean))];
  }
  if (Array.isArray(state.finishes)) {
    out.finishes = [...new Set(state.finishes.map((f) => (typeof f === 'string' ? finishOf(f) : null)).filter(Boolean))];
  }
  if (finite(state.vessels) && state.vessels > 0) out.vessels = Math.floor(state.vessels);
  return out;
}

function breathList(run) {
  if (Array.isArray(run.breathList)) return run.breathList;
  if (Array.isArray(run.recipe?.breaths)) return run.recipe.breaths;
  return [];
}

function breathCount(run) {
  if (finite(run.breaths)) return Math.max(0, Math.floor(run.breaths));
  if (Array.isArray(run.breaths)) return run.breaths.length;
  return breathList(run).length;
}

/** True only when pause data is given and shows no real pause. */
function pauseFree(run) {
  const hasMs = finite(run.pausedMs);
  const hasCount = finite(run.pauses);
  if (!hasMs && !hasCount) return false;
  if (hasMs && run.pausedMs >= PAUSE_GRACE_MS) return false;
  if (hasCount && run.pauses > 0) return false;
  return true;
}

function longExhale(run) {
  const list = breathList(run).filter((b) => b && finite(b.inhaleMs) && finite(b.exhaleMs) && b.inhaleMs > 0);
  if (list.length < 5) return false;
  const inh = list.reduce((s, b) => s + b.inhaleMs, 0);
  const exh = list.reduce((s, b) => s + b.exhaleMs, 0);
  return exh >= 1.5 * inh;
}

const RULES = {
  'first-glass': ({ state }) => state.vessels >= 1,
  'slow-breather': ({ rate }) => rate != null && rate <= 8,
  patient: ({ rate }) => rate != null && rate <= 6,
  'long-exhale': ({ run }) => longExhale(run),
  'full-ten': ({ breaths }) => breaths >= TARGET_BREATHS,
  'steady-hand': ({ run, breaths }) => breaths >= TARGET_BREATHS && pauseFree(run),
  'tall-vase': ({ shape }) => !!shape && shape.tallness >= SHAPE.tallMin && shape.width <= SHAPE.tallMaxWidth,
  'wide-bowl': ({ shape }) => !!shape && shape.tallness <= SHAPE.wideMax && shape.width >= SHAPE.wideMinWidth,
  'full-set': ({ state }) => FAMILIES.every((f) => state.families.includes(f.key)),
  'rare-find': ({ state }) => state.finishes.length >= 1,
  collector: ({ state }) => FINISHES.every((f) => state.finishes.includes(f.key)),
};

/**
 * Score one finished, cut vessel.
 * @param {object} run { breaths, breathRate, family?, pausedMs?, pauses?, recipe?, finish?, fromSample? }
 * @param {object} state stored progress (any shape; it is cleaned first)
 * @param {{now?: number}} [opts]
 * @returns {{ unlocked: string[], state: object }} newly earned ids and the new state
 */
export function evaluate(run, state, { now = Date.now() } = {}) {
  const next = normalizeState(state);
  if (!run || typeof run !== 'object' || run.fromSample) return { unlocked: [], state: next };

  next.vessels += 1;
  const rate = finite(run.breathRate) && run.breathRate > 0 ? run.breathRate : null;
  const family = familyOf(typeof run.family === 'string' ? run.family : null) ?? familyOf(rate)
    ?? familyOf(run.recipe ?? null);
  if (family && !next.families.includes(family)) next.families.push(family);
  const finish = finishOf(run.finish ?? null) ?? finishOf(run.recipe ?? null);
  if (finish && !next.finishes.includes(finish)) next.finishes.push(finish);

  const ctx = { run, state: next, rate, breaths: breathCount(run), shape: shapeOf(run.recipe) };
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (next.unlocked[a.id]) continue;
    if (RULES[a.id](ctx)) { next.unlocked[a.id] = now; unlocked.push(a.id); }
  }
  return { unlocked, state: next };
}

/** One row per achievement: { id, title, description, icon, done, doneAt, progressText? }. */
export function progress(state) {
  const s = normalizeState(state);
  return ACHIEVEMENTS.map((a) => {
    const doneAt = s.unlocked[a.id] ?? null;
    const row = { ...a, done: doneAt != null, doneAt };
    if (a.id === 'full-set') row.progressText = `${s.families.length} of ${FAMILIES.length} colours`;
    if (a.id === 'collector') row.progressText = `${s.finishes.length} of ${FINISHES.length} finishes`;
    return row;
  });
}

/** Colour collection for the shelf: FAMILIES with a `seen` flag. */
export function familyProgress(state) {
  const s = normalizeState(state);
  return FAMILIES.map((f) => ({ ...f, seen: s.families.includes(f.key) }));
}
