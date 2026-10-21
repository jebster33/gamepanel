import { api } from '../../core/api.js';
import { can, esc, fmtTime, toast, icon } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';
import { skeleton } from '../../ui/skeleton.js';
import { tile, itemTitle } from './mc-items.js';

/* ------------------------------------------------- a Minecraft player's inventory */

// Items are drawn by the panel itself (mc-items.js): no image host sees who is looking.
function slot(it, extra = '') {
  if (!it) return `<div class="inv-slot ${extra}"></div>`;
  const view = { ...it, id: `minecraft:${it.id}`, enchants: (it.enchants || []).map((e) => ({ id: String(e.id).toLowerCase().replace(/ /g, '_'), level: e.level })) };
  return `<div class="inv-slot ${extra}" title="${esc(itemTitle(view))}">${tile(view)}</div>`;
}

function grid(items, from, to) {
  const by = new Map(items.map((it) => [it.slot, it]));
  let html = '';
  for (let i = from; i <= to; i++) html += slot(by.get(i));
  return html;
}

export async function renderInventory(box, serverId, name) {
  let backupsList = [];
  const draw = async (backup = '') => {
    box.innerHTML = skeleton('card', 'Reading the inventory…');
    let inv;
    try {
      inv = await api(`/api/servers/${encodeURIComponent(serverId)}/players/${encodeURIComponent(name)}/inventory${backup ? `?backup=${encodeURIComponent(backup)}` : ''}`);
    } catch (err) {
      box.innerHTML = `<div class="faint" style="font-size:13px">${esc(err.message)}</div>${picker(backup)}`;
      wire(backup);
      return;
    }
    if (!box.isConnected) return;
    const a = inv.armor;
    box.innerHTML = `
      ${picker(backup)}
      <div class="inv-stats faint"><span class="inline-icon">${icon('heart', 13)} ${inv.health}</span> · <span class="inline-icon">${icon('food', 13)} ${inv.food}</span> · <span class="inline-icon">${icon('level', 13)} level ${inv.level}</span>${inv.gamemode ? ` · ${esc(inv.gamemode)}` : ''}${inv.pos ? ` · ${esc(inv.dimension)} ${inv.pos.join(', ')}` : ''}${inv.online && !backup ? ' · <span class="lime">online: this may be a few minutes old</span>' : ''}</div>
      <div class="inv-wrap">
        <div class="inv-side">${slot(a.head)}${slot(a.chest)}${slot(a.legs)}${slot(a.feet)}<div class="inv-gap"></div>${slot(inv.offhand)}</div>
        <div class="inv-main">
          <div class="inv-grid">${grid(inv.inventory, 9, 35)}</div>
          <div class="inv-grid inv-hotbar">${grid(inv.inventory, 0, 8)}</div>
        </div>
      </div>
      ${inv.ender.length ? `<div class="field-label mt-8">Ender chest</div><div class="inv-grid">${grid(inv.ender, 0, 26)}</div>` : ''}
      ${!backup && can('files.write') ? `<div class="row mt-8" style="justify-content:flex-end"><button class="btn btn-sm" id="inv-edit">${inv.online ? 'Open editor (read only while online)' : 'Edit items'}</button></div>` : ''}
      ${backup && can('backups.restore') ? `<div class="row mt-8" style="justify-content:flex-end"><button class="btn btn-sm btn-primary" id="inv-restore">Put this inventory back</button></div>` : ''}`;
    wire(backup);
  };
  const picker = (backup) =>
    backupsList.length
      ? `<div class="row mb-8" style="gap:8px"><span class="faint" style="font-size:12.5px">Show</span><select id="inv-when" style="width:auto;flex:1">
          <option value="">Now</option>
          ${backupsList.map((b) => `<option value="${esc(b.name)}" ${b.name === backup ? 'selected' : ''}>Backup of ${esc(fmtTime(b.createdAt))}</option>`).join('')}
        </select></div>`
      : '';
  const wire = (backup) => {
    box.querySelector('#inv-edit')?.addEventListener('click', () => import('./mc-inventory-editor.js').then((m) => m.openInventoryEditor(serverId, name, () => draw(''))));
    box.querySelector('#inv-when')?.addEventListener('change', (e) => draw(e.target.value));
    box.querySelector('#inv-restore')?.addEventListener('click', async () => {
      if (!(await confirmModal('Put the inventory back', `${name}'s inventory, ender chest, health and position go back to how they were in this backup. The current ones are kept in .gamepanel/player-rollbacks. ${name} must be offline.`, 'Put it back'))) return;
      try {
        await api(`/api/servers/${encodeURIComponent(serverId)}/players/${encodeURIComponent(name)}/inventory/restore`, { method: 'POST', body: { backup } });
        toast(`${name}'s inventory is back as it was`);
        draw('');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  };
  if (can('backups')) backupsList = (await api(`/api/servers/${encodeURIComponent(serverId)}/backups`).catch(() => ({ backups: [] }))).backups.slice(0, 30);
  draw('');
}
