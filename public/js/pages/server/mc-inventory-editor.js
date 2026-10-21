import { api } from '../../core/api.js';
import { esc, toast } from '../../core/util.js';
import { openModal } from '../../ui/modal.js';
import { ITEMS, ENCHANTMENTS, nice, tile, itemTitle } from './mc-items.js';

/* ------------------------------------------- Minecraft inventory editor */

/*
 * Slots as a grid of tiles: armour, off-hand, main inventory, hotbar and the
 * ender chest. Click (or Enter) a slot to edit it, drag one onto another to
 * move or swap, arrow keys move between slots. Only offline players can be
 * saved; the server keeps a copy of the old file first.
 */

const ARMOR = [[103, 'Head'], [102, 'Chest'], [101, 'Legs'], [100, 'Feet']];

export async function openInventoryEditor(serverId, name, onSaved) {
  const base = `/api/servers/${encodeURIComponent(serverId)}/players/${encodeURIComponent(name)}/inventory/edit`;
  let data;
  try {
    data = await api(base);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  // box -> Map(slot -> item); each item remembers where it was in the file (_from) so unknown tags travel with it.
  const boxes = { inventory: new Map(), ender: new Map() };
  for (const it of data.inventory) boxes.inventory.set(it.slot, { ...it, _from: { box: 'inventory', slot: it.slot } });
  for (const it of data.ender) boxes.ender.set(it.slot, { ...it, _from: { box: 'ender', slot: it.slot } });
  let selected = { box: 'inventory', slot: 0 };

  const modal = openModal({
    title: `Edit ${esc(name)}`,
    width: 760,
    body: `<div class="mce-root"></div>`,
    actions: [
      { label: 'Close', close: true },
      {
        label: 'Save changes',
        primary: true,
        onClick: async (btn) => {
          if (!data.editable) return toast(data.reason, 'error');
          btn.disabled = true;
          try {
            const out = (box) => [...boxes[box].entries()].map(([slot, it]) => ({ slot, id: it.id, count: it.count, damage: it.damage, name: it.name, enchants: it.enchants, from: it._from }));
            await api(base, { method: 'PUT', body: { version: data.version, inventory: out('inventory'), ender: out('ender') } });
            toast(`${name}'s items saved. The old file is kept in .gamepanel/player-rollbacks.`);

            modal.close();
            onSaved?.();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
  const root = document.querySelector('.modal-backdrop:last-child .mce-root');
  if (!root) return;
  const saveBtn = [...document.querySelectorAll('.modal-backdrop:last-child .modal-foot button')].find((b) => /Save/.test(b.textContent));
  if (saveBtn && !data.editable) saveBtn.disabled = true;

  const get = (s) => boxes[s.box].get(s.slot);

  const slotHtml = (box, slot, label = '') => {
    const it = boxes[box].get(slot);
    const sel = selected.box === box && selected.slot === slot;
    return `<button type="button" class="mce-slot ${sel ? 'sel' : ''}" role="gridcell" tabindex="${sel ? 0 : -1}" draggable="${it && data.editable ? 'true' : 'false'}" data-box="${box}" data-slot="${slot}" aria-label="${esc(label || `Slot ${slot}`)}: ${esc(it ? `${it.count} ${it.name || nice(it.id)}` : 'empty')}" title="${esc(it ? itemTitle(it) : label || `Slot ${slot}`)}">${tile(it)}</button>`;
  };
  const row = (box, from, to) => Array.from({ length: to - from + 1 }, (_, i) => slotHtml(box, from + i, from + i < 9 && box === 'inventory' ? `Hotbar ${from + i + 1}` : '')).join('');

  function draw() {
    const sel = get(selected);
    root.innerHTML = `
      ${data.editable ? '' : `<div class="card warn-card mb-8" style="font-size:13px">${esc(data.reason)} You can look, but not save.</div>`}
      <div class="mce-layout">
        <div>
          <div class="mce-label">Armour and off-hand</div>
          <div class="mce-armor" role="grid" aria-label="Armour">${ARMOR.map(([s, l]) => slotHtml('inventory', s, l)).join('')}<span class="mce-gap"></span>${slotHtml('inventory', -106, 'Off-hand')}</div>
          <div class="mce-label">Inventory</div>
          <div class="mce-grid" role="grid" aria-label="Inventory">${row('inventory', 9, 35)}</div>
          <div class="mce-label">Hotbar</div>
          <div class="mce-grid mce-hotbar" role="grid" aria-label="Hotbar">${row('inventory', 0, 8)}</div>
          <div class="mce-label">Ender chest</div>
          <div class="mce-grid" role="grid" aria-label="Ender chest">${row('ender', 0, 26)}</div>
        </div>
        <div class="mce-side">
          <div class="mce-label">${selected.box === 'ender' ? 'Ender chest' : 'Inventory'} slot ${selected.slot}</div>
          ${sel ? editForm(sel) : addForm()}
        </div>
      </div>`;
    wire();
  }

  const editForm = (it) => `
    <div class="mce-form">
      <label class="field"><span>Item</span><input id="mce-id" list="mce-items" value="${esc(it.id)}" maxlength="80" ${data.editable ? '' : 'disabled'} /></label>
      <div class="row" style="gap:8px">
        <label class="field" style="flex:1"><span>Count</span><input id="mce-count" type="number" min="1" max="99" value="${Number(it.count)}" ${data.editable ? '' : 'disabled'} /></label>
        <label class="field" style="flex:1"><span>Damage</span><input id="mce-damage" type="number" min="0" max="32767" value="${Number(it.damage) || 0}" ${data.editable ? '' : 'disabled'} /></label>
      </div>
      <label class="field"><span>Custom name</span><input id="mce-name" value="${esc(it.name || '')}" maxlength="100" placeholder="${esc(nice(it.id))}" ${data.editable ? '' : 'disabled'} /></label>
      <div class="mce-label">Enchantments</div>
      <div id="mce-ench">${it.enchants.map((e, i) => enchRow(e, i)).join('')}</div>
      ${data.editable ? `<button type="button" class="btn btn-sm btn-ghost" id="mce-add-ench">Add enchantment</button>` : ''}
      ${data.editable ? `<div class="row mt-8" style="gap:8px"><button type="button" class="btn btn-sm btn-primary" id="mce-apply">Apply to slot</button><button type="button" class="btn btn-sm btn-danger" id="mce-del">Delete item</button></div>` : ''}
    </div>
    <datalist id="mce-items">${ITEMS.map((i) => `<option value="minecraft:${i}">`).join('')}</datalist>
    <datalist id="mce-enchs">${ENCHANTMENTS.map((i) => `<option value="minecraft:${i}">`).join('')}</datalist>`;

  const enchRow = (e, i) => `<div class="row mce-ench-row" data-i="${i}" style="gap:6px;margin-bottom:4px"><input class="mce-eid" list="mce-enchs" value="${esc(e.id)}" style="flex:1;min-width:0" aria-label="Enchantment" /><input class="mce-elv" type="number" min="1" max="255" value="${Number(e.level)}" style="width:64px" aria-label="Level" /><button type="button" class="btn btn-sm btn-ghost" data-rm-ench="${i}" aria-label="Remove enchantment">x</button></div>`;

  const addForm = () => `
    <div class="faint" style="font-size:13px;margin-bottom:8px">This slot is empty.${data.editable ? ' Search for an item to put in it.' : ''}</div>
    ${
      data.editable
        ? `<label class="field"><span>Search items</span><input id="mce-search" placeholder="diamond, elytra, golden_apple…" autocomplete="off" /></label>
           <div id="mce-results" class="mce-results"></div>`
        : ''
    }`;

  function readForm() {
    const it = get(selected);
    if (!it) return null;
    const id = root.querySelector('#mce-id').value.trim().toLowerCase();
    const enchants = [...root.querySelectorAll('.mce-ench-row')].map((r) => ({ id: r.querySelector('.mce-eid').value.trim().toLowerCase(), level: Number(r.querySelector('.mce-elv').value) })).filter((e) => e.id);
    return { ...it, id: id.includes(':') ? id : `minecraft:${id}`, count: Number(root.querySelector('#mce-count').value) || 1, damage: Number(root.querySelector('#mce-damage').value) || 0, name: root.querySelector('#mce-name').value, enchants };
  }

  function place(item, target) {
    boxes[target.box].set(target.slot, item);

  }

  function move(from, to) {
    if (from.box === to.box && from.slot === to.slot) return;
    const a = get(from);
    const b = get(to);
    if (!a) return;
    boxes[from.box].delete(from.slot);
    if (b) boxes[from.box].set(from.slot, b);
    boxes[to.box].set(to.slot, a);

    selected = to;
    draw();
  }

  function wire() {
    const slots = [...root.querySelectorAll('.mce-slot')];
    for (const el of slots) {
      const where = () => ({ box: el.dataset.box, slot: Number(el.dataset.slot) });
      el.addEventListener('click', () => {
        selected = where();
        draw();
        root.querySelector(`.mce-slot[data-box="${selected.box}"][data-slot="${selected.slot}"]`)?.focus();
      });
      el.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', JSON.stringify(where()));
        ev.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragover', (ev) => {
        if (data.editable) ev.preventDefault();
      });
      el.addEventListener('drop', (ev) => {
        ev.preventDefault();
        try {
          const from = JSON.parse(ev.dataTransfer.getData('text/plain'));
          if (data.editable && boxes[from.box]) move({ box: String(from.box), slot: Number(from.slot) }, where());
        } catch {
          /* not one of ours */
        }
      });
      el.addEventListener('keydown', (ev) => {
        const i = slots.indexOf(el);
        const cols = el.closest('.mce-armor') ? 1 : 9;
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: slots.length - 1 }[ev.key];
        if (next !== undefined && slots[next]) {
          ev.preventDefault();
          const t = slots[next];
          selected = { box: t.dataset.box, slot: Number(t.dataset.slot) };
          draw();
          root.querySelector(`.mce-slot[data-box="${selected.box}"][data-slot="${selected.slot}"]`)?.focus();
        } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && data.editable && get(where())) {
          ev.preventDefault();
          boxes[el.dataset.box].delete(Number(el.dataset.slot));

          draw();
          root.querySelector(`.mce-slot[data-box="${el.dataset.box}"][data-slot="${el.dataset.slot}"]`)?.focus();
        }
      });
    }
    root.querySelector('#mce-apply')?.addEventListener('click', () => {
      const it = readForm();
      if (it) {
        place(it, selected);
        draw();
      }
    });
    root.querySelector('#mce-del')?.addEventListener('click', () => {
      boxes[selected.box].delete(selected.slot);

      draw();
    });
    root.querySelector('#mce-add-ench')?.addEventListener('click', () => {
      const it = readForm();
      if (!it) return;
      it.enchants.push({ id: 'minecraft:unbreaking', level: 1 });
      place(it, selected);
      draw();
    });
    root.querySelectorAll('[data-rm-ench]').forEach((b) =>
      b.addEventListener('click', () => {
        const it = readForm();
        it.enchants.splice(Number(b.dataset.rmEnch), 1);
        place(it, selected);
        draw();
      })
    );
    const search = root.querySelector('#mce-search');
    if (search) {
      const results = root.querySelector('#mce-results');
      const show = () => {
        const q = search.value.trim().toLowerCase().replace(/\s+/g, '_');
        const hits = (q ? ITEMS.filter((i) => i.includes(q)) : ITEMS.slice(0, 40)).slice(0, 40);
        results.innerHTML = hits.map((i) => `<button type="button" class="mce-hit" data-add="${esc(i)}">${tile({ id: i, count: 1 })}<span>${esc(nice(i))}</span></button>`).join('') || `<div class="faint" style="font-size:12.5px">No match. Type the full id in the slot form after adding any item.</div>`;
        results.querySelectorAll('[data-add]').forEach((b) =>
          b.addEventListener('click', () => {
            place({ slot: selected.slot, id: `minecraft:${b.dataset.add}`, count: 1, damage: 0, name: '', enchants: [], _from: null }, selected);
            draw();
          })
        );
      };
      search.addEventListener('input', show);
      show();
    }
  }

  draw();
  root.querySelector(`.mce-slot[data-box="inventory"][data-slot="0"]`)?.focus();
}
