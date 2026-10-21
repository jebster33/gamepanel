import { api } from '../../core/api.js';
import { esc, toast, can } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';

/* ------------------------------------------------ LuckPerms in the panel */

/*
 * Groups, users, permissions, weights, parents, prefixes/suffixes and meta
 * for servers with the LuckPerms plugin. State is read through `lp export`
 * and every change is one validated `lp ...` console command on the server.
 */

const ctxText = (c) => Object.entries(c || {}).map(([k, v]) => `${k}=${v}`).join(' ');
const parseCtx = (text) => {
  const out = {};
  for (const part of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    const [k, ...rest] = part.split('=');
    out[k] = rest.join('=');
  }
  return out;
};

export async function renderLuckPermsCard(host, server) {
  if (!can('command')) return;
  let info;
  try {
    info = await api(`/api/servers/${server.id}/luckperms`);
  } catch {
    return;
  }
  if (!info.supported || !info.installed) return;
  const base = `/api/servers/${server.id}/luckperms`;
  let data = null;
  let view = { type: 'group', name: 'default' };
  let tab = 'groups';
  let error = '';

  host.innerHTML = '<div class="card mb-16 mclp"></div>';
  const card = host.firstElementChild;

  async function load() {
    card.innerHTML = '<h4 style="margin:0 0 8px">Permissions (LuckPerms)</h4><div class="faint">Asking the server… this takes a second or two.</div>';
    try {
      data = await api(`${base}/data`);
      error = '';
    } catch (err) {
      data = null;
      error = err.message;
    }
    draw();
  }

  async function act(body, okText) {
    try {
      await api(`${base}/action`, { method: 'POST', body });
      if (okText) toast(okText);
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const entity = () => (view.type === 'group' ? data.groups.find((g) => g.name === view.name) : data.users.find((u) => (u.name || '').toLowerCase() === view.name.toLowerCase() || u.uuid === view.name)) || { permissions: [], parents: [], prefixes: [], suffixes: [], meta: [], weight: null };

  function panel() {
    const e = entity();
    const who = { type: view.type, name: view.name };
    const groupsOpt = data.groups.map((g) => `<option value="${esc(g.name)}">${esc(g.name)}</option>`).join('');
    return `
      <div class="mclp-head"><b>${view.type === 'group' ? 'Group' : 'Player'}: ${esc(view.name)}</b>${view.type === 'group' && view.name !== 'default' ? '<button class="btn btn-sm btn-danger" data-act="delgroup">Delete group</button>' : ''}</div>
      ${
        view.type === 'group'
          ? `<div class="row mclp-line"><label class="faint">Weight (higher wins)</label><input type="number" id="lp-weight" value="${e.weight ?? 0}" style="width:100px" /><button class="btn btn-sm" data-act="setweight">Set</button></div>`
          : ''
      }
      <div class="mclp-sec">Inherits from</div>
      <div class="mclp-chips">${e.parents.map((p) => `<span class="badge">${esc(p.group)}${p.context && Object.keys(p.context).length ? ` <span class="faint">${esc(ctxText(p.context))}</span>` : ''} <button class="mclp-x" data-rm-parent="${esc(p.group)}" aria-label="Remove ${esc(p.group)}">x</button></span>`).join('') || '<span class="faint">Nothing.</span>'}</div>
      <div class="row mclp-line"><select id="lp-parent">${groupsOpt}</select><button class="btn btn-sm" data-act="addparent">Add parent</button></div>
      <div class="mclp-sec">Prefix and suffix</div>
      ${[...e.prefixes.map((x) => ['prefix', x]), ...e.suffixes.map((x) => ['suffix', x])].map(([k, x]) => `<div class="mclp-row"><span class="faint">${k} ${x.priority}</span><span class="mono">${esc(x.text)}</span><button class="btn btn-sm btn-ghost" data-rm-meta="${k}:${x.priority}">Remove</button></div>`).join('') || '<div class="faint">None.</div>'}
      <div class="row mclp-line"><select id="lp-pkind"><option value="prefix">prefix</option><option value="suffix">suffix</option></select><input type="number" id="lp-ppri" value="100" style="width:80px" aria-label="Priority" /><input id="lp-ptext" placeholder="&amp;c[Admin] " maxlength="64" style="flex:1;min-width:0" /><button class="btn btn-sm" data-act="addprefix">Set</button></div>
      <div class="mclp-sec">Meta</div>
      ${e.meta.map((m) => `<div class="mclp-row"><span class="mono">${esc(m.key)}</span><span class="mono">${esc(m.value)}</span><button class="btn btn-sm btn-ghost" data-rm-key="${esc(m.key)}">Remove</button></div>`).join('') || '<div class="faint">None.</div>'}
      <div class="row mclp-line"><input id="lp-mkey" placeholder="key" maxlength="64" style="width:140px" /><input id="lp-mval" placeholder="value" maxlength="120" style="flex:1;min-width:0" /><button class="btn btn-sm" data-act="setmeta">Set</button></div>
      <div class="mclp-sec">Permissions</div>
      <div class="mclp-perms">${
        e.permissions
          .map(
            (p, i) => `<div class="mclp-row"><span class="mono" style="overflow-wrap:anywhere">${esc(p.node)}</span><span class="${p.value ? 'lime' : 'red'}">${p.value ? 'allow' : 'deny'}</span><span class="faint">${esc(ctxText(p.context))}${p.expiry ? ' temp' : ''}</span><span><button class="btn btn-sm btn-ghost" data-flip="${i}">${p.value ? 'Deny' : 'Allow'}</button> <button class="btn btn-sm btn-ghost" data-rm-perm="${i}">Remove</button></span></div>`
          )
          .join('') || '<div class="faint">No permissions set directly.</div>'
      }</div>
      <div class="row mclp-line"><input id="lp-node" placeholder="essentials.kick or worldedit.*" maxlength="200" style="flex:1;min-width:0" /><select id="lp-val"><option value="true">allow</option><option value="false">deny</option></select></div>
      <div class="row mclp-line"><input id="lp-ctx" placeholder="context (optional): server=survival world=world" maxlength="120" style="flex:1;min-width:0" /><input id="lp-dur" placeholder="for (7d)" maxlength="8" style="width:90px" /><button class="btn btn-sm btn-primary" data-act="addperm">Set permission</button></div>
      <div class="hint" style="margin-top:6px">${esc(who.type)} changes are sent as console commands; LuckPerms applies them at once for online players.</div>`;
  }

  function draw() {
    if (!data) {
      card.innerHTML = `<h4 style="margin:0 0 8px">Permissions (LuckPerms)</h4><div class="faint">${esc(error || 'Could not read LuckPerms.')}</div><div class="mt-8"><button class="btn btn-sm" id="lp-retry">Try again</button></div>`;
      card.querySelector('#lp-retry').addEventListener('click', load);
      return;
    }
    card.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
        <h4 style="margin:0">Permissions (LuckPerms)</h4>
        <div class="row" style="gap:6px"><button class="btn btn-sm ${tab === 'groups' ? 'btn-primary' : ''}" data-tab="groups">Groups</button><button class="btn btn-sm ${tab === 'users' ? 'btn-primary' : ''}" data-tab="users">Players</button><button class="btn btn-sm btn-ghost" id="lp-refresh">Refresh</button></div>
      </div>
      <div class="mclp-layout">
        <div class="mclp-list">
          ${
            tab === 'groups'
              ? `${data.groups.map((g) => `<button class="mclp-item ${view.type === 'group' && view.name === g.name ? 'sel' : ''}" data-pick="group:${esc(g.name)}"><span>${esc(g.name)}</span><span class="faint">${g.weight ?? ''}</span></button>`).join('')}
                 <div class="row" style="gap:6px;margin-top:8px"><input id="lp-newgroup" placeholder="new group" maxlength="36" style="flex:1;min-width:0" /><button class="btn btn-sm" id="lp-addgroup">Add</button></div>`
              : `<div class="row" style="gap:6px;margin-bottom:8px"><input id="lp-user" placeholder="player name" maxlength="36" style="flex:1;min-width:0" /><button class="btn btn-sm" id="lp-openuser">Open</button></div>
                 ${data.users.map((u) => `<button class="mclp-item ${view.type === 'user' && (view.name === u.name || view.name === u.uuid) ? 'sel' : ''}" data-pick="user:${esc(u.name || u.uuid)}"><span>${esc(u.name || u.uuid)}</span><span class="faint">${esc(u.primaryGroup)}</span></button>`).join('') || '<div class="faint">No players with their own settings yet.</div>'}
                 ${data.userCount > data.users.length ? `<div class="faint" style="font-size:12px">Showing ${data.users.length} of ${data.userCount}. Use Open for others.</div>` : ''}`
          }
        </div>
        <div class="mclp-detail">${panel()}</div>
      </div>`;
    wire();
  }

  function wire() {
    const q = (s) => card.querySelector(s);
    const who = () => ({ type: view.type, name: view.name });
    card.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab;
        view = tab === 'groups' ? { type: 'group', name: data.groups[0]?.name || 'default' } : data.users[0] ? { type: 'user', name: data.users[0].name || data.users[0].uuid } : { type: 'user', name: '' };
        draw();
      })
    );
    q('#lp-refresh').addEventListener('click', load);
    card.querySelectorAll('[data-pick]').forEach((b) =>
      b.addEventListener('click', () => {
        const [type, ...rest] = b.dataset.pick.split(':');
        view = { type, name: rest.join(':') };
        draw();
      })
    );
    q('#lp-addgroup')?.addEventListener('click', () => {
      const name = q('#lp-newgroup').value.trim();
      if (!name) return;
      view = { type: 'group', name: name.toLowerCase() };
      act({ action: 'group.create', name }, 'Group created');
    });
    q('#lp-openuser')?.addEventListener('click', () => {
      const name = q('#lp-user').value.trim();
      if (!name) return;
      view = { type: 'user', name };
      draw();
    });
    card.querySelector('[data-act="delgroup"]')?.addEventListener('click', async () => {
      if (!(await confirmModal('Delete group', `Delete ${view.name}? Players in it lose its permissions.`, 'Delete'))) return;
      const name = view.name;
      view = { type: 'group', name: 'default' };
      act({ action: 'group.delete', name }, 'Group deleted');
    });
    card.querySelector('[data-act="setweight"]')?.addEventListener('click', () => act({ action: 'weight.set', name: view.name, weight: Number(q('#lp-weight').value) }, 'Weight set'));
    card.querySelector('[data-act="addparent"]')?.addEventListener('click', () => act({ action: 'parent.add', ...who(), parent: q('#lp-parent').value }, 'Parent added'));
    card.querySelectorAll('[data-rm-parent]').forEach((b) => b.addEventListener('click', () => act({ action: 'parent.remove', ...who(), parent: b.dataset.rmParent })));
    card.querySelector('[data-act="addprefix"]')?.addEventListener('click', () => act({ action: `${q('#lp-pkind').value}.set`, ...who(), priority: Number(q('#lp-ppri').value), text: q('#lp-ptext').value }, 'Saved'));
    card.querySelectorAll('[data-rm-meta]').forEach((b) => {
      const [kind, pri] = b.dataset.rmMeta.split(':');
      b.addEventListener('click', () => act({ action: `${kind}.remove`, ...who(), priority: Number(pri) }));
    });
    card.querySelector('[data-act="setmeta"]')?.addEventListener('click', () => act({ action: 'meta.set', ...who(), key: q('#lp-mkey').value.trim(), value: q('#lp-mval').value }, 'Saved'));
    card.querySelectorAll('[data-rm-key]').forEach((b) => b.addEventListener('click', () => act({ action: 'meta.unset', ...who(), key: b.dataset.rmKey })));
    card.querySelector('[data-act="addperm"]')?.addEventListener('click', () =>
      act({ action: 'permission.set', ...who(), node: q('#lp-node').value.trim(), value: q('#lp-val').value === 'true', context: parseCtx(q('#lp-ctx').value), duration: q('#lp-dur').value.trim() || undefined }, 'Permission set')
    );
    const perms = entity().permissions;
    card.querySelectorAll('[data-flip]').forEach((b) => {
      const p = perms[Number(b.dataset.flip)];
      b.addEventListener('click', () => act({ action: 'permission.set', ...who(), node: p.node, value: !p.value, context: p.context }));
    });
    card.querySelectorAll('[data-rm-perm]').forEach((b) => {
      const p = perms[Number(b.dataset.rmPerm)];
      b.addEventListener('click', () => act({ action: 'permission.unset', ...who(), node: p.node, context: p.context }));
    });
  }

  if (['running'].includes(server.status)) load();
  else card.innerHTML = '<h4 style="margin:0 0 8px">Permissions (LuckPerms)</h4><div class="faint">LuckPerms is installed. Start the server to edit groups and permissions here; the panel talks to it through the console.</div>';
}
