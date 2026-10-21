import { api } from '../../core/api.js';
import { setCrumbs } from '../../core/router.js';
import { state } from '../../core/state.js';
import { esc, fmtBytes } from '../../core/util.js';
import { skeleton } from '../../ui/skeleton.js';

/* ------------------------------------------------ ARK cluster transfers -- */

const when = (ts) => (ts ? new Date(ts).toLocaleString() : '—');

/** The page for #/clusters/<id>: what was uploaded to, and downloaded from, one cluster. */
export async function renderClusterTransfers(view) {
  const id = state.route.params.id;
  setCrumbs('<a href="#/servers">Servers</a> <span class="sep">/</span> <a href="#/clusters">ARK clusters</a> <span class="sep">/</span> Transfers');
  view.innerHTML = `<div class="page-head"><div><h1>Cluster transfers</h1></div></div><div id="ct-body">${skeleton('list', 'Reading the cluster folder and logs…', 4)}</div>`;
  let d;
  try {
    d = await api(`/api/clusters/${encodeURIComponent(id)}/transfers`);
  } catch (err) {
    view.querySelector('#ct-body').innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }
  if (!view.isConnected) return;
  view.querySelector('h1').textContent = `${d.cluster.name}: transfers`;
  view.querySelector('#ct-body').innerHTML = `
    <p class="faint" style="max-width:760px;line-height:1.6">${esc(d.note)}</p>
    <div class="card mb-16"><h4>Stored in the cluster now</h4>
      ${
        d.files.length
          ? `<table><thead><tr><th>Uploaded</th><th>What</th><th>File</th><th>Size</th></tr></thead><tbody>${d.files
              .map((f) => `<tr><td>${esc(when(f.at))}</td><td>${esc(f.kind)}</td><td class="mono">${esc(f.file)}</td><td>${esc(fmtBytes(f.size))}</td></tr>`)
              .join('')}</tbody></table>`
          : '<div class="faint" style="padding:12px">Nothing has been uploaded yet.</div>'
      }
      <div class="hint">Folder: <span class="mono">${esc(d.folder)}</span></div></div>
    <div class="card"><h4>Transfer lines from the server logs</h4>
      ${
        d.lines.length
          ? `<table><thead><tr><th>When</th><th>Server</th><th>Log line</th></tr></thead><tbody>${d.lines
              .map((l) => `<tr><td>${esc(when(l.at))}${l.approximate ? ' <span class="faint">(approx.)</span>' : ''}</td><td>${esc(l.server.name)}</td><td class="mono" style="word-break:break-word">${esc(l.text)}</td></tr>`)
              .join('')}</tbody></table>`
          : '<div class="faint" style="padding:12px">No upload or download lines in the recent logs.</div>'
      }</div>`;
}
