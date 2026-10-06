import { api } from '../core/api.js';
import { render, setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtTime, icon, toast } from '../core/util.js';
import { confirmModal, openModal } from '../ui/modal.js';

/* ----------------------------------------------------------------- users */

export async function renderUsers(view) {
  setCrumbs('Users');
  const data = await api('/api/users').catch((err) => ({ users: [], error: err.message }));
  if (state.route.name !== 'users') return; // the user moved to another page meanwhile
  view.innerHTML = `
    <div class="page-head">
      <h1>Users</h1>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="user-new">New user</button>
    </div>
    <div class="card mb-16 row" style="align-items:center;gap:12px">
      <div style="flex:1;min-width:220px">
        <div style="font-weight:600">Require two-factor for administrators</div>
        <div class="faint" style="font-size:13px">Admins without an authenticator app can only open their Account page until they set one up.</div>
      </div>
      <label class="switch"><input type="checkbox" id="policy-2fa" ${data.requireAdmin2fa ? 'checked' : ''} /><i></i></label>
    </div>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th>User</th><th>Role</th><th>Servers</th><th>Permissions</th><th>Last login</th><th></th></tr></thead>
        <tbody>
          ${data.users
            .map(
              (u) => `<tr>
                <td><strong>${esc(u.username)}</strong>${u.twoFactor ? ' <span class="badge" title="Signs in with an authenticator code">2FA</span>' : ''}</td>
                <td><span class="badge ${u.role === 'admin' ? 'admin' : ''}">${esc(u.role)}</span></td>
                <td class="faint">${u.role === 'admin' ? 'All servers' : (u.servers || []).length + ' assigned'}</td>
                <td class="faint">${
                  u.role === 'admin'
                    ? 'Everything'
                    : `${(u.permissions || []).length} of ${(data.capabilities || []).length}`
                }</td>
                <td class="faint nowrap">${fmtTime(u.lastLogin)}</td>
                <td style="text-align:right" class="nowrap">
                  ${u.twoFactor && u.id !== state.user.id ? `<button class="btn btn-sm" data-reset-tf="${esc(u.id)}" title="For someone who lost their phone and recovery codes">Reset 2FA</button>` : ''}
                  ${u.id !== state.user.id ? `<button class="btn btn-sm" data-revoke="${esc(u.id)}" title="Ends their sessions on every device">Sign out</button>` : ''}
                  <button class="btn btn-sm" data-edit-user="${esc(u.id)}">Edit</button>
                  ${u.id !== state.user.id ? `<button class="btn btn-sm btn-danger" data-del-user="${esc(u.id)}">${icon('trash',12)}</button>` : ''}
                </td></tr>`
            )
            .join('')}
        </tbody>
      </table></div>
    </div>`;

  $('#user-new').addEventListener('click', () => openUserModal(null, data.capabilities, data.defaults));
  $('#policy-2fa').addEventListener('change', async (event) => {
    try {
      await api('/api/users/policy', { method: 'PUT', body: { requireAdmin2fa: event.target.checked } });
      toast(event.target.checked ? 'Admins now need two-factor sign-in' : 'Two-factor is optional again');
    } catch (err) {
      event.target.checked = !event.target.checked;
      toast(err.message, 'error');
    }
  });
  view.querySelectorAll('[data-edit-user]').forEach((el) =>
    el.addEventListener('click', () =>
      openUserModal(data.users.find((u) => u.id === el.dataset.editUser), data.capabilities, data.defaults)
    )
  );
  view.querySelectorAll('[data-reset-tf]').forEach((el) =>
    el.addEventListener('click', async () => {
      const target = data.users.find((u) => u.id === el.dataset.resetTf);
      if (!(await confirmModal('Reset two-factor sign-in', `${target.username} will sign in with only their password until they turn it on again.`, 'Reset'))) return;
      try {
        await api(`/api/users/${target.id}`, { method: 'PATCH', body: { resetTwoFactor: true } });
        toast(`Two-factor sign-in reset for ${target.username}`);
        renderUsers(view);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
  view.querySelectorAll('[data-revoke]').forEach((el) =>
    el.addEventListener('click', async () => {
      const target = data.users.find((u) => u.id === el.dataset.revoke);
      if (!(await confirmModal('Sign out everywhere', `${target.username} is signed out on every device and has to sign in again.`, 'Sign out'))) return;
      try {
        await api(`/api/users/${target.id}`, { method: 'PATCH', body: { revokeSessions: true } });
        toast(`${target.username} was signed out everywhere`);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
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

  const quota = user?.quota || { servers: 1, memoryMb: 4096, diskGb: 20 };
  const modal = openModal({
    title: editing ? `Edit ${esc(user.username)}` : 'New user',
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

        <div id="u-quota" class="${(user?.permissions || []).includes('deploy') ? '' : 'hidden'}">
          <h4 class="section-title mt-16">Quota for servers they create</h4>
          <div class="form-grid">
            <label><span>Servers</span><input id="u-q-servers" type="number" min="0" value="${quota.servers}" /></label>
            <label><span>Memory in total (MB)</span><input id="u-q-memory" type="number" min="0" step="512" value="${quota.memoryMb}" /></label>
            <label><span>Disk in total (GB)</span><input id="u-q-disk" type="number" min="0" value="${quota.diskGb}" /></label>
          </div>
          <div class="hint" style="margin-top:-6px">0 means no limit. Only servers this person creates count; servers you assign above do not.</div>
        </div>
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
          if (body.permissions.includes('deploy')) {
            body.quota = { servers: Number($('#u-q-servers').value), memoryMb: Number($('#u-q-memory').value), diskGb: Number($('#u-q-disk').value) };
          }
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
  // The quota only matters to people who may create servers.
  const deployBox = document.querySelector('[data-cap="deploy"]');
  const syncQuota = () => $('#u-quota').classList.toggle('hidden', !deployBox?.checked);
  deployBox?.addEventListener('change', syncQuota);
  $('#u-all').addEventListener('click', () => {
    setAll(true);
    syncQuota();
  });
  $('#u-none').addEventListener('click', () => {
    setAll(false);
    syncQuota();
  });

  return modal;
}
