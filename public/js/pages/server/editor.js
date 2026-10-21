import { api } from '../../core/api.js';
import { $, esc, icon, toast } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';
import { openConfigHistory } from './config-history.js';
import { openCompare } from './compare.js';
import { lintConfig } from './files.js';

/* ---------------------------------------------------------------- editor */

// A file workspace: several files open as tabs, optionally in two panes side
// by side. Unsaved edits are marked on the tab. Which files were open is kept
// per server in this browser (paths only, never contents).

const storeKey = (id) => `gp-editor:${id}`;
const workspaces = new Map();

export const baseName = (path) => String(path).split('/').filter(Boolean).pop() || path;

/** What a server's editor remembers: { tabs: [paths], panes: [path|null, path|null], split }. Pure; tests use it. */
export function cleanSaved(raw) {
  const out = { tabs: [], panes: [null, null], split: false };
  if (!raw || typeof raw !== 'object') return out;
  out.tabs = (Array.isArray(raw.tabs) ? raw.tabs : []).filter((p) => typeof p === 'string' && p && p.length < 500).filter((p, i, a) => a.indexOf(p) === i).slice(0, 20);
  out.panes = [0, 1].map((i) => (out.tabs.includes(raw.panes?.[i]) ? raw.panes[i] : null));
  if (!out.panes[0]) out.panes[0] = out.tabs[0] || null;
  out.split = Boolean(raw.split) && out.tabs.length > 1;
  return out;
}

function readSaved(id) {
  try {
    return cleanSaved(JSON.parse(localStorage.getItem(storeKey(id)) || 'null'));
  } catch {
    return cleanSaved(null);
  }
}

function writeSaved(ws) {
  try {
    if (!ws.tabs.length) localStorage.removeItem(storeKey(ws.server.id));
    else localStorage.setItem(storeKey(ws.server.id), JSON.stringify({ tabs: ws.tabs.map((t) => t.path), panes: ws.panes, split: ws.split }));
  } catch {
    /* private mode */
  }
}

const dirty = (tab) => tab.content !== tab.saved;

function workspaceFor(server) {
  let ws = workspaces.get(server.id);
  if (!ws) {
    ws = { server, tabs: [], panes: [null, null], split: false, focus: 0, root: null, opener: null, onSaved: null };
    workspaces.set(server.id, ws);
  }
  ws.server = server;
  return ws;
}

async function loadTab(ws, path) {
  const viewer = viewerFor(path);
  if (viewer) return { path, content: '', saved: '', viewer };
  const data = await api(`/api/servers/${encodeURIComponent(ws.server.id)}/files/content?path=${encodeURIComponent(path)}`);
  return { path, content: data.content ?? '', saved: data.content ?? '' };
}

/**
 * Other features (a file preview, an image viewer) can show their own content in
 * an editor tab: register a handler for a path, and openInEditor calls it instead
 * of loading text. A handler is { match(path) -> bool, render(host, { server, path }) -> cleanup? }.
 * Such a tab is read-only and never counts as unsaved.
 */
const viewers = [];
export function registerTabViewer(viewer) {
  if (viewer && typeof viewer.match === 'function' && typeof viewer.render === 'function') viewers.push(viewer);
}
const viewerFor = (path) => viewers.find((v) => v.match(path));

/** Open a file in the workspace (a new tab, or the tab it already has). */
export async function openInEditor(server, path, onSaved) {
  const ws = workspaceFor(server);
  if (onSaved) ws.onSaved = onSaved;
  let tab = ws.tabs.find((t) => t.path === path);
  if (!tab) {
    try {
      tab = await loadTab(ws, path);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    ws.tabs.push(tab);
  }
  ws.panes[ws.focus] = path;
  if (ws.split && ws.panes[0] === ws.panes[1] && ws.tabs.length > 1) ws.panes[1 - ws.focus] = ws.tabs.find((t) => t.path !== path).path;
  show(ws);
}

/** After a reload of the files tab: offer to get back the tabs that were open, without opening them uninvited. */
export function offerReopen(server, host) {
  const ws = workspaces.get(server.id);
  if (ws?.tabs.length) return mountPill(ws);
  const saved = readSaved(server.id);
  if (!saved.tabs.length || !host?.isConnected || $('#ed-pill')) return;
  mountPill({ server, saved, tabs: saved.tabs.map((path) => ({ path })) });
}

function mountPill(ws) {
  $('#ed-pill')?.remove();
  const unsaved = ws.tabs.filter((t) => t.content !== undefined && dirty(t)).length;
  const pill = document.createElement('button');
  pill.id = 'ed-pill';
  pill.className = 'btn ed-pill';
  pill.innerHTML = `${icon('file', 13)} ${ws.saved ? 'Reopen' : 'Editor:'} ${ws.tabs.length} file${ws.tabs.length === 1 ? '' : 's'}${unsaved ? ` · ${unsaved} unsaved` : ''}`;
  pill.addEventListener('click', async () => {
    pill.remove();
    if (ws.saved) {
      const full = workspaceFor(ws.server);
      const results = await Promise.allSettled(ws.saved.tabs.map((p) => loadTab(full, p)));
      full.tabs = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const names = new Set(full.tabs.map((t) => t.path));
      full.panes = ws.saved.panes.map((p) => (names.has(p) ? p : null));
      if (!full.panes[0]) full.panes[0] = full.tabs[0]?.path || null;
      full.split = ws.saved.split && full.tabs.length > 1;
      full.opener = pill;
      if (!full.tabs.length) return toast('Those files are gone', 'warn');
      show(full);
    } else show(ws);
  });
  document.body.appendChild(pill);
}

/* ------------------------------------------------------------- the panel */

function show(ws) {
  $('#ed-pill')?.remove();
  if (!ws.root) {
    ws.opener = document.activeElement;
    ws.root = document.createElement('div');
    ws.root.className = 'ed-ws';
    ws.root.setAttribute('role', 'dialog');
    ws.root.setAttribute('aria-label', 'File editor');
    ws.root.addEventListener('click', (e) => onClick(ws, e));
    ws.root.addEventListener('input', (e) => onInput(ws, e));
    ws.root.addEventListener('keydown', (e) => onKey(ws, e));
    ws.root.addEventListener('focusin', (e) => {
      const pane = e.target.closest?.('[data-pane]');
      if (pane) ws.focus = Number(pane.dataset.pane);
    });
    document.body.appendChild(ws.root);
  }
  ws.root.classList.remove('hidden');
  draw(ws);
  const area = ws.root.querySelector(`[data-pane="${ws.focus}"] textarea`) || ws.root.querySelector('textarea');
  area?.focus();
}

function hide(ws) {
  ws.root?.classList.add('hidden');
  writeSaved(ws);
  mountPill(ws);
  if (ws.opener?.isConnected && ws.opener !== document.body) ws.opener.focus();
}

function drawTabs(ws) {
  return ws.tabs
    .map((t) => {
      const shown = ws.panes.includes(t.path);
      return `<span class="ed-tab-wrap ${ws.panes[ws.focus] === t.path ? 'active' : shown ? 'shown' : ''}">
        <button class="ed-tab" data-tab="${esc(t.path)}" title="${esc(t.path)}">${esc(baseName(t.path))}${dirty(t) ? '<span class="ed-dot" title="Unsaved changes">●</span>' : ''}</button>
        <button class="ed-x" data-close-tab="${esc(t.path)}" aria-label="Close ${esc(baseName(t.path))}" title="Close">×</button>
      </span>`;
    })
    .join('');
}

function draw(ws) {
  const panes = ws.split ? [0, 1] : [0];
  const unsaved = ws.tabs.filter(dirty).length;
  ws.root.innerHTML = `
    <div class="ed-bar">
      <div class="ed-tabs" data-kb-roving="x" role="tablist" aria-label="Open files">${drawTabs(ws)}</div>
      <div class="ed-tools">
        <span class="faint ed-count">${unsaved ? `${unsaved} unsaved` : ''}</span>
        <button class="btn btn-sm" data-ed="split" title="Show two files side by side">${ws.split ? 'One pane' : 'Split'}</button>
        <button class="btn btn-sm" data-ed="compare" title="Compare files or versions">Compare</button>
        <button class="btn btn-sm" data-ed="history" title="Earlier saved versions of this file">History</button>
        <button class="btn btn-sm" data-ed="save-all" ${unsaved ? '' : 'disabled'}>Save all</button>
        <button class="btn btn-sm btn-primary" data-ed="save" title="Ctrl+S">Save</button>
        <button class="btn btn-sm" data-ed="hide" title="Esc. Your tabs stay open">Hide</button>
        <button class="btn btn-sm btn-danger" data-ed="close-all">Close all</button>
      </div>
    </div>
    <div class="ed-panes ${ws.split ? 'split' : ''}">
      ${panes
        .map((i) => {
          const tab = ws.tabs.find((t) => t.path === ws.panes[i]);
          return `<section class="ed-pane ${ws.focus === i ? 'focus' : ''}" data-pane="${i}">
            <div class="ed-pane-head mono">${esc(tab?.path || 'No file')}</div>
            ${tab?.viewer ? '<div class="ed-viewer" data-viewer></div>' : tab ? `<textarea class="editor ed-area" spellcheck="false" aria-label="${esc(tab.path)}">${esc(tab.content)}</textarea>` : '<div class="faint" style="padding:16px">Pick a file from the tabs above.</div>'}
          </section>`;
        })
        .join('')}
    </div>
    <div class="ed-hint faint">Ctrl+S save · Alt+PageUp / PageDown change tab · Alt+W close tab · Esc hide (tabs stay open)</div>`;
  mountViewers(ws);
}

function mountViewers(ws) {
  ws.root.querySelectorAll('[data-viewer]').forEach((host) => {
    const tab = ws.tabs.find((t) => t.path === ws.panes[Number(host.closest('[data-pane]').dataset.pane)]);
    if (tab?.viewer) tab.viewer.render(host, { server: ws.server, path: tab.path });
  });
}

function refreshMarks(ws) {
  const tabs = ws.root.querySelector('.ed-tabs');
  if (tabs) tabs.innerHTML = drawTabs(ws);
  const unsaved = ws.tabs.filter(dirty).length;
  const count = ws.root.querySelector('.ed-count');
  if (count) count.textContent = unsaved ? `${unsaved} unsaved` : '';
  const all = ws.root.querySelector('[data-ed="save-all"]');
  if (all) all.disabled = !unsaved;
}

/* --------------------------------------------------------------- actions */

const activeTab = (ws) => ws.tabs.find((t) => t.path === ws.panes[ws.focus]);
const unsavedWarn = (e) => {
  if ([...workspaces.values()].some((w) => w.tabs.some(dirty))) {
    e.preventDefault();
    e.returnValue = '';
  }
};
window.addEventListener('beforeunload', unsavedWarn);

async function saveTab(ws, tab) {
  const problem = lintConfig(tab.path, tab.content);
  if (problem && !(await confirmModal(`${baseName(tab.path)} has a mistake`, `${problem} The server may refuse to load it, or reset it to defaults. Save anyway?`, 'Save anyway'))) return false;
  try {
    await api(`/api/servers/${encodeURIComponent(ws.server.id)}/files/content?path=${encodeURIComponent(tab.path)}`, { method: 'PUT', body: { content: tab.content } });
    tab.saved = tab.content;
    ws.onSaved?.();
    return true;
  } catch (err) {
    toast(`${baseName(tab.path)}: ${err.message}`, 'error');
    return false;
  }
}

async function saveOne(ws) {
  const tab = activeTab(ws);
  if (!tab) return;
  if (!dirty(tab)) return toast('Nothing to save');
  if (await saveTab(ws, tab)) {
    toast(`Saved ${baseName(tab.path)}`);
    refreshMarks(ws);
  }
}

async function saveAll(ws) {
  let n = 0;
  for (const tab of ws.tabs.filter(dirty)) if (await saveTab(ws, tab)) n++;
  if (n) toast(`Saved ${n} file${n === 1 ? '' : 's'}`);
  refreshMarks(ws);
}

/** Three-way question: save, discard, or keep editing. Resolves 'save' | 'discard' | 'cancel'. */
function askUnsaved(title, message) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      width: 480,
      body: `<p style="margin:0;line-height:1.6">${esc(message)}</p>`,
      actions: [
        { label: 'Keep editing', onClick: () => { m.close(); resolve('cancel'); } },
        { label: 'Discard changes', danger: true, onClick: () => { m.close(); resolve('discard'); } },
        { label: 'Save', primary: true, onClick: () => { m.close(); resolve('save'); } },
      ],
    });
  });
}

async function closeTab(ws, path) {
  const tab = ws.tabs.find((t) => t.path === path);
  if (!tab) return;
  if (dirty(tab)) {
    const answer = await askUnsaved('Unsaved changes', `${baseName(path)} has changes that are not saved.`);
    if (answer === 'cancel') return;
    if (answer === 'save' && !(await saveTab(ws, tab))) return;
  }
  const at = ws.tabs.indexOf(tab);
  ws.tabs.splice(at, 1);
  const fallback = ws.tabs[Math.min(at, ws.tabs.length - 1)]?.path || null;
  ws.panes = ws.panes.map((p, i) => (p === path ? (i === 0 ? fallback : ws.tabs.find((t) => t.path !== ws.panes[0])?.path || null) : p));
  if (ws.tabs.length < 2) ws.split = false;
  if (!ws.tabs.length) return closeWorkspace(ws);
  writeSaved(ws);
  draw(ws);
  (ws.root.querySelector('[data-pane="' + ws.focus + '"] textarea') || ws.root.querySelector('textarea'))?.focus();
}

async function closeAll(ws) {
  const unsaved = ws.tabs.filter(dirty);
  if (unsaved.length) {
    const answer = await askUnsaved('Unsaved changes', `${unsaved.length} file${unsaved.length === 1 ? ' has' : 's have'} changes that are not saved: ${unsaved.map((t) => baseName(t.path)).join(', ')}.`);
    if (answer === 'cancel') return;
    if (answer === 'save') {
      await saveAll(ws);
      if (ws.tabs.some(dirty)) return;
    }
  }
  ws.tabs = [];
  closeWorkspace(ws);
}

function closeWorkspace(ws) {
  ws.root?.remove();
  ws.root = null;
  ws.panes = [null, null];
  ws.split = false;
  writeSaved(ws);
  workspaces.delete(ws.server.id);
  if (ws.opener?.isConnected) ws.opener.focus();
}

function cycle(ws, delta) {
  if (ws.tabs.length < 2) return;
  const at = ws.tabs.findIndex((t) => t.path === ws.panes[ws.focus]);
  ws.panes[ws.focus] = ws.tabs[(at + delta + ws.tabs.length) % ws.tabs.length].path;
  draw(ws);
  ws.root.querySelector(`[data-pane="${ws.focus}"] textarea`)?.focus();
}

function onClick(ws, event) {
  const tabBtn = event.target.closest('[data-tab]');
  if (tabBtn) {
    ws.panes[ws.focus] = tabBtn.dataset.tab;
    if (ws.split && ws.panes[0] === ws.panes[1]) ws.panes[1 - ws.focus] = ws.tabs.find((t) => t.path !== tabBtn.dataset.tab)?.path || null;
    draw(ws);
    ws.root.querySelector(`[data-pane="${ws.focus}"] textarea`)?.focus();
    return;
  }
  const x = event.target.closest('[data-close-tab]');
  if (x) return closeTab(ws, x.dataset.closeTab);
  const action = event.target.closest('[data-ed]')?.dataset.ed;
  if (action === 'save') saveOne(ws);
  else if (action === 'save-all') saveAll(ws);
  else if (action === 'hide') hide(ws);
  else if (action === 'close-all') closeAll(ws);
  else if (action === 'split') {
    if (!ws.split && ws.tabs.length < 2) return toast('Open a second file first, then split', 'warn');
    ws.split = !ws.split;
    if (ws.split) ws.panes[1] = ws.panes[1] && ws.panes[1] !== ws.panes[0] ? ws.panes[1] : ws.tabs.find((t) => t.path !== ws.panes[0])?.path || null;
    ws.focus = 0;
    writeSaved(ws);
    draw(ws);
    ws.root.querySelector('textarea')?.focus();
  } else if (action === 'history') {
    const tab = activeTab(ws);
    if (!tab) return;
    openConfigHistory(ws.server, tab.path, async () => {
      try {
        const fresh = await loadTab(ws, tab.path);
        tab.content = tab.saved = fresh.content;
        draw(ws);
      } catch (err) {
        toast(err.message, 'error');
      }
      ws.onSaved?.();
    });
  } else if (action === 'compare') {
    const tab = activeTab(ws);
    const buffers = Object.fromEntries(ws.tabs.filter(dirty).map((t) => [t.path, t.content]));
    const other = ws.split ? ws.tabs.find((t) => t.path === ws.panes[1 - ws.focus]) : null;
    openCompare(ws.server, {
      left: tab ? { kind: dirty(tab) ? 'buffer' : 'file', path: tab.path } : undefined,
      right: other ? { kind: dirty(other) ? 'buffer' : 'file', path: other.path } : { kind: 'version', path: tab?.path || '' },
      buffers,
    });
  }
}

function onInput(ws, event) {
  const area = event.target.closest('textarea.ed-area');
  if (!area) return;
  const i = Number(area.closest('[data-pane]').dataset.pane);
  const tab = ws.tabs.find((t) => t.path === ws.panes[i]);
  if (!tab) return;
  tab.content = area.value;
  // The same file in both panes stays in step.
  if (ws.split && ws.panes[0] === ws.panes[1]) ws.root.querySelectorAll('textarea.ed-area').forEach((a) => a !== area && (a.value = tab.content));
  const wrap = ws.root.querySelector(`[data-tab="${CSS.escape(tab.path)}"]`);
  if (wrap) {
    const has = wrap.querySelector('.ed-dot');
    if (dirty(tab) && !has) wrap.insertAdjacentHTML('beforeend', '<span class="ed-dot" title="Unsaved changes">●</span>');
    else if (!dirty(tab) && has) has.remove();
  }
  const unsaved = ws.tabs.filter(dirty).length;
  ws.root.querySelector('.ed-count').textContent = unsaved ? `${unsaved} unsaved` : '';
  ws.root.querySelector('[data-ed="save-all"]').disabled = !unsaved;
}

function onKey(ws, event) {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveOne(ws);
  } else if (mod && event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveAll(ws);
  } else if (event.altKey && event.key === 'PageDown') {
    event.preventDefault();
    cycle(ws, 1);
  } else if (event.altKey && event.key === 'PageUp') {
    event.preventDefault();
    cycle(ws, -1);
  } else if (event.altKey && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    const tab = activeTab(ws);
    if (tab) closeTab(ws, tab.path);
  } else if (event.key === 'Escape' && !document.querySelector('#modal-root .modal-backdrop')) {
    event.preventDefault();
    hide(ws);
  }
}
