import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { $, esc, fmtTime, toast } from '../core/util.js';
import { confirmModal, openModal } from '../ui/modal.js';
import { skeleton } from '../ui/skeleton.js';
import { forgetReasonTemplates } from './staff-reasons.js';

/* ----------------------------------------------------------------- staff */

/** Staff activity, ban and kick reason templates, and role templates. Administrators only. */
export async function renderStaff(view) {
  setCrumbs('Staff');
  view.innerHTML = `
    <div class="page-head"><h1>Staff</h1></div>
    <div class="tabs mb-16" id="staff-tabs">
      <button class="tab active" data-staff-tab="activity">Activity</button>
      <button class="tab" data-staff-tab="reasons">Ban and kick reasons</button>
      <button class="tab" data-staff-tab="roles">Role templates</button>
    </div>
    <div id="staff-body"></div>`;
  const show = (tab) => {
    document.querySelectorAll('[data-staff-tab]').forEach((b) => b.classList.toggle('active', b.dataset.staffTab === tab));
    ({ activity: drawActivity, reasons: drawReasons, roles: drawRoles })[tab]($('#staff-body'));
  };
  document.querySelectorAll('[data-staff-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.staffTab)));
  show('activity');
}

const KIND_LABEL = { kick: 'Kicks', ban: 'Bans', unban: 'Unbans', note: 'Notes', appeal: 'Appeals', moderation: 'Other' };

const sumDays = (days, n) => {
  const from = Date.now() - n * 86_400_000;
  return Object.entries(days).reduce((t, [d, c]) => (Date.parse(d) >= from - 86_400_000 ? t + c : t), 0);
};

/* -------------------------------------------------------------- activity */

async function drawActivity(box) {
  box.innerHTML = skeleton('list', 'Reading the logs…');
  let data;
  try {
    data = await api('/api/staff/activity');
  } catch (err) {
    box.innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }
  if (!box.isConnected) return;
  box.innerHTML = `
    <p class="faint" style="margin:0 0 12px">Kicks, bans, notes and other moderation, taken from the audit log, the shared ban list and player notes. Click a name for the day-by-day numbers and the full list.</p>
    <div class="card card-flush"><div class="table-wrap"><table>
      <thead><tr><th>Who</th><th>Total</th><th>Last 7 days</th><th>Last 30 days</th><th>Last active</th><th>Kicks</th><th>Bans</th><th>Notes</th></tr></thead>
      <tbody>${data.staff
        .map(
          (p) => `<tr>
            <td><a href="#" data-staff-open="${esc(p.user)}"><strong>${esc(p.user)}</strong></a> <span class="faint">${esc(p.role)}</span></td>
            <td class="mono">${p.total}</td><td class="mono">${sumDays(p.days, 7)}</td><td class="mono">${sumDays(p.days, 30)}</td>
            <td class="faint nowrap">${p.last ? esc(fmtTime(p.last)) : 'never'}</td>
            <td class="mono">${p.kinds.kick || 0}</td><td class="mono">${(p.kinds.ban || 0) + (p.kinds.unban || 0)}</td><td class="mono">${p.kinds.note || 0}</td>
          </tr>`
        )
        .join('') || '<tr><td colspan="8" class="faint">No staff yet.</td></tr>'}</tbody>
    </table></div></div>`;
  box.querySelectorAll('[data-staff-open]').forEach((a) =>
    a.addEventListener('click', (event) => {
      event.preventDefault();
      staffModal(data.staff.find((p) => p.user === a.dataset.staffOpen));
    })
  );
}

function staffModal(p) {
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const max = Math.max(1, ...days.map((d) => p.days[d] || 0));
  openModal({
    title: esc(p.user),
    width: 700,
    body: `
      <div class="faint" style="font-size:12px;margin-bottom:6px">Actions per day, last 30 days</div>
      <div class="staff-bars">${days.map((d) => `<span title="${esc(d)}: ${p.days[d] || 0}" style="height:${Math.max(2, ((p.days[d] || 0) / max) * 100)}%"></span>`).join('')}</div>
      <div class="faint" style="font-size:12px;margin:14px 0 6px">Per week (weeks start on Monday)</div>
      <div class="row" style="gap:6px;flex-wrap:wrap">${
        Object.entries(p.weeks).sort().reverse().map(([w, c]) => `<span class="badge">${esc(w)}: ${c}</span>`).join('') || '<span class="faint">Nothing in the last 12 weeks.</span>'
      }</div>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:12px">${Object.entries(p.kinds).map(([k, c]) => `<span class="badge">${esc(KIND_LABEL[k] || k)}: ${c}</span>`).join('')}</div>
      <div class="faint" style="font-size:12px;margin:14px 0 6px">Latest actions</div>
      <div class="staff-actions">${
        p.recent.map((e) => `<div class="list-row"><div class="grow"><div class="title">${esc(e.text)}</div><div class="sub">${esc(KIND_LABEL[e.kind] || e.kind)}${e.server ? ` · ${esc(e.server)}` : ''} · ${esc(fmtTime(e.at))}</div></div></div>`).join('') || '<div class="faint">No moderation actions recorded.</div>'
      }</div>`,
    actions: [{ label: 'Close', close: true }],
  });
}

/* -------------------------------------------------------------- reasons */

async function drawReasons(box) {
  const redraw = () => drawReasons(box);
  let list;
  try {
    list = (await api('/api/staff/reasons')).templates;
  } catch (err) {
    box.innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }
  if (!box.isConnected) return;
  box.innerHTML = `
    <div class="card mb-16"><div class="row" style="align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:220px"><h4 style="margin:0 0 4px">Ban and kick reasons</h4>
      <div class="faint" style="font-size:13px">Named reasons with a length and an optional appeal line, picked in the ban and kick dialogs on every server. Shared by all servers.</div></div>
      <button class="btn btn-primary" id="rs-new">New template</button></div></div>
    <div class="card card-flush"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Reason</th><th>Length</th><th>Appeal line</th><th></th></tr></thead>
      <tbody>${list
        .map(
          (t) => `<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(t.reason)}</td><td class="mono">${t.hours ? `${t.hours}h` : 'permanent'}</td><td class="faint">${esc(t.appeal)}</td>
            <td class="nowrap" style="text-align:right"><button class="btn btn-sm" data-rs-edit="${esc(t.id)}">Change</button> <button class="btn btn-sm btn-danger" data-rs-del="${esc(t.id)}">Delete</button></td></tr>`
        )
        .join('') || '<tr><td colspan="5" class="faint">No templates yet. Try "Griefing", 24 hours, "Appeal at example.com/appeal".</td></tr>'}</tbody>
    </table></div></div>`;
  const edit = (t) => {
    const modal = openModal({
      title: t ? 'Change template' : 'New template',
      width: 480,
      body: `<div class="form-grid">
        <label><span>Name</span><input id="rs-name" maxlength="40" value="${esc(t?.name || '')}" /></label>
        <label><span>Length in hours (0 = permanent)</span><input id="rs-hours" type="number" min="0" max="8760" value="${t?.hours || 0}" /></label></div>
        <label class="mt-8"><span>Reason players see</span><input id="rs-reason" maxlength="200" value="${esc(t?.reason || '')}" /></label>
        <label class="mt-8"><span>Appeal link text (optional, added to the reason)</span><input id="rs-appeal" maxlength="100" placeholder="Appeal at example.com/appeal" value="${esc(t?.appeal || '')}" /></label>`,
      actions: [
        { label: 'Cancel', close: true },
        {
          label: 'Save',
          primary: true,
          onClick: async (btn) => {
            btn.disabled = true;
            const body = { name: $('#rs-name').value, hours: Number($('#rs-hours').value) || 0, reason: $('#rs-reason').value, appeal: $('#rs-appeal').value };
            try {
              await api(t ? `/api/staff/reasons/${encodeURIComponent(t.id)}` : '/api/staff/reasons', { method: t ? 'PUT' : 'POST', body });
              forgetReasonTemplates();
              modal.close();
              redraw();
            } catch (err) {
              toast(err.message, 'error');
              btn.disabled = false;
            }
          },
        },
      ],
    });
  };
  $('#rs-new').addEventListener('click', () => edit(null));
  box.querySelectorAll('[data-rs-edit]').forEach((b) => b.addEventListener('click', () => edit(list.find((t) => t.id === b.dataset.rsEdit))));
  box.querySelectorAll('[data-rs-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmModal('Delete template', 'Bans already made keep their reason.', 'Delete'))) return;
      try {
        await api(`/api/staff/reasons/${encodeURIComponent(b.dataset.rsDel)}`, { method: 'DELETE' });
        forgetReasonTemplates();
        redraw();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

/* ---------------------------------------------------------------- roles */

async function drawRoles(box) {
  const redraw = () => drawRoles(box);
  let data;
  try {
    data = await api('/api/staff/roles');
  } catch (err) {
    box.innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }
  if (!box.isConnected) return;
  const label = (id) => data.capabilities.find((c) => c.id === id)?.label || id;
  box.innerHTML = `
    <div class="card mb-16"><div class="row" style="align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:220px"><h4 style="margin:0 0 4px">Role templates</h4>
      <div class="faint" style="font-size:13px">Bundles of permissions you can give a sub-user on a server in one click (Access tab of the server). Changing a template does not change people who already have it.</div></div>
      <button class="btn btn-primary" id="ro-new">New role</button></div></div>
    <div class="card card-flush"><div class="table-wrap"><table>
      <thead><tr><th>Role</th><th>Can do</th><th></th></tr></thead>
      <tbody>${data.roles
        .map(
          (r) => `<tr><td><strong>${esc(r.name)}</strong>${r.builtin ? ' <span class="badge">built in</span>' : ''}${r.modified ? ' <span class="badge">changed</span>' : ''}<div class="faint" style="font-size:12px">${esc(r.description)}</div></td>
            <td class="faint" style="font-size:13px">${esc(r.permissions.map(label).join(', '))}</td>
            <td class="nowrap" style="text-align:right"><button class="btn btn-sm" data-ro-edit="${esc(r.id)}">Change</button>
            ${!r.builtin || r.modified ? `<button class="btn btn-sm btn-danger" data-ro-del="${esc(r.id)}">${r.builtin ? 'Reset' : 'Delete'}</button>` : ''}</td></tr>`
        )
        .join('')}</tbody>
    </table></div></div>`;
  const edit = (r) => {
    const held = new Set(r?.permissions || []);
    const modal = openModal({
      title: r ? `Change ${esc(r.name)}` : 'New role',
      width: 560,
      body: `<label><span>Name</span><input id="ro-name" maxlength="40" value="${esc(r?.name || '')}" /></label>
        <label class="mt-8"><span>Description</span><input id="ro-desc" maxlength="140" value="${esc(r?.description || '')}" /></label>
        <div class="perm-grid mt-8">${data.capabilities.map((c) => `<label class="checkbox-row perm-row"><input type="checkbox" data-rcap="${esc(c.id)}" ${held.has(c.id) ? 'checked' : ''} /><span>${esc(c.label)}</span></label>`).join('')}</div>`,
      actions: [
        { label: 'Cancel', close: true },
        {
          label: 'Save',
          primary: true,
          onClick: async (btn) => {
            btn.disabled = true;
            const body = { name: $('#ro-name').value, description: $('#ro-desc').value, permissions: [...document.querySelectorAll('[data-rcap]')].filter((c) => c.checked).map((c) => c.dataset.rcap) };
            try {
              await api(r ? `/api/staff/roles/${encodeURIComponent(r.id)}` : '/api/staff/roles', { method: r ? 'PUT' : 'POST', body });
              modal.close();
              redraw();
            } catch (err) {
              toast(err.message, 'error');
              btn.disabled = false;
            }
          },
        },
      ],
    });
  };
  $('#ro-new').addEventListener('click', () => edit(null));
  box.querySelectorAll('[data-ro-edit]').forEach((b) => b.addEventListener('click', () => edit(data.roles.find((r) => r.id === b.dataset.roEdit))));
  box.querySelectorAll('[data-ro-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const r = data.roles.find((x) => x.id === b.dataset.roDel);
      if (!(await confirmModal(r.builtin ? 'Reset role' : 'Delete role', r.builtin ? 'It goes back to its original permissions.' : 'People who already have it keep their permissions.', r.builtin ? 'Reset' : 'Delete'))) return;
      try {
        await api(`/api/staff/roles/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
        redraw();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}
