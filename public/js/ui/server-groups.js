import { api } from '../core/api.js';
import { render } from '../core/router.js';
import { state } from '../core/state.js';
import { $, can, esc, icon, toast } from '../core/util.js';
import { renderSidebarServers } from './sidebar.js';
import { isPinned, pinnedFirst, pinnedServers, prefs, savePrefs, togglePin } from './ux-prefs.js';

/* ------------------------------------------- folders, tags and pinned servers */

// The tag filter is a view setting: it lasts until the page is reloaded.
let activeTag = null;

const knownIds = () => new Set(state.servers.map((s) => s.id));
const tagsOf = (id) => prefs().tags[id] || [];

export function starButton(server) {
  const on = isPinned(server.id);
  return `<button class="btn btn-sm btn-ghost ux-star ${on ? 'on' : ''}" data-ux-star="${esc(server.id)}" aria-pressed="${on}" aria-label="${on ? 'Unpin' : 'Pin'} ${esc(server.name)}" title="${on ? 'Unpin from the top' : 'Pin to the top'}">${icon(on ? 'starFill' : 'star', 13)}</button>`;
}

export function organizeButton(server) {
  return `<button class="btn btn-sm btn-ghost" data-ux-organize="${esc(server.id)}" aria-label="Tags and folder for ${esc(server.name)}" title="Tags and folder">${icon('tag', 13)}</button>`;
}

export function tagChips(id) {
  const tags = tagsOf(id);
  if (!tags.length) return '';
  return `<span class="ux-tags">${tags.map((t) => `<span class="ux-tag">#${esc(t)}</span>`).join('')}</span>`;
}

/** Tag filter chips and the "New folder" button above a server list. */
export function filterBar() {
  const ids = knownIds();
  const all = new Set();
  for (const [id, tags] of Object.entries(prefs().tags)) if (ids.has(id)) tags.forEach((t) => all.add(t));
  if (activeTag && !all.has(activeTag)) activeTag = null;
  if (!all.size && state.servers.length < 2) return '';
  const chips = [...all].sort();
  return `<div class="ux-filter" role="group" aria-label="Filter servers by tag">
    ${chips.length ? `<button class="chip ${activeTag ? '' : 'active'}" data-ux-filter="" aria-pressed="${!activeTag}">All</button>${chips.map((t) => `<button class="chip ${activeTag === t ? 'active' : ''}" data-ux-filter="${esc(t)}" aria-pressed="${activeTag === t}">#${esc(t)}</button>`).join('')}` : ''}
    <span class="spacer" style="flex:1"></span>
    <button class="btn btn-sm btn-ghost" data-ux-newfolder>${icon('plus', 12)} New folder</button>
  </div>`;
}

/**
 * Rows for a server list: pinned servers first, then each folder (collapsible,
 * with its own start/stop), then the rest. `row` draws one server.
 */
export function groupedRows(servers, row, { pinnedOnly = false, hidePinned = false } = {}) {
  if (pinnedOnly) return pinnedServers().map(row).join('');
  const ids = knownIds();
  let list = servers.filter((s) => (!activeTag || tagsOf(s.id).includes(activeTag)) && !(hidePinned && isPinned(s.id)));
  list = pinnedFirst(list);
  const out = [];
  const placed = new Set();
  const folders = prefs().folders;
  const pinnedBlock = list.filter((s) => isPinned(s.id) && !folders.some((f) => f.servers.includes(s.id)));
  pinnedBlock.forEach((s) => placed.add(s.id));
  out.push(...pinnedBlock.map(row));
  for (const folder of folders) {
    const members = list.filter((s) => folder.servers.includes(s.id) && ids.has(s.id));
    // An empty folder stays visible so it can be filled or removed, except while a tag filter hides everything.
    if (!members.length && activeTag) continue;
    members.forEach((s) => placed.add(s.id));
    out.push(folderHead(folder, members));
    if (!folder.collapsed) out.push(...members.map(row));
  }
  out.push(...list.filter((s) => !placed.has(s.id)).map(row));
  return out.join('');
}

function folderHead(folder, members) {
  const running = members.filter((s) => ['running', 'starting'].includes(s.status)).length;
  const power = can('power') && members.length;
  return `<div class="ux-folder-head" data-ux-folder="${esc(folder.id)}">
    <button class="ux-folder-toggle" data-ux-fold="${esc(folder.id)}" aria-expanded="${!folder.collapsed}" aria-label="${folder.collapsed ? 'Expand' : 'Collapse'} folder ${esc(folder.name)}">
      <span class="ux-caret">${folder.collapsed ? '▸' : '▾'}</span><b>${esc(folder.name)}</b>
      <span class="faint">${members.length} server${members.length === 1 ? '' : 's'}${running ? ` · ${running} online` : ''}</span>
    </button>
    <span class="srv-actions">
      ${power ? `<button class="btn btn-sm btn-ghost" data-ux-folder-power="start" data-folder="${esc(folder.id)}" aria-label="Start every server in ${esc(folder.name)}" title="Start all in this folder">${icon('play', 11)}</button><button class="btn btn-sm btn-ghost btn-danger" data-ux-folder-power="stop" data-folder="${esc(folder.id)}" aria-label="Stop every server in ${esc(folder.name)}" title="Stop all in this folder">${icon('stop', 11)}</button>` : ''}
      <button class="btn btn-sm btn-ghost" data-ux-folder-rename="${esc(folder.id)}" aria-label="Rename folder ${esc(folder.name)}" title="Rename">${icon('edit', 12)}</button>
      <button class="btn btn-sm btn-ghost" data-ux-folder-delete="${esc(folder.id)}" aria-label="Delete folder ${esc(folder.name)}" title="Delete folder (servers stay)">${icon('close', 12)}</button>
    </span>
  </div>`;
}

/* --------------------------------------------------------------- actions */

function refresh() {
  render();
  renderSidebarServers();
}

const newId = () => `f${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

async function addFolder() {
  const { promptModal } = await import('./modal.js');
  const name = await promptModal('New folder', 'Folder name', '', { hint: 'Group servers, for example by game or by community.' });
  if (!name) return;
  const folders = [...prefs().folders, { id: newId(), name: name.slice(0, 40), servers: [], collapsed: false }];
  await savePrefs({ folders });
  refresh();
}

async function renameFolder(id) {
  const folder = prefs().folders.find((f) => f.id === id);
  if (!folder) return;
  const { promptModal } = await import('./modal.js');
  const name = await promptModal('Rename folder', 'Folder name', folder.name);
  if (!name) return;
  await savePrefs({ folders: prefs().folders.map((f) => (f.id === id ? { ...f, name: name.slice(0, 40) } : f)) });
  refresh();
}

async function deleteFolder(id) {
  const folder = prefs().folders.find((f) => f.id === id);
  if (!folder) return;
  const { confirmModal } = await import('./modal.js');
  if (!(await confirmModal('Delete folder', `"${folder.name}" is removed. Its servers are not touched.`, 'Delete'))) return;
  await savePrefs({ folders: prefs().folders.filter((f) => f.id !== id) });
  refresh();
}

async function folderPower(id, action) {
  const folder = prefs().folders.find((f) => f.id === id);
  if (!folder) return;
  const targets = state.servers.filter(
    (s) => folder.servers.includes(s.id) && can('power', s.id) && (action === 'start' ? ['offline', 'crashed'].includes(s.status) && s.installedAt : ['running', 'starting'].includes(s.status))
  );
  if (!targets.length) return toast(action === 'start' ? 'Everything in this folder is already running' : 'Nothing in this folder is running');
  const { confirmModal } = await import('./modal.js');
  if (!(await confirmModal(`${action === 'start' ? 'Start' : 'Stop'} ${targets.length} server${targets.length === 1 ? '' : 's'}`, targets.map((s) => s.name).join(', '), action === 'start' ? 'Start' : 'Stop'))) return;
  const results = await Promise.allSettled(targets.map((s) => api(`/api/servers/${s.id}/power`, { method: 'POST', body: { action } })));
  const failed = results.filter((r) => r.status === 'rejected').length;
  toast(`${action === 'start' ? 'Starting' : 'Stopping'} ${targets.length - failed} server${targets.length - failed === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`, failed ? 'warn' : 'info');
}

export async function openOrganize(serverId) {
  const server = state.servers.find((s) => s.id === serverId);
  if (!server) return;
  const { openModal } = await import('./modal.js');
  const current = prefs().folders.find((f) => f.servers.includes(serverId))?.id || '';
  const modal = openModal({
    title: `Organize ${esc(server.name)}`,
    width: 460,
    body: `<label><span>Tags</span><input id="ux-tags-input" value="${esc(tagsOf(serverId).join(', '))}" placeholder="e.g. pvp, modded, friends" /></label>
      <div class="hint mt-8">Separate with commas. Up to 8 tags; use the tag chips above the list to filter.</div>
      <label class="mt-16"><span>Folder</span><select id="ux-folder-select"><option value="">No folder</option>${prefs()
        .folders.map((f) => `<option value="${esc(f.id)}" ${f.id === current ? 'selected' : ''}>${esc(f.name)}</option>`)
        .join('')}</select></label>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          const tags = [...new Set($('#ux-tags-input').value.split(',').map((t) => t.replace(/[#<>]/g, '').trim().toLowerCase().slice(0, 24)).filter(Boolean))].slice(0, 8);
          const folderId = $('#ux-folder-select').value;
          const nextTags = { ...prefs().tags };
          if (tags.length) nextTags[serverId] = tags;
          else delete nextTags[serverId];
          const folders = prefs().folders.map((f) => ({ ...f, servers: f.servers.filter((x) => x !== serverId).concat(f.id === folderId ? [serverId] : []) }));
          modal.close();
          await savePrefs({ tags: nextTags, folders });
          refresh();
        },
      },
    ],
  });
}

/** One delegated listener for everything above; call once at start-up. */
export function initServerGroups() {
  document.addEventListener('click', (event) => {
    const t = event.target;
    const hit = (sel) => t.closest?.(sel);
    let el;
    if ((el = hit('[data-ux-star]'))) {
      event.preventDefault();
      togglePin(el.dataset.uxStar);
      refresh();
    } else if ((el = hit('[data-ux-filter]'))) {
      activeTag = el.dataset.uxFilter || null;
      refresh();
    } else if (hit('[data-ux-newfolder]')) addFolder();
    else if ((el = hit('[data-ux-organize]'))) openOrganize(el.dataset.uxOrganize);
    else if ((el = hit('[data-ux-fold]'))) {
      const id = el.dataset.uxFold;
      savePrefs({ folders: prefs().folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f)) });
      refresh();
      document.querySelector(`[data-ux-fold="${CSS.escape(id)}"]`)?.focus();
    } else if ((el = hit('[data-ux-folder-rename]'))) renameFolder(el.dataset.uxFolderRename);
    else if ((el = hit('[data-ux-folder-delete]'))) deleteFolder(el.dataset.uxFolderDelete);
    else if ((el = hit('[data-ux-folder-power]'))) folderPower(el.dataset.folder, el.dataset.uxFolderPower);
  });
}
