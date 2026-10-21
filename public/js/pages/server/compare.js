import { api } from '../../core/api.js';
import { $, esc, fmtTime, toast } from '../../core/util.js';
import { changeStarts, diffStats, lineDiff, renderSideBySide, sideBySide } from '../../ui/diff.js';
import { openModal } from '../../ui/modal.js';

/* --------------------------------------------------------------- compare */

// Pick any two files, or a file and one of its earlier saved versions (the
// config history), and see them next to each other with the changes lit up.

const sid = (server) => encodeURIComponent(server.id);

async function readFile(server, path) {
  const data = await api(`/api/servers/${sid(server)}/files/content?path=${encodeURIComponent(path)}`);
  return data.content ?? '';
}

async function readVersion(server, path, version) {
  const data = await api(`/api/servers/${sid(server)}/config-history/version?path=${encodeURIComponent(path)}&version=${encodeURIComponent(version)}`);
  return data.content ?? '';
}

/**
 * @param server  the server
 * @param opts.left, opts.right  { kind: 'file' | 'version' | 'buffer', path, version? } to start with
 * @param opts.buffers  { path: text } for files open in the editor, so unsaved edits can be compared
 */
export function openCompare(server, { left, right, buffers = {} } = {}) {
  const sides = [left || { kind: 'file', path: '' }, right || { kind: 'file', path: '' }];
  const bufferPaths = Object.keys(buffers);
  const versionCache = new Map();

  const sideHtml = (i) => `
    <fieldset class="cmp-side" data-side="${i}">
      <legend>${i ? 'Right' : 'Left'}</legend>
      <label><span>What to compare</span>
        <select data-k="kind">
          <option value="file">The file as it is on disk</option>
          <option value="version">An earlier saved version of a file</option>
          ${bufferPaths.length ? '<option value="buffer">An open file with unsaved edits</option>' : ''}
        </select>
      </label>
      <label><span>File path</span><input data-k="path" class="mono" list="cmp-paths" placeholder="e.g. server.properties" spellcheck="false" autocomplete="off" /></label>
      <label data-k-wrap="version" class="hidden"><span>Version</span><select data-k="version"></select></label>
    </fieldset>`;

  const modal = openModal({
    title: 'Compare',
    width: 1180,
    body: `
      <datalist id="cmp-paths">${bufferPaths.map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>
      <div class="cmp-pickers">${sideHtml(0)}${sideHtml(1)}</div>
      <div class="row mt-16 mb-8" style="gap:8px">
        <button class="btn btn-primary" id="cmp-go">Compare</button>
        <button class="btn btn-sm" id="cmp-swap" title="Swap left and right">Swap sides</button>
        <button class="btn btn-sm" id="cmp-prev" title="Previous change (p)">Previous change</button>
        <button class="btn btn-sm" id="cmp-next" title="Next change (n)">Next change</button>
        <span class="faint" id="cmp-summary" style="flex:1"></span>
      </div>
      <div id="cmp-out" class="cmp-out"><div class="faint">Choose two things and press Compare.</div></div>`,
    actions: [{ label: 'Close', close: true }],
  });

  const root = $('#cmp-out').closest('.modal');
  const field = (i, k) => root.querySelector(`[data-side="${i}"] [data-k="${k}"]`);

  const loadVersions = async (i) => {
    const path = field(i, 'path').value.trim();
    const sel = field(i, 'version');
    if (!path) {
      sel.innerHTML = '<option value="">Enter a file path first</option>';
      return;
    }
    let list = versionCache.get(path);
    if (!list) {
      try {
        list = (await api(`/api/servers/${sid(server)}/config-history/versions?path=${encodeURIComponent(path)}`)).versions;
      } catch {
        list = [];
      }
      versionCache.set(path, list);
    }
    sel.innerHTML = list.length
      ? list.map((v) => `<option value="${esc(v.id)}">${esc(fmtTime(v.at))} by ${esc(v.by)} (${esc(v.source)})</option>`).join('')
      : '<option value="">No saved versions of this file</option>';
    if (sides[i].version && list.some((v) => v.id === sides[i].version)) sel.value = sides[i].version;
  };

  const sync = (i) => {
    const s = sides[i];
    field(i, 'kind').value = s.kind;
    field(i, 'path').value = s.path || '';
    root.querySelector(`[data-side="${i}"] [data-k-wrap="version"]`).classList.toggle('hidden', s.kind !== 'version');
    if (s.kind === 'version') loadVersions(i);
  };
  [0, 1].forEach((i) => {
    sync(i);
    field(i, 'kind').addEventListener('change', (e) => {
      sides[i].kind = e.target.value;
      sync(i);
    });
    field(i, 'path').addEventListener('input', (e) => {
      sides[i].path = e.target.value;
    });
    field(i, 'path').addEventListener('change', () => sides[i].kind === 'version' && loadVersions(i));
    field(i, 'version').addEventListener('change', (e) => {
      sides[i].version = e.target.value;
    });
  });

  const describe = (s) => (s.kind === 'version' ? `${s.path} (saved version)` : s.kind === 'buffer' ? `${s.path} (unsaved edits)` : s.path);
  const fetchSide = async (s) => {
    const path = (s.path || '').trim();
    if (!path) throw new Error('Enter a file path for both sides.');
    if (s.kind === 'buffer') {
      if (!(path in buffers)) throw new Error(`${path} is not open in the editor.`);
      return buffers[path];
    }
    if (s.kind === 'version') {
      if (!s.version) throw new Error(`Pick a saved version of ${path}.`);
      return readVersion(server, path, s.version);
    }
    return readFile(server, path);
  };

  let starts = [];
  let at = -1;
  const jump = (delta) => {
    if (!starts.length) return;
    at = (at + delta + starts.length) % starts.length;
    const row = $('#cmp-out').querySelector(`[data-sbs-row="${starts[at]}"]`);
    row?.scrollIntoView({ block: 'center' });
    $('#cmp-out').querySelectorAll('.sbs-row.current').forEach((r) => r.classList.remove('current'));
    row?.classList.add('current');
  };

  const run = async () => {
    const out = $('#cmp-out');
    out.innerHTML = '<div class="faint">Loading…</div>';
    try {
      for (let i = 0; i < 2; i++) if (sides[i].kind === 'version') sides[i].version = field(i, 'version').value;
      const [a, b] = await Promise.all(sides.map(fetchSide));
      const rows = lineDiff(a, b);
      const { added, removed } = diffStats(rows);
      $('#cmp-summary').textContent = added || removed ? `${removed} line${removed === 1 ? '' : 's'} only on the left, ${added} only on the right` : 'No differences';
      out.innerHTML = renderSideBySide(rows, { labels: sides.map(describe) });
      starts = changeStarts(sideBySide(rows));
      at = -1;
      if (starts.length) jump(1);
    } catch (err) {
      out.innerHTML = `<div class="faint">${esc(err.message)}</div>`;
      toast(err.message, 'error');
    }
  };

  $('#cmp-go').addEventListener('click', run);
  $('#cmp-prev').addEventListener('click', () => jump(-1));
  $('#cmp-next').addEventListener('click', () => jump(1));
  $('#cmp-swap').addEventListener('click', () => {
    sides.reverse();
    [0, 1].forEach(sync);
    run();
  });
  root.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) return;
    if (event.key === 'n') jump(1);
    else if (event.key === 'p') jump(-1);
  });
  // Opened with both sides filled in: show the result straight away.
  if (sides.every((s) => s.path)) run();
  else (sides[0].path ? field(1, 'path') : field(0, 'path')).focus();
  return modal;
}
