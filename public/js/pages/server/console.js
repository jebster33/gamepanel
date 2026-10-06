import { api } from '../../core/api.js';
import { wsSubscribe } from '../../core/live.js';
import { state } from '../../core/state.js';
import { $, can, esc, toast } from '../../core/util.js';
import { copyToClipboard } from '../../ui/clipboard.js';
import { confirmModal, openModal } from '../../ui/modal.js';

/* -------------------------------------------------------------- console */

export function renderConsoleTab(host, server) {
  host.innerHTML = `
    <div id="doctor"></div>
    <div class="console-tools">
      <input class="search-input console-find" id="console-find" placeholder="Filter lines (e.g. error, a player's name)" />
      <button class="btn btn-sm btn-ghost" id="old-logs" title="Search the game's saved log files from earlier days">Old logs</button>
      <button class="btn btn-sm btn-ghost" id="share-log" title="Upload the console to mclo.gs so someone can help">Share log</button>
    </div>
    <div class="console-wrap">
      <div class="console" id="console"></div>
      <form class="console-form" id="console-form">
        <input id="console-input" placeholder="Type a command and press Enter. ↑ for history, Tab to complete" autocomplete="off" spellcheck="false" />
        <button class="btn" type="submit">Send</button>
      </form>
    </div>`;

  const buffered = state.consoles.get(server.id) || [];
  appendConsoleLines(buffered, true);
  wsSubscribe(`console:${server.id}`);

  api(`/api/servers/${server.id}/console`)
    .then((data) => {
      state.consoles.set(server.id, data.lines);
      const el = $('#console');
      if (el) {
        el.innerHTML = '';
        appendConsoleLines(data.lines, true);
      }
    })
    .catch(() => {});

  consoleFilter = '';
  $('#console-find').addEventListener('input', (event) => {
    consoleFilter = event.target.value.trim().toLowerCase();
    const el = $('#console');
    [...el.children].forEach(applyFilter);
    el.classList.toggle('filtered', Boolean(consoleFilter));
    el.scrollTop = el.scrollHeight;
  });

  patchDoctor(server);
  $('#doctor').addEventListener('click', (event) => onDoctorClick(event, server));
  $('#share-log').addEventListener('click', () => shareLog(server));
  $('#old-logs').addEventListener('click', () => openOldLogs(server));

  const history = loadHistory(server.id);
  let cursor = history.length;
  $('#console-input').addEventListener('keydown', (event) => {
    const input = event.currentTarget;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (!history.length) return;
      event.preventDefault();
      cursor = Math.max(0, Math.min(history.length, cursor + (event.key === 'ArrowUp' ? -1 : 1)));
      input.value = history[cursor] || '';
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (event.key === 'Tab' && input.value) {
      // Finish the last word: an online player's name, or a common command.
      const live = state.servers.find((s) => s.id === server.id);
      const words = input.value.split(' ');
      const last = words.at(-1).toLowerCase();
      if (!last) return;
      const pool = words.length === 1 ? [...new Set([...history.map((h) => h.split(' ')[0]), ...COMMON])] : live?.playerList || [];
      const match = pool.find((w) => w.toLowerCase().startsWith(last) && w.toLowerCase() !== last);
      if (!match) return;
      event.preventDefault();
      words[words.length - 1] = match;
      input.value = `${words.join(' ')}${words.length === 1 ? ' ' : ''}`;
    }
  });

  $('#console-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#console-input');
    const command = input.value.trim();
    if (!command) return;
    input.value = '';
    if (history.at(-1) !== command) history.push(command);
    if (history.length > 100) history.splice(0, history.length - 100);
    cursor = history.length;
    saveHistory(server.id, history);
    try {
      await api(`/api/servers/${server.id}/command`, { method: 'POST', body: { command } });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// Tab-completed when the line has a single word.
const COMMON = ['say', 'list', 'whitelist', 'op', 'deop', 'kick', 'ban', 'pardon', 'tp', 'give', 'gamemode', 'time', 'weather', 'difficulty', 'save-all', 'stop', 'help'];

function loadHistory(id) {
  try {
    return JSON.parse(localStorage.getItem(`gp-cmd-${id}`) || '[]').slice(-100);
  } catch {
    return [];
  }
}

function saveHistory(id, list) {
  try {
    localStorage.setItem(`gp-cmd-${id}`, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

export function handleConsoleMessage(msg) {
  const id = msg.serverId || msg.topic.slice(8);
  if (msg.type === 'clear') {
    state.consoles.set(id, []);
    if (state.route.params.id === id) {
      const el = $('#console');
      if (el) el.innerHTML = '';
    }
    return;
  }
  const buffer = state.consoles.get(id) || [];
  buffer.push(...(msg.lines || []));
  if (buffer.length > 600) buffer.splice(0, buffer.length - 600);
  state.consoles.set(id, buffer);

  if (state.route.name === 'server' && state.route.params.id === id && (state.route.params.tab || 'console') === 'console') {
    appendConsoleLines(msg.lines || []);
  }
}

/**
 * Light syntax colouring for console output: the timestamp/thread prefix is
 * dimmed so the message itself reads first, and the severity decides the tone.
 */
function consoleLineHtml(entry) {
  const raw = String(entry.line ?? '');
  let tone = entry.stream === 'stderr' ? 'err' : entry.stream;

  if (entry.stream === 'stdout') {
    if (/\b(error|severe|fatal|exception|failed|traceback)\b/i.test(raw)) tone = 'err';
    else if (/\b(warn(ing)?|deprecated)\b/i.test(raw)) tone = 'warn';
    else tone = 'out';
  }

  // Split a leading "[12:34:56] [Server thread/INFO]:" style prefix.
  const match = raw.match(/^((?:\[[^\]]*\]\s*)+:?\s*)(.*)$/s);
  const body = match ? match[2] : raw;
  const prefix = match ? match[1] : '';

  return `<div class="l ${esc(tone)}">${prefix ? `<span class="ts">${esc(prefix)}</span>` : ''}${esc(body)}</div>`;
}

let consoleFilter = '';
const applyFilter = (line) => line.classList.toggle('hidden', Boolean(consoleFilter) && !line.textContent.toLowerCase().includes(consoleFilter));

export function appendConsoleLines(lines, replace = false) {
  const el = $('#console');
  if (lines.length) {
    const lastSeq = lines[lines.length - 1].seq;
    if (state.route.params.id) state.consoleSeq.set(state.route.params.id, lastSeq);
  }
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const html = lines.map(consoleLineHtml).join('');
  const before = el.childElementCount;
  el.insertAdjacentHTML('beforeend', html);
  if (consoleFilter) [...el.children].slice(before).forEach(applyFilter);
  while (el.childElementCount > 600) el.firstElementChild.remove();
  if (atBottom || replace) el.scrollTop = el.scrollHeight;
}

/* --------------------------------------------------------- crash doctor */

// Fixes that are just "go to the right place".
const NAVIGATE = { settings: 'settings', mods: 'mods', files: 'files', backups: 'backups' };

export function patchDoctor(server) {
  const box = document.getElementById('doctor');
  if (!box) return;
  const findings = server.diagnosis?.findings || [];
  const key = JSON.stringify(findings.map((f) => f.id));
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = findings.length
    ? `<div class="card doctor-card mb-16">
        <div class="doctor-head"><span class="doctor-badge">Crash doctor</span><span class="faint">Why ${esc(server.name)} stopped</span>
          <button class="icon-btn" data-doctor-close aria-label="Dismiss">✕</button></div>
        ${findings
          .map(
            (f, i) => `<div class="doctor-item">
              <div class="doctor-title">${esc(f.title)}</div>
              <div class="doctor-detail">${esc(f.detail).replace(/\n/g, '<br>')}</div>
              ${f.fix ? `<button class="btn btn-sm ${i === 0 ? 'btn-primary' : ''}" data-fix="${i}">${esc(f.fix.label)}</button>` : ''}
            </div>`
          )
          .join('')}
      </div>`
    : '';
}

async function onDoctorClick(event, server) {
  if (event.target.closest('[data-doctor-close]')) {
    document.getElementById('doctor').innerHTML = '';
    return;
  }
  const btn = event.target.closest('[data-fix]');
  if (!btn) return;
  const live = state.servers.find((s) => s.id === server.id) || server;
  const fix = live.diagnosis?.findings?.[Number(btn.dataset.fix)]?.fix;
  if (!fix) return;
  if (NAVIGATE[fix.action]) {
    location.hash = `#/servers/${server.id}/${NAVIGATE[fix.action]}`;
    return;
  }
  if (fix.action === 'share') return shareLog(server);
  if (fix.action === 'eula' && !(await confirmModal('Accept the Minecraft EULA', 'By accepting you agree to the Minecraft End User License Agreement (aka.ms/MinecraftEULA).', 'Accept'))) return;
  btn.disabled = true;
  try {
    const result = await api(`/api/servers/${server.id}/diagnose/fix`, { method: 'POST', body: fix });
    toast(`${result.message}. ${['java', 'reinstall'].includes(fix.action) ? 'Start it again once the install finishes.' : 'Start the server again.'}`, 'info', 7000);
    document.getElementById('doctor').innerHTML = '';
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

async function shareLog(server) {
  if (!can('console')) return;
  if (!(await confirmModal('Share the console log', 'The console is uploaded to mclo.gs, where anyone with the link can read it. mclo.gs hides IP addresses and the panel hides passwords from the server settings.', 'Upload'))) return;
  try {
    const { url } = await api(`/api/servers/${server.id}/share-log`, { method: 'POST' });
    openModal({
      title: 'Log shared',
      width: 460,
      body: `<p class="faint" style="margin-top:0">Send this link to whoever is helping you.</p>
        <div class="input-row"><input class="mono" readonly value="${esc(url)}" /><button class="btn btn-primary" data-copy-url>Copy</button></div>
        <p style="margin-bottom:0"><a href="${esc(url)}" target="_blank" rel="noopener">Open it</a></p>`,
    });
    document.querySelector('[data-copy-url]')?.addEventListener('click', () => copyToClipboard(url));
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Search logs/latest.log and the gzipped days before it. */
function openOldLogs(server) {
  openModal({
    title: 'Old logs',
    width: 900,
    body: `<div class="input-row">
        <input class="search-input" id="ol-q" style="flex:1;min-width:0;max-width:none;width:auto" placeholder="Search every log (a player, an error, a command)" />
        <select id="ol-file" style="flex:0 0 190px;width:190px"><option value="">All files</option></select>
        <button class="btn btn-primary" id="ol-go">Search</button>
      </div>
      <p class="faint" id="ol-note" style="margin:8px 0">Pick a file to read its last lines, or search all of them.</p>
      <div class="console old-logs" id="ol-out"></div>`,
  });
  const out = document.getElementById('ol-out');
  const note = document.getElementById('ol-note');
  const select = document.getElementById('ol-file');
  const run = async () => {
    const q = document.getElementById('ol-q').value.trim();
    const file = select.value;
    if (!q && !file) return;
    note.textContent = 'Searching…';
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (file) params.set('file', file);
      const data = await api(`/api/servers/${server.id}/logs?${params}`);
      const many = !file;
      out.innerHTML = data.matches
        .map((m) => `<div class="line">${many ? `<span class="faint">${esc(m.file)}:${m.line}</span> ` : ''}${esc(m.text)}</div>`)
        .join('');
      note.textContent = data.matches.length
        ? `${data.matches.length}${data.truncated ? '+' : ''} line${data.matches.length === 1 ? '' : 's'}${data.truncated ? ' (stopped early, narrow the search)' : ''}`
        : 'Nothing found.';
      if (file && !q) out.scrollTop = out.scrollHeight;
    } catch (err) {
      note.textContent = err.message;
    }
  };
  api(`/api/servers/${server.id}/logs`)
    .then(({ files }) => {
      select.insertAdjacentHTML('beforeend', files.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join(''));
      if (!files.length) note.textContent = 'This server has no saved log files yet.';
    })
    .catch(() => {});
  document.getElementById('ol-go').addEventListener('click', run);
  document.getElementById('ol-q').addEventListener('keydown', (e) => e.key === 'Enter' && run());
  select.addEventListener('change', run);
}
