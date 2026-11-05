// Cooling rack: lists kept vessels from the local store, with per-item and
// delete-all controls. Everything here lives on this computer only.
// Above the vessels sits the shop shelf: the colour collection and the
// achievement marks, read from store.getProgress() when the store has it.
import { paceText } from './names.js';
import { progress as achievementRows, familyProgress, finishName, FAMILIES } from '../game/achievements.js';

const DATE_FMT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const DAY_FMT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const icon = (name) => {
  const i = el('i', `ph ${name}`);
  i.setAttribute('aria-hidden', 'true');
  return i;
};

/**
 * @param {object} o
 * @param {HTMLElement} [o.shelfHead] optional container for the shop shelf; made and placed
 *   just before `shelf` when left out.
 * The shelf shows only when the store has getProgress() or setProgress() is called.
 */
export function createRack({ shelf, empty, sub, deleteAllBtn, confirmDialog, store, onShare, onInspect, shelfHead }) {
  let items = [];
  let progressState = null;
  let hasProgress = typeof store?.getProgress === 'function';
  let head = shelfHead ?? null;

  async function refresh() {
    const [list, prog] = await Promise.all([
      Promise.resolve().then(() => store.listVessels()).catch((e) => { console.error('[rack] list failed', e); return []; }),
      hasProgress
        ? Promise.resolve().then(() => store.getProgress()).catch((e) => { console.error('[rack] progress failed', e); return null; })
        : null,
    ]);
    items = list ?? [];
    if (hasProgress) progressState = prog;
    render();
  }

  /** Show a new progress state right away (for example after evaluate()). */
  function setProgress(state) {
    hasProgress = true;
    progressState = state ?? null;
    renderHead();
  }

  function renderHead() {
    if (!hasProgress) { if (head) head.hidden = true; return; }
    if (!head) {
      head = el('section', 'shop-shelf');
      // Vessels come first; the collection and marks sit below them.
      (empty ?? shelf).after(head);
    }
    head.classList.add('shop-shelf');
    head.setAttribute('aria-label', 'Your collection');
    head.hidden = false;
    head.replaceChildren(colourBlock(), marksBlock());
  }

  function colourBlock() {
    const fams = familyProgress(progressState);
    const seen = fams.filter((f) => f.seen).length;
    const box = el('div', 'shop-colours');
    const label = el('p', 'shop-kicker', 'Colours found');
    const list = el('ul', 'swatches');
    list.setAttribute('aria-label', `Colour collection, ${seen} of ${FAMILIES.length} found`);
    for (const f of fams) {
      const li = el('li', f.seen ? 'swatch seen' : 'swatch');
      const text = `${f.name}${f.seen ? '' : ' (not found yet)'}`;
      li.title = text;
      li.setAttribute('role', 'img');
      li.setAttribute('aria-label', text);
      if (f.seen) li.style.setProperty('--swatch', f.color);
      list.append(li);
    }
    const count = el('p', 'shop-count');
    count.append(el('b', null, String(seen)), ` of ${FAMILIES.length} colours`);
    box.append(label, list, count);
    return box;
  }

  function marksBlock() {
    const rows = achievementRows(progressState);
    const earned = rows.filter((r) => r.done).length;
    const box = el('div', 'shop-marks');
    const top = el('p', 'shop-kicker');
    top.append('Marks of the shop ', el('span', 'shop-tally', `${earned} of ${rows.length}`));
    const list = el('ul', 'badges');
    list.setAttribute('aria-label', 'Achievements');
    for (const r of rows) {
      const li = el('li', r.done ? 'badge earned' : 'badge');
      li.tabIndex = 0;
      li.setAttribute('role', 'img');
      const status = r.done
        ? (r.doneAt > 1 ? `earned ${DAY_FMT.format(new Date(r.doneAt))}` : 'earned')
        : (r.progressText ? `not yet, ${r.progressText}` : 'not yet');
      li.setAttribute('aria-label', `${r.title}, ${status}. ${r.description}`);
      const tip = el('span', 'tip', r.description);
      tip.setAttribute('aria-hidden', 'true');
      if (r.progressText && !r.done) tip.append(el('span', 'tip-more', r.progressText));
      if (r.done && r.doneAt > 1) tip.append(el('span', 'tip-more', `Earned ${DAY_FMT.format(new Date(r.doneAt))}`));
      li.append(icon(r.icon), el('span', 'badge-title', r.title), tip);
      // Flip the tooltip to the left when it would run off the right edge.
      const place = () => li.classList.toggle('tip-flip', li.getBoundingClientRect().left + 280 > document.documentElement.clientWidth - 16);
      li.addEventListener('pointerenter', place);
      li.addEventListener('focus', place);
      list.append(li);
    }
    box.append(top, list);
    return box;
  }

  function render() {
    renderHead();
    shelf.replaceChildren();
    empty.hidden = items.length > 0;
    deleteAllBtn.hidden = items.length === 0;
    sub.textContent = items.length
      ? `${items.length} vessel${items.length === 1 ? '' : 's'}, saved on this computer only.`
      : 'Saved on this computer only.';
    items.forEach((item, i) => {
      const meta = item.recipe?.meta ?? {};
      const number = items.length - i;
      const li = document.createElement('li');
      const plate = document.createElement('div');
      plate.className = 'plate';
      const img = document.createElement('img');
      img.src = item.pngDataUrl;
      img.alt = `${meta.name ?? 'Glass'} vessel number ${number}`;
      if (onInspect && item.recipe) {
        // The picture opens the vessel large, in 3D, to turn by hand.
        const look = document.createElement('button');
        look.type = 'button';
        look.className = 'look';
        look.setAttribute('aria-label', `Turn ${meta.name ?? 'glass'} vessel number ${number} in 3D`);
        look.append(img, el('span', 'look-tag'));
        look.lastChild.append(icon('ph-cube'), 'Turn in 3D');
        plate.append(look);
        look.addEventListener('click', () => onInspect(item, { number, opener: look }));
      } else {
        plate.append(img);
      }
      const h3 = document.createElement('h3');
      h3.textContent = `No. ${number} ${meta.name ?? ''}`.trim();
      const finish = finishName(item.recipe);
      if (finish) {
        const tag = el('span', 'finish-tag');
        tag.append(icon('ph-sparkle'), finish);
        tag.setAttribute('aria-label', `Rare finish: ${finish}`);
        plate.append(tag);
      }
      const p = document.createElement('p');
      const when = item.createdAt ? DATE_FMT.format(new Date(item.createdAt)) : '';
      const breaths = Number(meta.breaths) || item.recipe?.breaths?.length || 0;
      p.append(when, document.createElement('br'), `${breaths} breaths, ${paceText(meta.breathRate)}`);
      if (meta.source === 'replay') p.append(document.createElement('br'), 'from the sample recording');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.innerHTML = '<i class="ph ph-trash" aria-hidden="true"></i><span>Delete</span>';
      del.setAttribute('aria-label', `Delete vessel number ${number}`);
      let armed = false;
      let timer = 0;
      del.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          del.classList.add('confirm');
          del.querySelector('span').textContent = 'Click again to delete';
          timer = setTimeout(() => { armed = false; del.classList.remove('confirm'); del.querySelector('span').textContent = 'Delete'; }, 3000);
          return;
        }
        clearTimeout(timer);
        try { await store.deleteVessel(item.id); } catch (e) { console.error('[rack] delete failed', e); }
        refresh();
      });
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'del save';
      save.innerHTML = '<i class="ph ph-share-network" aria-hidden="true"></i><span>Share</span>';
      save.setAttribute('aria-label', `Share vessel number ${number}`);
      save.addEventListener('click', () => onShare?.({
        pngDataUrl: item.pngDataUrl, name: meta.name ?? 'Glass', number, breaths,
        breathRate: Number.isFinite(meta.breathRate) ? meta.breathRate : null,
        createdAt: item.createdAt, fromSample: meta.source === 'replay',
      }));
      const tools = document.createElement('div');
      tools.className = 'tools';
      tools.append(save, del);
      li.append(plate, h3, p, tools);
      shelf.append(li);
    });
  }

  deleteAllBtn.addEventListener('click', () => {
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
  });
  confirmDialog.addEventListener('close', async () => {
    if (confirmDialog.returnValue !== 'ok') return;
    try { await store.deleteAll(); } catch (e) { console.error('[rack] delete all failed', e); }
    refresh();
  });

  return { refresh, setProgress };
}
