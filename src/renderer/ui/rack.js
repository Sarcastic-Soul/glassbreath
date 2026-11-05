// Cooling rack: lists kept vessels from the local store, with per-item and
// delete-all controls. Everything here lives on this computer only.
import { paceText } from './names.js';

const DATE_FMT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function createRack({ shelf, empty, sub, deleteAllBtn, confirmDialog, store, onShare }) {
  let items = [];

  async function refresh() {
    try { items = (await store.listVessels()) ?? []; } catch (e) { console.error('[rack] list failed', e); items = []; }
    render();
  }

  function render() {
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
      plate.append(img);
      const h3 = document.createElement('h3');
      h3.textContent = `No. ${number} ${meta.name ?? ''}`.trim();
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

  return { refresh };
}
