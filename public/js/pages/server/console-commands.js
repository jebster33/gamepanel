import { api } from '../../core/api.js';
import { state } from '../../core/state.js';
import { $, can, esc, toast } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';

/* Quick command buttons, macros and autocomplete for the console. */

/** Parse "kick <player> [reason]" / "weather clear|rain" into tokens. */
function parsePattern(line) {
  return line.split(/\s+/).map((raw) => {
    if (raw === '<player>') return { kind: 'player', raw };
    if (/^[^<[]+$/.test(raw) && raw.includes('|')) return { kind: 'choice', options: raw.split('|'), raw };
    if (/^[<[]/.test(raw)) return { kind: 'hint', raw };
    return { kind: 'word', options: [raw], raw };
  });
}

const accepts = (token, word) => {
  if (!token) return false;
  if (token.kind === 'word' || token.kind === 'choice') return token.options.some((o) => o.toLowerCase() === word.toLowerCase());
  return true;
};

/** Suggestions for the word being typed, plus signature hints for what fits so far. */
export function suggestFor(patterns, text, playerNames = []) {
  const words = text.split(/\s+/);
  const idx = words.length - 1;
  const current = words[idx].toLowerCase();
  const options = new Set();
  const hints = [];
  for (const tokens of patterns) {
    if (idx > 0 && !tokens.slice(0, idx).every((t, i) => accepts(t, words[i]))) continue;
    if (idx >= tokens.length) continue;
    const token = tokens[idx];
    if (token.kind === 'word' || token.kind === 'choice') for (const o of token.options) options.add(o);
    else if (token.kind === 'player') for (const n of playerNames) options.add(n);
    if (idx > 0 || current) hints.push(tokens.map((t) => t.raw).join(' '));
  }
  const matches = [...options].filter((o) => o.toLowerCase().startsWith(current) && o.toLowerCase() !== current).slice(0, 8);
  return { matches, hints: [...new Set(hints)].slice(0, 3) };
}

export async function setupCommandTools(host, server, input, form, history) {
  const bar = document.createElement('div');
  bar.className = 'quick-bar';
  form.before(bar);
  const box = document.createElement('div');
  box.className = 'suggest-box hidden';
  form.before(box);

  let data = { quick: [], suggest: [], macros: [], canSay: false };
  try {
    data = await api(`/api/servers/${server.id}/commands`);
  } catch {
    return;
  }
  if (!$('#console')) return;
  const patterns = data.suggest.map(parsePattern);
  const canRun = can('command');

  const run = async (body) => {
    try {
      await api(`/api/servers/${server.id}/quick-command`, { method: 'POST', body });
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const drawBar = () => {
    bar.innerHTML =
      data.quick.map((x) => `<button class="chip chip-sm" data-quick="${esc(x.id)}" ${canRun ? '' : 'disabled'}>${esc(x.label)}</button>`).join('') +
      (data.macros.length ? '<span class="quick-sep"></span>' : '') +
      data.macros.map((m) => `<button class="chip chip-sm macro" data-macro="${esc(m.id)}" title="${esc(m.commands.join('\n'))}" ${canRun ? '' : 'disabled'}>${esc(m.name)}</button>`).join('') +
      (canRun ? '<button class="chip chip-sm" data-edit-macros>＋ Macros</button>' : '');
  };
  drawBar();

  bar.addEventListener('click', async (event) => {
    if (event.target.closest('[data-edit-macros]')) return editMacros(server, data, drawBar);
    const macroBtn = event.target.closest('[data-macro]');
    if (macroBtn) {
      const macro = data.macros.find((m) => m.id === macroBtn.dataset.macro);
      if (macro && macro.commands.length > 1 && !(await confirmModal(macro.name, `Send ${macro.commands.length} commands:\n${macro.commands.join('\n')}`, 'Run'))) return;
      return run({ macro: macroBtn.dataset.macro });
    }
    const btn = event.target.closest('[data-quick]');
    if (!btn) return;
    const item = data.quick.find((x) => x.id === btn.dataset.quick);
    if (!item) return;
    if (item.danger && !(await confirmModal(item.label, `This sends “${item.command}” to the server.`, 'Send'))) return;
    if (!item.args.length) return run({ quick: item.id });
    askArgs(server, item, (values) => run({ quick: item.id, values }));
  });

  // Autocomplete: Tab takes the first suggestion, ↑/↓ pick while the list is open.
  let shown = [];
  let pick = 0;
  const close = () => {
    shown = [];
    box.classList.add('hidden');
  };
  const players = () => state.servers.find((s) => s.id === server.id)?.playerList || [];
  const render = () => {
    const text = input.value;
    if (!text.trim()) return close();
    const { matches, hints } = suggestFor(patterns, text, players());
    shown = matches;
    pick = 0;
    if (!matches.length && !hints.length) return close();
    box.classList.remove('hidden');
    box.innerHTML =
      matches.map((m, i) => `<button type="button" class="suggest-item ${i === pick ? 'on' : ''}" data-i="${i}">${esc(m)}</button>`).join('') +
      hints.map((h) => `<div class="suggest-hint">${esc(h)}</div>`).join('');
  };
  const accept = (value) => {
    const words = input.value.split(/\s+/);
    words[words.length - 1] = value;
    input.value = `${words.join(' ')} `;
    input.focus();
    render();
  };
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(close, 150));
  box.addEventListener('mousedown', (event) => {
    const el = event.target.closest('[data-i]');
    if (!el) return;
    event.preventDefault();
    accept(shown[Number(el.dataset.i)]);
  });
  // Capture phase so these run before the console's own history / Tab handler.
  input.addEventListener(
    'keydown',
    (event) => {
      if (!shown.length) return;
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        accept(shown[pick]);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        pick = (pick + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
        box.querySelectorAll('.suggest-item').forEach((el, i) => el.classList.toggle('on', i === pick));
      } else if (event.key === 'Escape') {
        close();
      }
    },
    true
  );
  form.addEventListener('submit', close);
}

function askArgs(server, item, done) {
  const names = state.servers.find((s) => s.id === server.id)?.playerList || [];
  const field = (a) => {
    if (a.type === 'choice') return `<select id="qa-${a.name}">${a.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
    if (a.type === 'player') return `<input id="qa-${a.name}" list="qa-players" autocomplete="off" placeholder="Player name" />`;
    return `<input id="qa-${a.name}" ${a.type === 'number' ? 'inputmode="decimal"' : ''} autocomplete="off" />`;
  };
  const modal = openModal({
    title: esc(item.label),
    width: 420,
    body: `<datalist id="qa-players">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      ${item.args.map((a) => `<label class="field"><span>${esc(a.label)}</span>${field(a)}</label>`).join('')}`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Send',
        primary: true,
        onClick: () => {
          const values = Object.fromEntries(item.args.map((a) => [a.name, document.getElementById(`qa-${a.name}`)?.value || '']));
          modal.close();
          done(values);
        },
      },
    ],
  });
  document.getElementById(`qa-${item.args[0].name}`)?.addEventListener('keydown', (e) => e.key === 'Enter' && document.querySelector('.modal-foot .btn-primary')?.click());
}

function editMacros(server, data, redraw) {
  const rows = () =>
    data.macros
      .map(
        (m, i) => `<div class="macro-row" data-i="${i}">
          <input class="macro-name" value="${esc(m.name)}" placeholder="Name" maxlength="40" />
          <textarea class="macro-lines mono" rows="3" placeholder="One console command per line${data.canSay ? '. “@say hello” posts to chat' : ''}">${esc(m.commands.join('\n'))}</textarea>
          <button class="btn btn-sm btn-ghost" data-del="${i}">Remove</button>
        </div>`
      )
      .join('') || '<p class="faint">No macros yet. A macro sends one or more console commands with a click.</p>';
  const modal = openModal({
    title: 'Console macros',
    width: 640,
    body: `<div id="macro-list">${rows()}</div><button class="btn btn-sm" id="macro-add" style="margin-top:8px">Add macro</button>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          sync();
          try {
            const res = await api(`/api/servers/${server.id}/macros`, { method: 'PUT', body: { macros: data.macros.filter((m) => m.name.trim() || m.commands.length) } });
            data.macros = res.macros;
            redraw();
            modal.close();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
    ],
  });
  const list = document.getElementById('macro-list');
  const sync = () => {
    list.querySelectorAll('.macro-row').forEach((row) => {
      const m = data.macros[Number(row.dataset.i)];
      if (!m) return;
      m.name = row.querySelector('.macro-name').value.trim();
      m.commands = row.querySelector('.macro-lines').value.split('\n').map((l) => l.trim()).filter(Boolean);
    });
  };
  const paint = () => (list.innerHTML = rows());
  document.getElementById('macro-add').addEventListener('click', () => {
    sync();
    data.macros.push({ name: '', commands: [] });
    paint();
  });
  list.addEventListener('click', (event) => {
    const del = event.target.closest('[data-del]');
    if (!del) return;
    sync();
    data.macros.splice(Number(del.dataset.del), 1);
    paint();
  });
}
