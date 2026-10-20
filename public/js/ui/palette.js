import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { $, can, esc, toast } from '../core/util.js';
import { prefs, rememberRecent } from './ux-prefs.js';

/* ------------------------------------------------- command palette (Ctrl+K) */

/**
 * Fuzzy score: every word of the query must appear in the text as a
 * subsequence. Higher is better; -1 means no match. Substrings and word
 * starts rank above scattered letters.
 */
export function fuzzyScore(query, text) {
  const hay = String(text).toLowerCase();
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let total = 0;
  for (const word of words) {
    const at = hay.indexOf(word);
    if (at >= 0) {
      total += 100 + (at === 0 || /[\s\-_/:]/.test(hay[at - 1]) ? 40 : 0) - Math.min(at, 30);
      continue;
    }
    let pos = -1;
    let score = 0;
    let run = 0;
    for (const ch of word) {
      const next = hay.indexOf(ch, pos + 1);
      if (next < 0) return -1;
      run = next === pos + 1 ? run + 1 : 0;
      score += 5 + run * 4 + (next === 0 || /[\s\-_/:]/.test(hay[next - 1]) ? 6 : 0);
      pos = next;
    }
    total += score - Math.min(pos, 30);
  }
  return total - Math.min(hay.length, 60) / 10;
}

const PAGES = [
  { id: 'dashboard', label: 'Dashboard', hash: '#/dashboard' },
  { id: 'servers', label: 'Servers', hash: '#/servers' },
  { id: 'templates', label: 'Templates and new server', hash: '#/templates', needs: ['templates', 'deploy'] },
  { id: 'activity', label: 'Activity', hash: '#/activity', needs: ['activity'] },
  { id: 'audit', label: 'Audit log', hash: '#/audit', admin: true },
  { id: 'bans', label: 'Bans', hash: '#/bans', admin: true },
  { id: 'nodes', label: 'Nodes', hash: '#/nodes', admin: true },
  { id: 'networks', label: 'Networks', hash: '#/networks', admin: true },
  { id: 'clusters', label: 'Clusters', hash: '#/clusters', admin: true },
  { id: 'users', label: 'Users', hash: '#/users', admin: true },
  { id: 'connections', label: 'Connections', hash: '#/connections', admin: true, bridge: true },
  { id: 'settings', label: 'Settings', hash: '#/settings', admin: true },
  { id: 'account', label: 'Account and security', hash: '#/account' },
];

const SETTINGS = [
  ['notifications', 'Alerts'],
  ['bridge', 'GamePanel Bridge'],
  ['updates', 'Panel updates'],
  ['https', 'HTTPS'],
  ['sftp', 'SFTP'],
  ['backup-checks', 'Backup checks'],
  ['backups', 'Backup encryption'],
  ['events', 'Scheduled events'],
  ['limits', 'Limits'],
  ['discord-bot', 'Discord bot'],
  ['integrations', 'Integrations'],
  ['cloud', 'Cloud backups'],
  ['node-copies', 'Backup copies on another node'],
  ['oauth', 'Sign in with Google, Discord or GitHub'],
  ['status-page', 'Public server list'],
];

const go = (hash) => () => (location.hash = hash);

/** Everything the signed-in account may open or do, built fresh each time the palette opens. */
export function buildItems() {
  const admin = state.user?.role === 'admin';
  const items = [];
  for (const p of PAGES) {
    if (p.admin && !admin) continue;
    if (p.bridge && !state.bridgeEnabled) continue;
    if (p.needs && !p.needs.some((c) => can(c))) continue;
    items.push({ id: `page:${p.id}`, kind: 'page', label: p.label, sub: 'Page', run: go(p.hash) });
  }
  if (admin) for (const [id, label] of SETTINGS) items.push({ id: `setting:${id}`, kind: 'setting', label: `Settings: ${label}`, sub: 'Setting', run: go(`#/settings/${id}`) });
  for (const tpl of state.templates || []) {
    if (!(admin || (can('deploy') && !tpl.adminOnly))) continue;
    items.push({
      id: `template:${tpl.id}`,
      kind: 'template',
      label: `New server: ${tpl.name}`,
      sub: 'Template',
      run: async () => {
        location.hash = '#/templates';
        const { openCreateServerModal } = await import('../pages/deploy.js');
        openCreateServerModal(tpl.id);
      },
    });
  }
  for (const s of state.servers) {
    items.push({ id: `server:${s.id}`, kind: 'server', label: s.name, sub: `Server · ${s.templateName || ''}`, status: s.status, run: go(`#/servers/${s.id}`) });
    items.push(...serverActions(s));
  }
  return items;
}

function serverActions(s) {
  const out = [];
  const on = ['running', 'starting'].includes(s.status);
  const power = (action) => async () => {
    if (action !== 'start') {
      const { confirmModal } = await import('./modal.js');
      if (!(await confirmModal(`${action === 'stop' ? 'Stop' : 'Restart'} ${s.name}`, 'Players on it will be disconnected.', action === 'stop' ? 'Stop' : 'Restart'))) return;
    }
    try {
      await api(`/api/servers/${s.id}/power`, { method: 'POST', body: { action } });
      toast(`${action[0].toUpperCase() + action.slice(1)} requested for ${s.name}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  if (can('power', s.id)) {
    if (!on && s.installedAt && !['installing', 'stopping'].includes(s.status)) out.push({ id: `action:start:${s.id}`, kind: 'action', label: `Start ${s.name}`, sub: 'Action', run: power('start') });
    if (on) {
      out.push({ id: `action:restart:${s.id}`, kind: 'action', label: `Restart ${s.name}`, sub: 'Action', run: power('restart') });
      out.push({ id: `action:stop:${s.id}`, kind: 'action', label: `Stop ${s.name}`, sub: 'Action', run: power('stop') });
    }
  }
  if (can('console', s.id)) out.push({ id: `action:console:${s.id}`, kind: 'action', label: `Open console of ${s.name}`, sub: 'Action', run: go(`#/servers/${s.id}/console`) });
  if (can('backups', s.id) && s.installedAt && s.status !== 'installing') {
    out.push({
      id: `action:backup:${s.id}`,
      kind: 'action',
      label: `Back up ${s.name} now`,
      sub: 'Action',
      run: async () => {
        try {
          await api(`/api/servers/${s.id}/backups`, { method: 'POST', body: {} });
          toast(`Backup of ${s.name} started`);
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    });
  }
  return out;
}

/** Ranked results for a query; with no query, recent picks first and then pages and servers. */
export function rank(items, query) {
  if (!query.trim()) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const recent = prefs()
      .recent.map((r) => byId.get(`${r.kind}:${r.key}`))
      .filter(Boolean)
      .map((i) => ({ ...i, recent: true }));
    const seen = new Set(recent.map((i) => i.id));
    return [...recent, ...items.filter((i) => !seen.has(i.id) && (i.kind === 'page' || i.kind === 'server'))].slice(0, 30);
  }
  return items
    .map((item) => ({ item, score: fuzzyScore(query, item.label) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((r) => r.item);
}

/* ---------------------------------------------------------------- the UI */

let items = [];
let shown = [];
let active = 0;
let opener = null;
let playerTimer = null;
let playerSeq = 0;
let players = [];

const root = () => $('#palette-root');
const isOpen = () => root() && !root().classList.contains('hidden');

export function openPalette() {
  if (!state.user || !root()) return;
  opener = document.activeElement;
  items = buildItems();
  players = [];
  root().classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  update();
  input.focus();
}

export function closePalette() {
  if (!isOpen()) return;
  root().classList.add('hidden');
  clearTimeout(playerTimer);
  playerSeq++;
  if (opener?.isConnected) opener.focus();
  opener = null;
}

function update(keepActive = false) {
  shown = [...rank(items, $('#palette-input').value), ...players];
  active = keepActive ? Math.min(active, Math.max(shown.length - 1, 0)) : 0;
  draw();
}

function draw() {
  const list = $('#palette-list');
  list.innerHTML = shown.length
    ? shown
        .map(
          (it, i) => `<li id="palette-opt-${i}" role="option" aria-selected="${i === active}" class="palette-item ${i === active ? 'active' : ''}" data-i="${i}">
            <span class="palette-label">${it.status ? `<span class="status ${esc(it.status)}" style="padding:0;background:none"><i class="dot"></i></span>` : ''}${esc(it.label)}</span>
            <span class="palette-sub">${it.recent ? 'Recent · ' : ''}${esc(it.sub || '')}</span></li>`
        )
        .join('')
    : '<li class="palette-empty" role="presentation">Nothing matches</li>';
  $('#palette-input').setAttribute('aria-activedescendant', shown.length ? `palette-opt-${active}` : '');
  $('#palette-status').textContent = shown.length ? `${shown.length} result${shown.length === 1 ? '' : 's'}` : 'No results';
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function searchPlayers(q) {
  clearTimeout(playerTimer);
  const seq = ++playerSeq;
  if (q.trim().length < 2 || !can('console')) {
    if (players.length) {
      players = [];
      update(true);
    }
    return;
  }
  playerTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/players/search?q=${encodeURIComponent(q.trim())}`);
      if (seq !== playerSeq || !isOpen()) return;
      players = (data.players || []).slice(0, 8).map((p) => {
        const server = state.servers.find((s) => s.id === p.serverId);
        return { id: `player:${p.name}:${p.serverId}`, kind: 'player', label: `Player ${p.name}`, sub: `${p.online ? 'Online' : 'Seen'} on ${server?.name || 'a server'}`, run: go(`#/servers/${p.serverId}/players`) };
      });
      update(true);
    } catch {
      /* no player results */
    }
  }, 250);
}

function choose(i) {
  const it = shown[i];
  if (!it) return;
  closePalette();
  const [kind, ...rest] = it.id.split(':');
  // Players and actions are remembered by their full id, other kinds by the part after the kind.
  rememberRecent(kind, rest.join(':'), it.label);
  it.run();
}

export function initPalette() {
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (isOpen()) closePalette();
      else openPalette();
    }
  });
  $('#palette-btn')?.addEventListener('click', openPalette);
  const input = $('#palette-input');
  if (!input) return;
  input.addEventListener('input', () => {
    update();
    searchPlayers(input.value);
  });
  input.addEventListener('keydown', (event) => {
    const move = (n) => {
      event.preventDefault();
      if (!shown.length) return;
      active = (n + shown.length) % shown.length;
      draw();
    };
    if (event.key === 'ArrowDown') move(active + 1);
    else if (event.key === 'ArrowUp') move(active - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(shown.length - 1);
    else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    } else if (event.key === 'Tab') event.preventDefault();
  });
  $('#palette-list').addEventListener('click', (event) => {
    const li = event.target.closest('[data-i]');
    if (li) choose(Number(li.dataset.i));
  });
  $('#palette-list').addEventListener('mousemove', (event) => {
    const li = event.target.closest('[data-i]');
    if (li && Number(li.dataset.i) !== active) {
      active = Number(li.dataset.i);
      draw();
    }
  });
  root().addEventListener('mousedown', (event) => {
    if (event.target === root()) closePalette();
  });
}
