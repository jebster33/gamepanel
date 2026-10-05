import { api } from '../core/api.js';
import { render, setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtTime, icon, toast } from '../core/util.js';
import { confirmModal, openModal } from '../ui/modal.js';

/* ----------------------------------------------------------------- users */

export async function renderUsers(view) {
  setCrumbs('Users');
  const data = await api('/api/users').catch((err) => ({ users: [], error: err.message }));
  view.innerHTML = `
    <div class="page-head">
      <h1>Users</h1>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="user-new">New user</button>
    </div>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th>User</th><th>Role</th><th>Servers</th><th>Permissions</th><th>Last login</th><th></th></tr></thead>
        <tbody>
          ${data.users
            .map(
              (u) => `<tr>
                <td><strong>${esc(u.username)}</strong></td>
                <td><span class="badge ${u.role === 'admin' ? 'admin' : ''}">${esc(u.role)}</span></td>
                <td class="faint">${u.role === 'admin' ? 'All servers' : (u.servers || []).length + ' assigned'}</td>
                <td class="faint">${
                  u.role === 'admin'
                    ? 'Everything'
                    : `${(u.permissions || []).length} of ${(data.capabilities || []).length}`
                }</td>
                <td class="faint nowrap">${fmtTime(u.lastLogin)}</td>
                <td style="text-align:right" class="nowrap">
                  <button class="btn btn-sm" data-edit-user="${esc(u.id)}">Edit</button>
                  ${u.id !== state.user.id ? `<button class="btn btn-sm btn-danger" data-del-user="${esc(u.id)}">${icon('trash',12)}</button>` : ''}
                </td></tr>`
            )
            .join('')}
        </tbody>
      </table></div>
    </div>`;

  $('#user-new').addEventListener('click', () => openUserModal(null, data.capabilities, data.defaults));
  view.querySelectorAll('[data-edit-user]').forEach((el) =>
    el.addEventListener('click', () =>
      openUserModal(data.users.find((u) => u.id === el.dataset.editUser), data.capabilities, data.defaults)
    )
  );
  view.querySelectorAll('[data-del-user]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete user', 'Remove this user account?'))) return;
      try {
        await api(`/api/users/${el.dataset.delUser}`, { method: 'DELETE' });
        renderUsers(view);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

function openUserModal(user, capabilities = [], defaults = []) {
  const editing = Boolean(user);
  const held = new Set(user ? user.permissions || [] : defaults);

  // Group the capability checkboxes the way they are grouped server-side.
  const groups = {};
  for (const cap of capabilities) (groups[cap.group] = groups[cap.group] || []).push(cap);

  const permissionUi = Object.entries(groups)
    .map(
      ([group, caps]) => `
      <div class="perm-group">
        <div class="perm-group-title">${esc(group)}</div>
        ${caps
          .map(
            (cap) => `
          <label class="checkbox-row perm-row">
            <input type="checkbox" data-cap="${esc(cap.id)}" ${held.has(cap.id) ? 'checked' : ''} />
            <span>${esc(cap.label)}${
              cap.warning
                ? `<span class="faint" style="display:block;font-size:11.5px">${esc(cap.warning)}</span>`
                : ''
            }</span>
          </label>`
          )
          .join('')}
      </div>`
    )
    .join('');

  const modal = openModal({
    title: editing ? `Edit ${user.username}` : 'New user',
    width: 640,
    body: `
      <div class="form-grid">
        <label><span>Username</span><input id="u-name" value="${esc(user?.username || '')}" ${
      editing ? 'disabled' : ''
    } /></label>
        <label><span>${
          editing ? 'New password (blank keeps it)' : 'Password'
        }</span><input id="u-pass" type="password" autocomplete="new-password" /></label>
      </div>

      <label><span>Role</span>
        <select id="u-role">
          <option value="user" ${user?.role === 'user' || !editing ? 'selected' : ''}>User — only what you allow below</option>
          <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Administrator — full access to everything</option>
        </select>
      </label>

      <div id="u-scoped" class="${user?.role === 'admin' ? 'hidden' : ''}">
        <label><span>Assigned servers</span>
          <select id="u-servers" multiple size="${Math.min(6, Math.max(3, state.servers.length))}">
            ${state.servers
              .map(
                (s) =>
                  `<option value="${esc(s.id)}" ${user?.servers?.includes(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`
              )
              .join('')}
          </select>
          <div class="hint">Hold ⌘/Ctrl to pick several. This user sees nothing else.</div>
        </label>

        <div class="row" style="margin:16px 0 8px">
          <span class="field-label" style="margin:0">Permissions</span>
          <div style="flex:1"></div>
          <button type="button" class="btn btn-sm" id="u-all">Select all</button>
          <button type="button" class="btn btn-sm" id="u-none">Clear</button>
        </div>
        <div class="perm-grid">${permissionUi}</div>
      </div>

      <div id="u-admin-note" class="hint ${user?.role === 'admin' ? '' : 'hidden'}">
        Administrators hold every permission on every server, including panel settings,
        user management and updates — which is effectively shell access on this machine.
      </div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async (btn) => {
          const body = {
            username: $('#u-name').value.trim(),
            role: $('#u-role').value,
            servers: [...$('#u-servers').selectedOptions].map((o) => o.value),
            permissions: [...document.querySelectorAll('[data-cap]')].filter((c) => c.checked).map((c) => c.dataset.cap),
          };
          const password = $('#u-pass').value;
          if (password) body.password = password;
          btn.disabled = true;
          try {
            if (editing) await api(`/api/users/${user.id}`, { method: 'PATCH', body });
            else await api('/api/users', { method: 'POST', body });
            modal.close();
            toast('Saved');
            render();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });

  // Role switch hides the per-server scoping, since admins bypass all of it.
  const roleSelect = $('#u-role');
  roleSelect.addEventListener('change', () => {
    const isAdmin = roleSelect.value === 'admin';
    $('#u-scoped').classList.toggle('hidden', isAdmin);
    $('#u-admin-note').classList.toggle('hidden', !isAdmin);
  });

  const setAll = (checked) =>
    document.querySelectorAll('[data-cap]').forEach((box) => {
      box.checked = checked;
    });
  $('#u-all').addEventListener('click', () => setAll(true));
  $('#u-none').addEventListener('click', () => setAll(false));

  return modal;
}
