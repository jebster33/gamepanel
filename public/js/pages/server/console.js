import { api } from '../../core/api.js';
import { wsSubscribe } from '../../core/live.js';
import { state } from '../../core/state.js';
import { $, esc, toast } from '../../core/util.js';

/* -------------------------------------------------------------- console */

export function renderConsoleTab(host, server) {
  host.innerHTML = `
    <div class="console-wrap">
      <div class="console" id="console"></div>
      <form class="console-form" id="console-form">
        <input id="console-input" placeholder="Type a command and press Enter…" autocomplete="off" spellcheck="false" />
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

  $('#console-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#console-input');
    const command = input.value.trim();
    if (!command) return;
    input.value = '';
    try {
      await api(`/api/servers/${server.id}/command`, { method: 'POST', body: { command } });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
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

export function appendConsoleLines(lines, replace = false) {
  const el = $('#console');
  if (lines.length) {
    const lastSeq = lines[lines.length - 1].seq;
    if (state.route.params.id) state.consoleSeq.set(state.route.params.id, lastSeq);
  }
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const html = lines.map(consoleLineHtml).join('');
  el.insertAdjacentHTML('beforeend', html);
  while (el.childElementCount > 600) el.firstElementChild.remove();
  if (atBottom || replace) el.scrollTop = el.scrollHeight;
}
