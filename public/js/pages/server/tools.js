import { api } from '../../core/api.js';
import { $, can, esc, fmtTime, toast } from '../../core/util.js';
import { state } from '../../core/state.js';
import { confirmModal, openModal } from '../../ui/modal.js';
import { section, attempt, table, ago, mb, download, field } from './tools-kit.js';
import { gameSections } from './tools-games.js';
import { minecraftSections } from './tools-mc.js';
import { playerSections } from './tools-players.js';

/* ------------------------------------------------------------- Tools tab */

/** The Tools tab: everything that works around a server rather than inside its game. */
export function renderToolsTab(host, server) {
  host.innerHTML = '<div class="tools"></div>';
  const box = $('.tools', host);
  const base = `/api/servers/${server.id}`;
  const defs = [
    ...minecraftSections(server),
    ...gameSections(server),
    ...playerSections(server),
    can('console') && crashSection(server, base),
    can('console') && explainSection(server, base),
    can('files') && searchSection(server, base),
    can('files') && trashSection(server, base),
    quotaSection(server, base),
    state.user.role === 'admin' && !server.node && isolationSection(server, base),
  ].filter(Boolean);
  for (const def of defs) section(box, def);
  // A link like #/servers/abc/tools?open=trash is not needed: the first card is open.
  box.querySelector('details')?.setAttribute('open', '');
  box.querySelector('details')?.dispatchEvent(new Event('toggle'));
}

/* ------------------------------------------------------------------ trash */

function trashSection(server, base) {
  return {
    id: 'trash',
    title: 'Trash',
    lead: 'Deleted files are kept for two weeks',
    async load(body) {
      const draw = async () => {
        const { items, keepDays } = await api(`${base}/trash`);
        body.innerHTML = `
          <p class="hint" style="margin:0 0 10px">Files and folders deleted in the file manager wait here for ${keepDays} days, then go for good. Very large ones (over 2 GB) are not kept.</p>
          ${table(
            ['Was at', 'Deleted', 'Size', ''],
            items.map((i) => [`<span class="mono">${esc(i.path)}</span>${i.dir ? ' <span class="badge">folder</span>' : ''}`, `${esc(ago(i.at))}${i.by ? ` by ${esc(i.by)}` : ''}`, esc(mb(i.size || 0)), can('files.write') ? `<button class="btn btn-sm" data-restore="${esc(i.id)}">Restore</button> <button class="btn btn-sm btn-ghost" data-drop="${esc(i.id)}">Delete forever</button>` : '']),
            { empty: 'The trash is empty.' }
          )}
          ${items.length && can('files.write') ? '<div class="mt-8"><button class="btn btn-sm btn-danger" id="trash-empty">Empty trash</button></div>' : ''}`;
        body.querySelectorAll('[data-restore]').forEach((b) =>
          b.addEventListener('click', async () => {
            const out = await attempt(() => api(`${base}/trash/${b.dataset.restore}/restore`, { method: 'POST' }));
            if (out) {
              toast(`Restored ${out.path}`);
              draw();
            }
          })
        );
        body.querySelectorAll('[data-drop]').forEach((b) =>
          b.addEventListener('click', async () => {
            if (await attempt(() => api(`${base}/trash/${b.dataset.drop}`, { method: 'DELETE' }))) draw();
          })
        );
        $('#trash-empty', body)?.addEventListener('click', async () => {
          if (!(await confirmModal('Empty the trash', 'Everything in the trash is deleted for good.', 'Empty trash'))) return;
          if (await attempt(() => api(`${base}/trash`, { method: 'DELETE' }), 'Trash emptied')) draw();
        });
      };
      await draw();
    },
  };
}

/* ----------------------------------------------------------------- search */

function searchSection(server, base) {
  return {
    id: 'search',
    title: 'Search in files',
    lead: 'Find text in every config, script and log of this server',
    load(body) {
      body.innerHTML = `
        <form id="gs-form" class="tools-row" style="align-items:flex-end">
          <label class="field" style="flex:2;min-width:200px;margin:0"><span>Find</span><input id="gs-q" placeholder="max-players, 25565, password…" minlength="2" required /></label>
          <label class="field" style="flex:1;min-width:140px;margin:0"><span>In files named</span><input id="gs-files" placeholder="*.yml, *.json" /></label>
          <button class="btn btn-primary" type="submit">Search</button>
        </form>
        <div class="tools-row mt-8">
          <label class="checkbox-row"><input type="checkbox" id="gs-regex" /><label for="gs-regex">Pattern (regex)</label></label>
          <label class="checkbox-row"><input type="checkbox" id="gs-case" /><label for="gs-case">Match case</label></label>
          <label class="checkbox-row"><input type="checkbox" id="gs-logs" /><label for="gs-logs">Include .log files</label></label>
          <label class="checkbox-row"><input type="checkbox" id="gs-ctx" /><label for="gs-ctx">Show surrounding lines</label></label>
        </div>
        <div id="gs-out" class="mt-16"></div>`;
      const out = $('#gs-out', body);
      $('#gs-form', body).addEventListener('submit', async (e) => {
        e.preventDefault();
        out.innerHTML = '<span class="spinner"></span>';
        const p = new URLSearchParams({ q: $('#gs-q', body).value, files: $('#gs-files', body).value, regex: $('#gs-regex', body).checked ? '1' : '0', case: $('#gs-case', body).checked ? '1' : '0', logs: $('#gs-logs', body).checked ? '1' : '0', context: $('#gs-ctx', body).checked ? '2' : '0' });
        let r;
        try {
          r = await api(`${base}/files/grep?${p}`);
        } catch (err) {
          out.innerHTML = `<div class="faint">${esc(err.message)}</div>`;
          return;
        }
        const groups = new Map();
        for (const hit of r.results) (groups.get(hit.path) || groups.set(hit.path, []).get(hit.path)).push(hit);
        out.innerHTML = `<div class="hint">${r.results.length} match${r.results.length === 1 ? '' : 'es'} in ${groups.size} file${groups.size === 1 ? '' : 's'} (${r.scanned} files looked at)${r.truncated ? '. Stopped early: narrow the search.' : ''}</div>
          ${[...groups]
            .map(
              ([path, hits]) => `<div class="mt-8"><a class="mono" href="#/servers/${esc(server.id)}/files" title="Open the file manager">${esc(path)}</a>${hits
                .map((h) => `<div class="tools-hit">${[...h.before.map((l) => `<span class="faint">${esc(l)}</span>`), `<b>${h.line}:</b> ${esc(h.text)}`, ...h.after.map((l) => `<span class="faint">${esc(l)}</span>`)].join('<br>')}</div>`)
                .join('')}</div>`
            )
            .join('')}`;
      });
    },
  };
}

/* ---------------------------------------------------------- crash reports */

function crashSection(server, base) {
  return {
    id: 'crashes',
    title: 'Crash reports',
    lead: server.crashCount ? `${server.crashCount} crash${server.crashCount > 1 ? 'es' : ''} so far` : 'What happened when it crashed',
    async load(body) {
      const draw = async () => {
        const { crashes } = await api(`${base}/crashes`);
        body.innerHTML = `
          <p class="hint" style="margin:0 0 10px">When the server dies on its own, the panel saves what it knew: the likely cause, the last console lines, the game's own crash report and the mods that were loaded. The newest 20 are kept.</p>
          ${table(
            ['When', 'Likely cause', 'Ran for', ''],
            crashes.map((c) => [esc(fmtTime(c.at)), c.causes.length ? esc(c.causes.join('; ')) : '<span class="faint">No known cause matched</span>', esc(`${Math.round(c.uptimeMs / 60000)} min`), `<button class="btn btn-sm" data-open="${esc(c.id)}">Open</button> <a class="btn btn-sm btn-ghost" href="${base}/crashes/${esc(c.id)}/bundle">Download</a>`]),
            { empty: 'No crashes recorded.' }
          )}`;
        body.querySelectorAll('[data-open]').forEach((b) =>
          b.addEventListener('click', async () => {
            const c = await attempt(() => api(`${base}/crashes/${b.dataset.open}`));
            if (!c) return;
            openModal({
              title: `Crash on ${esc(fmtTime(c.at))}`,
              width: 760,
              body: `${c.findings.map((f) => `<div class="mb-8"><b>${esc(f.title)}</b><div class="hint">${esc(f.detail)}</div></div>`).join('') || '<div class="faint mb-8">No known cause matched. The console lines below usually say why.</div>'}
                ${c.reports.map((r) => `<h4>${esc(r.name)}</h4><div class="tools-pre">${esc(r.text.slice(0, 6000))}</div>`).join('')}
                <h4>Last console lines</h4><div class="tools-pre">${esc(c.lines.slice(-120).join('\n'))}</div>`,
              actions: [{ label: 'Close', close: true }],
            });
          })
        );
      };
      await draw();
    },
  };
}

/* ------------------------------------------------------- the log explainer */

function explainSection(server, base) {
  return {
    id: 'explain',
    title: 'Explain a log line',
    lead: 'Paste a line, or pick a recent warning',
    async load(body) {
      body.innerHTML = `
        <div class="tools-row"><input id="ex-line" style="flex:1;min-width:240px" placeholder="[12:00:01 WARN]: Can't keep up! Is the server overloaded?" /><button class="btn btn-primary" id="ex-go">Explain</button></div>
        <div id="ex-answer" class="mt-16"></div>
        <h4 class="mt-16">Recent warnings and errors</h4><div id="ex-recent"><span class="spinner"></span></div>`;
      const answer = $('#ex-answer', body);
      const explain = async (line) => {
        const r = await attempt(() => api(`${base}/explain`, { method: 'POST', body: { line } }));
        if (!r) return;
        const tone = r.level === 'error' ? 'bad' : r.level === 'warn' ? 'warn' : 'accent';
        answer.innerHTML = `<div class="card" style="background:transparent"><span class="badge ${tone}">${esc(r.level)}</span> <b>${esc(r.title)}</b>${r.detail ? ` <span class="mono faint">${esc(r.detail)}</span>` : ''}<p style="margin:8px 0 0">${esc(r.meaning)}</p>${r.fix ? `<p style="margin:8px 0 0"><b>What to do:</b> ${esc(r.fix)}</p>` : ''}</div>`;
      };
      $('#ex-go', body).addEventListener('click', () => explain($('#ex-line', body).value));
      $('#ex-line', body).addEventListener('keydown', (e) => e.key === 'Enter' && explain(e.currentTarget.value));
      const recent = await api(`${base}/explain/recent`);
      $('#ex-recent', body).innerHTML = recent.lines.length
        ? recent.lines.map((l, i) => `<div class="tools-hit"><button class="btn btn-sm btn-ghost" data-i="${i}">Explain</button> ${l.count > 1 ? `<span class="badge">×${l.count}</span> ` : ''}${esc(l.line)}</div>`).join('')
        : '<div class="faint">Nothing in the recent console.</div>';
      body.querySelectorAll('[data-i]').forEach((b) =>
        b.addEventListener('click', () => {
          const line = recent.lines[Number(b.dataset.i)].line;
          $('#ex-line', body).value = line;
          explain(line);
        })
      );
    },
  };
}

/* ------------------------------------------------------------- disk quota */

function quotaSection(server, base) {
  return {
    id: 'quota',
    title: 'Disk quota',
    lead: 'Warn (or stop) before this server fills the disk',
    async load(body) {
      const draw = async () => {
        const q = await api(`${base}/disk-quota`);
        const pct = q.pct ?? 0;
        const admin = state.user.role === 'admin';
        body.innerHTML = `
          ${q.gb ? `<div class="tools-bar ${pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : ''}"><i style="width:${Math.min(100, pct)}%"></i></div><div class="hint mt-8">${esc(mb(q.used))} of ${q.gb} GB (${pct.toFixed(0)}%). Warnings go out at 80%, 95% and 100%.</div>` : `<div class="hint">No quota. The server folder is ${esc(mb(q.used))} now.</div>`}
          ${admin ? `<div class="tools-row mt-16">${field('Quota (GB, 0 = none)', `<input id="dq-gb" type="number" min="0" step="1" value="${q.gb || 0}" style="width:120px" />`)}
            <label class="checkbox-row"><input type="checkbox" id="dq-block" ${q.block ? 'checked' : ''} /><label for="dq-block">Do not start the server while it is over the quota</label></label>
            <button class="btn btn-primary" id="dq-save">Save</button></div>` : ''}`;
        $('#dq-save', body)?.addEventListener('click', async () => {
          if (await attempt(() => api(`${base}/disk-quota`, { method: 'PUT', body: { gb: Number($('#dq-gb', body).value), block: $('#dq-block', body).checked } }), 'Quota saved')) draw();
        });
      };
      await draw();
    },
  };
}

/* -------------------------------------------------------------- isolation */

function isolationSection(server, base) {
  return {
    id: 'isolation',
    title: 'Isolation and CPU cores',
    lead: 'Docker or plain process, and which cores this server may use',
    async load(body) {
      const draw = async () => {
        const i = await api(`${base}/isolation`);
        const locked = i.running ? 'disabled' : '';
        body.innerHTML = `
          <div class="tools-grid">
            <div>
              <h4 style="margin:0 0 6px">How it runs</h4>
              <select id="iso-rt" ${locked} ${i.windowsBuild ? 'disabled' : ''}>
                <option value="auto" ${i.runtime === 'auto' ? 'selected' : ''}>Automatic (Docker when the panel uses it)</option>
                <option value="docker" ${i.runtime === 'docker' ? 'selected' : ''} ${i.dockerAvailable ? '' : 'disabled'}>Always in Docker (isolated)</option>
                <option value="process" ${i.runtime === 'process' ? 'selected' : ''}>Always a plain process</option>
              </select>
              <div class="hint mt-8">Now: <b>${i.effective === 'docker' ? 'Docker container' : 'plain process'}</b>. ${i.windowsBuild ? 'Windows game builds always run as processes.' : !i.templateAllowsDocker ? 'This game cannot run in a container.' : i.running ? 'Stop the server to change this.' : 'A container keeps the game away from the rest of the machine and enforces its memory and CPU limits.'}${i.dockerAvailable ? '' : ' Docker is not installed here.'}</div>
            </div>
            <div>
              <h4 style="margin:0 0 6px">CPU cores</h4>
              ${i.cpu.supported ? `<input id="iso-cpu" value="${esc(i.cpu.spec)}" placeholder="off, auto, 2-5 or 0,1,4" style="width:100%" />
              <div class="hint mt-8">This machine has ${i.cpu.cores} cores (0 to ${i.cpu.cores - 1}). "auto" gives each auto-pinned server its own block.${i.cpu.resolved ? ` This server: <b>${esc(i.cpu.resolved)}</b>.` : ''} ${i.running && !i.cpu.docker ? 'Applied to the running server now.' : i.running ? 'A container gets it at the next start.' : ''}</div>` : '<div class="hint">Pinning is not available on this system.</div>'}
            </div>
          </div>
          <div class="mt-16"><button class="btn btn-primary" id="iso-save">Save</button></div>`;
        $('#iso-save', body).addEventListener('click', async () => {
          const payload = {};
          if (!locked && !i.windowsBuild) payload.runtime = $('#iso-rt', body).value;
          if (i.cpu.supported) payload.cpuAffinity = $('#iso-cpu', body).value;
          if (await attempt(() => api(`${base}/isolation`, { method: 'PUT', body: payload }), 'Saved')) draw();
        });
      };
      await draw();
    },
  };
}
