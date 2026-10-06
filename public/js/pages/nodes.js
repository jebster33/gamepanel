import { api } from '../core/api.js';
import { loadServers } from '../core/boot.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtBytes, fmtTime, icon, toast } from '../core/util.js';
import { confirmModal, openModal } from '../ui/modal.js';
import { renderSidebarServers } from '../ui/sidebar.js';

/* ---------------------------------------------------------------- nodes */

/** Other machines this panel controls, and the name of this one. */
export async function renderNodes(view) {
  setCrumbs('Nodes');
  const data = await api('/api/nodes').catch((err) => ({ error: err.message, local: { name: '' }, nodes: [] }));
  if (state.route.name !== 'nodes') return; // the user moved to another page meanwhile
  state.nodes = data;
  const refresh = async () => {
    await loadServers().catch(() => {});
    renderSidebarServers();
    renderNodes(view);
  };

  view.innerHTML = `
    <div class="page-head">
      <h1>Nodes</h1>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="node-add">Add node</button>
    </div>
    <div class="card mb-16 row" style="align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <div style="font-weight:600">This machine</div>
        <div class="faint" style="font-size:13px">${data.local.servers || 0} server(s). The name shows next to servers on every node.</div>
      </div>
      <input id="node-local" value="${esc(data.local.name)}" maxlength="40" style="max-width:220px" />
      <button class="btn" id="node-local-save">Rename</button>
    </div>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th>Node</th><th>Status</th><th>Servers</th><th>CPU</th><th>Memory</th><th>Version</th><th></th></tr></thead>
        <tbody>
          ${
            data.nodes.length
              ? data.nodes
                  .map(
                    (n) => `<tr>
                      <td><strong>${esc(n.name)}</strong><div class="faint mono" style="font-size:12px">${esc(n.url)}</div></td>
                      <td>${n.online ? '<span class="status running"><span class="dot"></span>Online</span>' : `<span class="status stopped" title="${esc(n.error || '')}"><span class="dot"></span>Offline</span>`}</td>
                      <td>${n.running} running / ${n.servers}</td>
                      <td>${n.host?.cpu != null ? `${Number(n.host.cpu).toFixed(0)}%` : '—'}</td>
                      <td class="nowrap">${n.host?.memory ? `${fmtBytes(n.host.memory.used)} / ${fmtBytes(n.host.memory.total)}` : '—'}</td>
                      <td class="faint">${esc(n.version || '—')}</td>
                      <td style="text-align:right" class="nowrap">
                        <button class="btn btn-sm" data-node-edit="${esc(n.id)}">Edit</button>
                        <button class="btn btn-sm btn-danger" data-node-del="${esc(n.id)}" title="Stop controlling this node">${icon('trash', 12)}</button>
                      </td></tr>`
                  )
                  .join('')
              : `<tr><td colspan="7" class="faint">No other machines yet. Install GamePanel on another computer, then add it here to run servers there from this panel.</td></tr>`
          }
        </tbody>
      </table></div>
    </div>
    ${data.nodes.some((n) => !n.online && n.seen) ? `<div class="hint mt-16">Last heard from offline nodes: ${data.nodes.filter((n) => !n.online && n.seen).map((n) => `${esc(n.name)} ${fmtTime(n.seen)}`).join(', ')}</div>` : ''}`;

  $('#node-add').addEventListener('click', () => nodeModal(null, refresh));
  $('#node-local-save').addEventListener('click', async () => {
    try {
      await api('/api/nodes/local', { method: 'PUT', body: { name: $('#node-local').value } });
      toast('Renamed');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  view.querySelectorAll('[data-node-edit]').forEach((el) =>
    el.addEventListener('click', () => nodeModal(data.nodes.find((n) => n.id === el.dataset.nodeEdit), refresh))
  );
  view.querySelectorAll('[data-node-del]').forEach((el) =>
    el.addEventListener('click', async () => {
      const node = data.nodes.find((n) => n.id === el.dataset.nodeDel);
      if (!(await confirmModal('Remove node', `${node.name} and its servers disappear from this panel. Nothing on that machine is touched.`, 'Remove'))) return;
      try {
        await api(`/api/nodes/${node.id}`, { method: 'DELETE' });
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

function nodeModal(node, onDone) {
  const modal = openModal({
    title: node ? `Edit ${esc(node.name)}` : 'Add a node',
    width: 560,
    body: `
      ${
        node
          ? ''
          : `<ol class="faint" style="margin:0 0 14px;padding-left:18px;font-size:13px;line-height:1.6">
               <li>Install GamePanel on the other machine and sign in there as an administrator.</li>
               <li>On that panel open Account, API keys, and create a key with full access (not read-only).</li>
               <li>Paste its address and the key below.</li>
             </ol>`
      }
      <label><span>Name</span><input id="nd-name" value="${esc(node?.name || '')}" placeholder="Basement PC" maxlength="40" /></label>
      <label><span>Address</span><input id="nd-url" class="mono" value="${esc(node?.url || '')}" placeholder="http://192.168.1.20:8080" spellcheck="false" /></label>
      <label><span>API key${node ? ' (blank keeps the current one)' : ''}</span><input id="nd-key" class="mono" type="password" placeholder="gp_…" autocomplete="off" spellcheck="false" /></label>
      <div class="hint">Use https:// if the node is reached over the internet, so the key is never sent in the clear.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: node ? 'Save' : 'Add node',
        primary: true,
        onClick: async (btn) => {
          const body = { name: $('#nd-name').value.trim(), url: $('#nd-url').value.trim() };
          const key = $('#nd-key').value.trim();
          if (key) body.key = key;
          btn.disabled = true;
          try {
            if (node) await api(`/api/nodes/${node.id}`, { method: 'PATCH', body });
            else await api('/api/nodes', { method: 'POST', body });
            modal.close();
            toast(node ? 'Saved' : 'Node added');
            onDone();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
  return modal;
}
