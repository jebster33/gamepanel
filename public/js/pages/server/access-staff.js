import { api } from '../../core/api.js';
import { $, esc, toast } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';

/* --------------------------------------- role templates and timed access */

function countdown(ms) {
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return `${d}d ${h}h left`;
  if (h) return `${h}h ${m % 60}m left`;
  return `${Math.max(1, m)}m left`;
}

/**
 * Adds to the Access tab: an "apply role" picker on each sub-user, a card for
 * access that runs out, and a countdown next to anyone who has it.
 */
export async function decorateAccess(host, server, data, refresh) {
  let info;
  try {
    info = await api(`/api/servers/${server.id}/access-grants`);
  } catch {
    return; // the tab still works without it
  }
  if (!host.isConnected) return;
  const skew = info.now - Date.now();
  const left = (g) => g.expiresAt - (Date.now() + skew);
  const byUser = new Map(info.grants.map((g) => [g.userId, g]));
  const sub = data.users.filter((u) => u.role !== 'admin');

  // A role picker and a countdown on each sub-user's row.
  host.querySelectorAll('[data-acc-edit]').forEach((btn) => {
    const id = btn.dataset.accEdit;
    const row = btn.closest('tr');
    const g = byUser.get(id);
    if (g) row.children[1].insertAdjacentHTML('beforeend', ` <span class="badge" data-grant-left="${esc(g.id)}" title="Access removed automatically at the end">${esc(countdown(left(g)))}</span>`);
    const select = document.createElement('select');
    select.className = 'staff-role-pick';
    select.title = 'Give them a role template';
    select.innerHTML = `<option value="">Role…</option>${info.roles.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}`;
    select.addEventListener('change', async () => {
      if (!select.value) return;
      try {
        await api(`/api/servers/${server.id}/access/${encodeURIComponent(id)}/role`, { method: 'POST', body: { role: select.value } });
        toast('Role applied');
        refresh();
      } catch (err) {
        toast(err.message, 'error');
        select.value = '';
      }
    });
    btn.parentElement.prepend(select, ' ');
  });

  const card = document.createElement('div');
  card.className = 'card mt-16';
  card.innerHTML = `
    <div class="row" style="align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:220px"><h4 style="margin:0 0 4px">Temporary access</h4>
      <div class="faint" style="font-size:13px">Give someone access for a few hours or days. It is taken away by itself, and the account stays.</div></div>
      <button class="btn" id="grant-new">Grant temporary access</button>
    </div>
    ${
      info.grants.length
        ? `<div class="list mt-8">${info.grants
            .map(
              (g) => `<div class="list-row"><div class="grow"><div class="title">${esc(g.username)} <span class="badge" data-grant-left="${esc(g.id)}">${esc(countdown(left(g)))}</span></div>
                <div class="sub">${esc(g.roleId ? info.roles.find((r) => r.id === g.roleId)?.name || 'role' : `${g.permissions.length} permissions`)} · until ${esc(new Date(g.expiresAt).toLocaleString())} · by ${esc(g.by)}</div></div>
                <button class="btn btn-sm" data-grant-end="${esc(g.id)}">End now</button></div>`
            )
            .join('')}</div>`
        : ''
    }`;
  host.appendChild(card);

  const timer = setInterval(() => {
    if (!host.isConnected) return clearInterval(timer);
    host.querySelectorAll('[data-grant-left]').forEach((el) => {
      const g = info.grants.find((x) => x.id === el.dataset.grantLeft);
      if (g) el.textContent = countdown(left(g));
    });
    if (info.grants.some((g) => left(g) <= 0)) {
      clearInterval(timer);
      setTimeout(refresh, 65_000); // the server removes it within a minute
    }
  }, 15_000);

  card.querySelectorAll('[data-grant-end]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmModal('End access now', 'They lose access to this server straight away.', 'End access'))) return;
      try {
        await api(`/api/servers/${server.id}/access-grants/${encodeURIComponent(b.dataset.grantEnd)}`, { method: 'DELETE' });
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  $('#grant-new').addEventListener('click', () => {
    if (!sub.length) return toast('There are no sub-user accounts yet. Add one first.', 'warn');
    const modal = openModal({
      title: 'Grant temporary access',
      width: 480,
      body: `<label><span>User</span><select id="gr-user">${sub.map((u) => `<option value="${esc(u.id)}">${esc(u.username)}</option>`).join('')}</select></label>
        <label class="mt-8"><span>Role</span><select id="gr-role">${info.roles.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}: ${esc(r.permissions.length)} permissions</option>`).join('')}</select></label>
        <label class="mt-8"><span>For how many hours</span><input id="gr-hours" type="number" min="1" max="8760" value="24" /></label>
        <div class="hint mt-8">Whatever they had before comes back when it ends. Role templates are managed on the Staff page.</div>`,
      actions: [
        { label: 'Cancel', close: true },
        {
          label: 'Grant',
          primary: true,
          onClick: async (btn) => {
            btn.disabled = true;
            try {
              await api(`/api/servers/${server.id}/access-grants`, { method: 'POST', body: { userId: $('#gr-user').value, role: $('#gr-role').value, hours: Number($('#gr-hours').value) } });
              modal.close();
              toast('Access granted');
              refresh();
            } catch (err) {
              toast(err.message, 'error');
              btn.disabled = false;
            }
          },
        },
      ],
    });
  });
}
