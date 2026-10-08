import { api } from '../../core/api.js';
import { $, esc, icon, toast } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';
import { skeleton } from '../../ui/skeleton.js';

/* --------------------------------------------------------------- access */

/**
 * Sub-users: who else can see this server and what they may do on it.
 * Permissions set here apply to this server only.
 */
export async function renderAccessTab(host, server) {
  host.innerHTML = skeleton('list', 'Loading…', 3);
  let data;
  try {
    data = await api(`/api/servers/${server.id}/access`);
  } catch (err) {
    host.innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }
  if (!host.isConnected) return; // the user moved to another tab meanwhile
  const refresh = () => renderAccessTab(host, server);
  const members = data.users.filter((u) => u.access && u.role !== 'admin');
  const others = data.users.filter((u) => !u.access && u.role !== 'admin');
  const label = (perms) => {
    const preset = data.presets.find((p) => p.permissions.length === perms.length && p.permissions.every((x) => perms.includes(x)));
    return preset ? preset.label : `${perms.length} permission${perms.length === 1 ? '' : 's'}`;
  };

  host.innerHTML = `
    <div class="card mb-16">
      <div class="row" style="align-items:center;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:220px">
          <h4 style="margin:0 0 4px">Sub-users</h4>
          <div class="faint" style="font-size:13px">People who can see this server and nothing else. Administrators always have full access.</div>
        </div>
        ${others.length ? '<button class="btn" id="acc-add">Add existing user</button>' : ''}
        <button class="btn btn-primary" id="acc-new">New sub-user</button>
      </div>
    </div>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th>User</th><th>Can do</th><th></th></tr></thead>
        <tbody>
          ${
            members.length
              ? members
                  .map(
                    (u) => `<tr>
                      <td><strong>${esc(u.username)}</strong></td>
                      <td class="faint">${esc(label(u.permissions))}${u.custom ? '' : ' <span class="badge" title="Uses the account\'s general permissions from the Users page">general</span>'}</td>
                      <td style="text-align:right" class="nowrap">
                        <button class="btn btn-sm" data-acc-edit="${esc(u.id)}">Change</button>
                        <button class="btn btn-sm btn-danger" data-acc-del="${esc(u.id)}" title="Remove from this server">${icon('trash', 12)}</button>
                      </td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="3" class="faint">Nobody else has access yet.</td></tr>'
          }
        </tbody>
      </table></div>
    </div>`;

  $('#acc-new').addEventListener('click', () => accessModal({ server, data, onDone: refresh }));
  $('#acc-add')?.addEventListener('click', () => accessModal({ server, data, pick: others, onDone: refresh }));
  host.querySelectorAll('[data-acc-edit]').forEach((el) =>
    el.addEventListener('click', () => accessModal({ server, data, user: members.find((u) => u.id === el.dataset.accEdit), onDone: refresh }))
  );
  host.querySelectorAll('[data-acc-del]').forEach((el) =>
    el.addEventListener('click', async () => {
      const u = members.find((m) => m.id === el.dataset.accDel);
      if (!(await confirmModal('Remove access', `${u.username} will no longer see ${server.name}. Their account stays.`, 'Remove'))) return;
      try {
        await api(`/api/servers/${server.id}/access/${u.id}`, { method: 'DELETE' });
        toast(`${u.username} removed`);
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

function accessModal({ server, data, user, pick, onDone }) {
  const held = new Set(user ? user.permissions : data.presets[0].permissions);
  const modal = openModal({
    title: user ? `What ${esc(user.username)} can do` : pick ? 'Add a user to this server' : 'New sub-user',
    width: 560,
    body: `
      ${
        user
          ? ''
          : pick
            ? `<label><span>User</span><select id="acc-user">${pick.map((u) => `<option value="${esc(u.id)}">${esc(u.username)}</option>`).join('')}</select></label>`
            : `<div class="form-grid">
                 <label><span>Username</span><input id="acc-name" autocomplete="off" /></label>
                 <label><span>Password</span><input id="acc-pass" type="password" autocomplete="new-password" /></label>
               </div>`
      }
      <span class="field-label" style="margin-top:12px">Quick pick</span>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:12px">
        ${data.presets.map((p) => `<button type="button" class="btn btn-sm" data-preset="${esc(p.id)}">${esc(p.label)}</button>`).join('')}
      </div>
      <div class="perm-grid">
        ${data.capabilities
          .map(
            (c) => `<label class="checkbox-row perm-row"><input type="checkbox" data-acap="${esc(c.id)}" ${held.has(c.id) ? 'checked' : ''} /><span>${esc(c.label)}</span></label>`
          )
          .join('')}
      </div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async (btn) => {
          const permissions = [...document.querySelectorAll('[data-acap]')].filter((c) => c.checked).map((c) => c.dataset.acap);
          btn.disabled = true;
          try {
            if (user || pick) {
              const id = user ? user.id : $('#acc-user').value;
              await api(`/api/servers/${server.id}/access/${id}`, { method: 'PUT', body: { permissions } });
            } else {
              await api(`/api/servers/${server.id}/access`, { method: 'POST', body: { username: $('#acc-name').value.trim(), password: $('#acc-pass').value, permissions } });
            }
            modal.close();
            toast('Saved');
            onDone();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
  document.querySelectorAll('[data-preset]').forEach((el) =>
    el.addEventListener('click', () => {
      const preset = data.presets.find((p) => p.id === el.dataset.preset);
      document.querySelectorAll('[data-acap]').forEach((box) => {
        box.checked = preset.permissions.includes(box.dataset.acap);
      });
    })
  );
  return modal;
}
