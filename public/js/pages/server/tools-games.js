import { api } from '../../core/api.js';
import { can, esc, fmtTime } from '../../core/util.js';
import { state } from '../../core/state.js';
import { section, attempt, table, mb, field } from './tools-kit.js';

/* ---------------------------------------------- per-game cards on the Tools tab */

export function gameSections(server) {
  if (server.node) return [];
  const base = `/api/servers/${server.id}`;
  const id = server.templateId;
  return [
    id === 'rust' && can('schedules') && wipePlanSection(server, base),
    id === 'fivem' && can('files') && fivemSection(base),
    id === 'dayz' && can('files') && dayzSection(base),
    id === 'valheim' && can('settings') && valheimSection(base),
    id === 'factorio' && can('files') && factorioSection(server, base),
    id === 'unturned' && can('files') && unturnedSection(base),
    id === 'arma-reforger' && can('settings') && reforgerSection(base),
  ].filter(Boolean);
}

const day = (t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/* ------------------------------------------------------------- Rust wipe plan */

function wipePlanSection(server, base) {
  return {
    id: 'wipe-plan',
    title: 'Forced wipe plan',
    lead: 'Wipes that follow Rust’s monthly update',
    load: async (body) => {
      const d = await api('/api/calendar/forced-wipes');
      body.innerHTML = `<div class="hint">${esc(d.rule)}. Upcoming:</div>
        ${table(['When (your time)'], d.wipes.slice(0, 5).map((t) => [esc(day(t))]))}
        <div class="row wrap gap-8 mt-8">
          ${field('Wipes per month', '<select id="wp-cad"><option value="monthly">Monthly (forced wipe day)</option><option value="biweekly">Twice a month</option><option value="weekly">Weekly</option></select>')}
          ${field('Hours after the update', '<input id="wp-off" type="number" min="0" max="24" value="1">', 'Rust ships the update first; the wipe must come after it.')}
          <button class="btn primary" id="wp-go">Add these schedules</button>
        </div>
        <div class="hint mt-8">Creates schedules on this server. Edit or remove them on the Schedules tab.</div>`;
      body.querySelector('#wp-go').onclick = async () => {
        const r = await attempt(() => api(`${base}/wipe-plan`, { method: 'POST', body: { cadence: body.querySelector('#wp-cad').value, offsetHours: Number(body.querySelector('#wp-off').value) } }));
        if (r) body.insertAdjacentHTML('beforeend', `<div class="hint">Added ${r.schedules.length} schedule(s).</div>`);
      };
    },
  };
}

/* --------------------------------------------------------------------- FiveM */

function fivemSection(base) {
  return {
    id: 'fivem-resources',
    title: 'Resources and txAdmin',
    lead: 'Turn resources on and off',
    load: async (body) => {
      const render = async () => {
        const d = await api(`${base}/fivem/resources`);
        const tx = d.txadmin && d.txadminPort ? `<div class="hint">txAdmin: <a href="${esc(`http://${location.hostname}:${d.txadminPort}`)}" target="_blank" rel="noopener">open on port ${d.txadminPort}</a> (first start asks for the PIN in the console).</div>` : '';
        body.innerHTML = `${tx}${d.note ? `<div class="hint">${esc(d.note)}</div>` : ''}${table(
          ['Resource', 'Version', 'Folder', 'On'],
          d.items.map((r) => [`<b>${esc(r.name)}</b>${r.description ? `<div class="faint">${esc(r.description)}</div>` : ''}`, esc(r.version || ''), esc(r.category || ''), `<input type="checkbox" data-r="${esc(r.name)}" ${r.enabled ? 'checked' : ''} ${can('files.write') && !d.note ? '' : 'disabled'}>`]),
          { empty: 'No resources found in server-data/resources.' }
        )}<div class="hint mt-8">Changes server.cfg (<span class="mono">ensure name</span>). Restart the server to apply.</div>`;
        body.querySelectorAll('[data-r]').forEach((c) => (c.onchange = async () => {
          if (await attempt(() => api(`${base}/fivem/resources/${encodeURIComponent(c.dataset.r)}`, { method: 'PUT', body: { enabled: c.checked } }))) render().catch(() => {});
          else c.checked = !c.checked;
        }));
      };
      await render();
    },
  };
}

/* ---------------------------------------------------------------------- DayZ */

function dayzSection(base) {
  return {
    id: 'dayz-loot',
    title: 'Loot table (types.xml)',
    lead: 'How much of each item spawns',
    load: async (body) => {
      let q = '';
      let page = 0;
      const render = async () => {
        const d = await api(`${base}/dayz/types?q=${encodeURIComponent(q)}&page=${page}`);
        body.innerHTML = `<form class="row gap-8" id="dz-f"><input name="q" placeholder="Search items" value="${esc(q)}"><button class="btn">Search</button></form>
          ${table(['Item', 'Nominal', 'Min', 'Lifetime (s)', 'Restock (s)', ''], d.items.map((t) => [`<span class="mono">${esc(t.name)}</span>`, ...['nominal', 'min', 'lifetime', 'restock'].map((f) => `<input type="number" class="dz-n" data-f="${f}" data-n="${esc(t.name)}" value="${t[f] ?? ''}" style="width:90px" ${can('files.write') ? '' : 'disabled'}>`), `<button class="btn btn-sm" data-save="${esc(t.name)}" ${can('files.write') ? '' : 'disabled'}>Save</button>`]), { empty: 'No items match.' })}
          <div class="row gap-8 mt-8"><button class="btn btn-sm" id="dz-prev" ${page ? '' : 'disabled'}>Previous</button><span class="faint">${d.matches} item(s) · page ${page + 1}</span><button class="btn btn-sm" id="dz-next" ${(page + 1) * 60 < d.matches ? '' : 'disabled'}>Next</button></div>
          <div class="hint mt-8">Nominal is the target count on the map. Stop the server before editing, or the game may overwrite it. A backup is kept as types.xml.gamepanel-backup. ${esc(d.file)}</div>`;
        body.querySelector('#dz-f').onsubmit = (e) => {
          e.preventDefault();
          q = e.target.q.value;
          page = 0;
          render().catch(() => {});
        };
        body.querySelector('#dz-prev').onclick = () => (page--, render());
        body.querySelector('#dz-next').onclick = () => (page++, render());
        body.querySelectorAll('[data-save]').forEach((b) => (b.onclick = async () => {
          const fields = {};
          body.querySelectorAll(`.dz-n[data-n="${CSS.escape(b.dataset.save)}"]`).forEach((i) => i.value !== '' && (fields[i.dataset.f] = Number(i.value)));
          await attempt(() => api(`${base}/dayz/types/${encodeURIComponent(b.dataset.save)}`, { method: 'PUT', body: fields }), 'Saved');
        }));
      };
      await render();
    },
  };
}

/* ------------------------------------------------------------------- Valheim */

function valheimSection(base) {
  return {
    id: 'valheim-modifiers',
    title: 'World modifiers',
    lead: 'Combat, death penalty, resources, raids, portals',
    load: async (body) => {
      const d = await api(`${base}/valheim/modifiers`);
      const label = { combat: 'Combat', deathpenalty: 'Death penalty', resources: 'Resources', raids: 'Raids', portals: 'Portals' };
      const keyLabel = { nobuildcost: 'No build cost', playerevents: 'Player events', passivemobs: 'Passive mobs', nomap: 'No map' };
      body.innerHTML = `<div class="row wrap gap-8">${Object.entries(d.options).map(([k, opts]) => field(label[k] || k, `<select data-m="${k}"><option value="">Default (${esc(d.preset)} preset)</option>${opts.map((o) => `<option ${d.modifiers[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`)).join('')}</div>
        <div class="row wrap gap-8 mt-8">${d.keyOptions.map((k) => `<label><input type="checkbox" data-k="${k}" ${d.keys.includes(k) ? 'checked' : ''}> ${esc(keyLabel[k] || k)}</label>`).join('')}</div>
        <div class="row gap-8 mt-8"><button class="btn primary" id="vm-save">Save</button></div>
        <div class="hint mt-8">These are launch arguments and apply on the next start. A modifier overrides the difficulty preset.</div>`;
      body.querySelector('#vm-save').onclick = () => {
        const modifiers = {};
        body.querySelectorAll('[data-m]').forEach((s) => s.value && (modifiers[s.dataset.m] = s.value));
        const keys = [...body.querySelectorAll('[data-k]:checked')].map((c) => c.dataset.k);
        attempt(() => api(`${base}/valheim/modifiers`, { method: 'PUT', body: { modifiers, keys } }), 'Saved. Restart the server to apply it.');
      };
    },
  };
}

/* ------------------------------------------------------------------- Factorio */

function factorioSection(server, base) {
  return {
    id: 'factorio-saves',
    title: 'Saves',
    lead: 'Choose the save the server loads',
    load: async (body) => {
      const render = async () => {
        const d = await api(`${base}/factorio/saves`);
        body.innerHTML = `${table(['Save', 'Size', 'Changed', ''], d.saves.map((s) => [`<b>${esc(s.name)}</b>${s.autosave ? ' <span class="faint">autosave</span>' : ''}`, mb(s.size), esc(fmtTime ? fmtTime(s.modified) : new Date(s.modified).toLocaleString()), s.active ? '<span class="badge ok">In use</span>' : `<button class="btn btn-sm" data-use="${esc(s.name)}" ${can('files.write') ? '' : 'disabled'}>Use this</button>`]), { empty: 'No saves yet. The server creates one on first start.' })}
          <div class="hint mt-8">Stop the server to switch. Mods are managed on the Mods tab (Factorio mod portal).</div>`;
        body.querySelectorAll('[data-use]').forEach((b) => (b.onclick = async () => {
          if (await attempt(() => api(`${base}/factorio/saves`, { method: 'PUT', body: { name: b.dataset.use } }), 'Save selected')) render().catch(() => {});
        }));
      };
      await render();
    },
  };
}

/* ------------------------------------------------------------------- Unturned */

function unturnedSection(base) {
  return {
    id: 'unturned-frameworks',
    title: 'RocketMod / OpenMod',
    lead: 'Plugin frameworks',
    load: async (body) => {
      const render = async () => {
        const d = await api(`${base}/unturned/frameworks`);
        const admin = state.user.role === 'admin';
        body.innerHTML = `${table(['Framework', 'About', ''], d.frameworks.map((f) => [`<b>${esc(f.label)}</b>`, esc(f.note), f.installed ? '<span class="badge ok">Installed</span>' : `<button class="btn btn-sm" data-i="${f.id}" ${admin ? '' : 'disabled title="Admins only"'}>Install latest</button>`]))}
          <div class="hint mt-8">Downloads the latest release from GitHub into Modules/. Stop the server first. Workshop maps and items are on the Mods tab.</div>`;
        body.querySelectorAll('[data-i]').forEach((b) => (b.onclick = async () => {
          b.disabled = true;
          if (await attempt(() => api(`${base}/unturned/frameworks`, { method: 'POST', body: { id: b.dataset.i } }), 'Installed')) render().catch(() => {});
          else b.disabled = false;
        }));
      };
      await render();
    },
  };
}

/* ----------------------------------------------------------------- Arma Reforger */

function reforgerSection(base) {
  return {
    id: 'reforger',
    title: 'Scenario and mods',
    lead: 'Pick a scenario, add Workshop mods',
    load: async (body) => {
      const d = await api(`${base}/reforger`);
      let mods = d.mods.map((m) => ({ ...m }));
      const draw = () => {
        const known = d.scenarios.some((s) => s.id === d.scenario);
        body.innerHTML = `<div class="row wrap gap-8">
            ${field('Scenario', `<select id="rf-sc">${d.scenarios.map((s) => `<option value="${esc(s.id)}" ${s.id === d.scenario ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}<option value="__custom" ${known ? '' : 'selected'}>Other…</option></select>`)}
            ${field('Scenario id', `<input id="rf-id" value="${esc(d.scenario)}" style="min-width:320px">`, 'From the mod’s Workshop page for custom scenarios.')}
            <button class="btn" id="rf-sc-save">Save scenario</button></div>
          <h4 class="mt-8">Mods</h4>
          ${table(['Mod', 'Id', 'Version', ''], mods.map((m, i) => [esc(m.name), `<span class="mono">${esc(m.modId)}</span>`, esc(m.version || 'latest'), `<button class="btn btn-sm" data-rm="${i}">Remove</button>`]), { empty: 'No mods. Players get the base game.' })}
          <div class="row wrap gap-8 mt-8">${field('Mod id', '<input id="rf-mid" placeholder="591AF5BDA9F7CE8B">')}${field('Name', '<input id="rf-mn">')}${field('Version (optional)', '<input id="rf-mv" placeholder="1.2.3">')}<button class="btn" id="rf-add">Add</button></div>
          <div class="row gap-8 mt-8"><button class="btn primary" id="rf-save">Save mods</button></div>
          <div class="hint mt-8">Find the id on reforger.armaplatform.com/workshop (the 16 characters in the address). Applied to config.json on the next start; the server downloads the mods itself.</div>`;
        body.querySelector('#rf-sc').onchange = (e) => e.target.value !== '__custom' && (body.querySelector('#rf-id').value = e.target.value);
        body.querySelector('#rf-sc-save').onclick = () => attempt(() => api(`${base}/reforger`, { method: 'PUT', body: { scenario: body.querySelector('#rf-id').value } }), 'Saved').then((r) => r && (d.scenario = body.querySelector('#rf-id').value));
        body.querySelector('#rf-add').onclick = () => {
          const modId = body.querySelector('#rf-mid').value.trim();
          if (!modId) return;
          mods.push({ modId, name: body.querySelector('#rf-mn').value.trim() || modId, version: body.querySelector('#rf-mv').value.trim() || undefined });
          draw();
        };
        body.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => (mods.splice(Number(b.dataset.rm), 1), draw())));
        body.querySelector('#rf-save').onclick = async () => {
          const r = await attempt(() => api(`${base}/reforger`, { method: 'PUT', body: { mods } }), 'Saved. Restart the server to apply it.');
          if (r && r.mods) mods = r.mods.map((m) => ({ ...m }));
        };
      };
      draw();
    },
  };
}
