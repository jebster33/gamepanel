import { api } from '../../core/api.js';
import { esc, toast, can } from '../../core/util.js';
import { state } from '../../core/state.js';

/* ------------------------------------------------------------ ARK tab -- */

/*
 * Four tools on one tab: mod load order, level cap and engrams, supply crate
 * loot and give item. Each section loads and saves on its own.
 */

const SECTIONS = [
  ['mods', 'Mod order', () => can('mods'), renderMods],
  ['levels', 'Levels & engrams', () => can('settings'), renderLevels],
  ['crates', 'Supply crates', () => can('settings'), renderCrates],
  ['give', 'Give item', () => can('command'), renderGive],
  ['diff', 'Changed settings', () => can('files'), renderDiff],
];
let current = 'mods';

export function renderArkTab(host, server) {
  const sections = SECTIONS.filter(([, , allowed]) => allowed());
  if (!sections.some(([k]) => k === current)) current = sections[0]?.[0];
  host.innerHTML = `
    <div class="ark-sub" role="tablist">${sections.map(([k, label]) => `<button class="ark-subtab ${k === current ? 'active' : ''}" role="tab" aria-selected="${k === current}" data-sec="${k}">${label}</button>`).join('')}</div>
    <div id="ark-body"></div>`;
  host.querySelectorAll('[data-sec]').forEach((b) =>
    b.addEventListener('click', () => {
      current = b.dataset.sec;
      renderArkTab(host, server);
    })
  );
  const body = host.querySelector('#ark-body');
  const section = sections.find(([k]) => k === current);
  if (section) section[3](body, server);
}

const base = (server) => `/api/servers/${encodeURIComponent(server.id)}/ark`;
const running = (server) => ['running', 'starting'].includes(state.servers.find((s) => s.id === server.id)?.status || server.status);
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);

/** Set obj[a][b][c] from the path "a.b.c" (numbers index arrays). */
function setPath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let node = obj;
  for (const p of parts) node = node[p];
  node[last] = value;
}

/* ------------------------------------------------------------ mod order -- */

async function renderMods(host, server) {
  host.innerHTML = '<div class="card faint">Loading…</div>';
  let data;
  try {
    data = await api(`${base(server)}/mods`);
  } catch (err) {
    host.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  let mods = data.mods.map((m) => ({ ...m }));
  let dirty = false;
  const draw = (announce = '') => {
    host.innerHTML = `
      <div class="card">
        <h4>Mod load order</h4>
        <p class="faint">ARK loads mods from the top down, and a mod lower in the list can override one above it. Drag a row, or use the arrow buttons. Saved to ${esc(data.applied)}.${data.game === 'ase' && running(server) ? ' <b>Stop the server before saving.</b>' : ' Restart the server to apply it.'}</p>
        ${data.game === 'asa' ? '<form id="ark-mod-find" class="row gap-8" style="margin-bottom:8px"><input name="q" placeholder="Search CurseForge for ASA mods"><button class="btn">Search</button></form><div id="ark-mod-results" style="margin-bottom:12px"></div>' : ''}
        <div class="ark-list" id="ark-mods" role="list">${
          mods.length
            ? mods
                .map(
                  (m, i) => `<div class="ark-row" role="listitem" draggable="true" data-i="${i}">
              <span class="ark-handle" aria-hidden="true">⠿</span><span class="mono faint">${i + 1}</span>
              <div class="grow"><b>${esc(m.name || 'Mod ' + m.id)}</b> <span class="mono faint">${esc(m.id)}</span></div>
              <button class="btn btn-sm btn-ghost" data-up="${i}" aria-label="Move ${esc(m.name || m.id)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="btn btn-sm btn-ghost" data-down="${i}" aria-label="Move ${esc(m.name || m.id)} down" ${i === mods.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="btn btn-sm btn-ghost btn-danger" data-rm="${i}" aria-label="Remove ${esc(m.name || m.id)} from the list">✕</button></div>`
                )
                .join('')
            : '<div class="faint" style="padding:12px">No mods in the list.</div>'
        }</div>
        <div class="input-row mt-16"><input id="ark-mod-id" inputmode="numeric" placeholder="Mod ID (a number)" aria-label="Mod ID" /><button class="btn" id="ark-mod-add">Add</button></div>
        <div class="row mt-16"><button class="btn btn-primary" id="ark-mod-save" ${dirty ? '' : 'disabled'}>Save order</button></div>
        <div class="sr-only" aria-live="polite">${esc(announce)}</div>
      </div>`;
    const move = (i, to) => {
      if (to < 0 || to >= mods.length) return;
      mods.splice(to, 0, mods.splice(i, 1)[0]);
      dirty = true;
      draw(`Moved to position ${to + 1}`);
      host.querySelector(`[data-${to > i ? 'down' : 'up'}="${to}"]`)?.focus();
    };
    host.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => move(+b.dataset.up, +b.dataset.up - 1)));
    host.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => move(+b.dataset.down, +b.dataset.down + 1)));
    host.querySelectorAll('[data-rm]').forEach((b) =>
      b.addEventListener('click', () => {
        mods.splice(+b.dataset.rm, 1);
        dirty = true;
        draw('Removed');
      })
    );
    let from = null;
    host.querySelectorAll('.ark-row').forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        from = +row.dataset.i;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(from));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.classList.add('over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (from !== null && from !== +row.dataset.i) move(from, +row.dataset.i);
        from = null;
      });
    });
    const find = host.querySelector('#ark-mod-find');
    if (find) {
      find.addEventListener('submit', async (e) => {
        e.preventDefault();
        const out = host.querySelector('#ark-mod-results');
        out.innerHTML = '<span class="spinner"></span>';
        try {
          const r = await api(`${base(server)}/mods/search?q=${encodeURIComponent(find.q.value)}`);
          out.innerHTML = r.items.length
            ? r.items.map((m) => `<div class="row gap-8" style="align-items:center;padding:4px 0">${m.icon ? `<img src="${esc(m.icon)}" width="32" height="32" alt="" style="border-radius:6px">` : ''}<div style="flex:1;min-width:0"><b>${esc(m.name)}</b> <span class="faint">${esc(m.author)} · ID ${esc(m.id)} · ${Number(m.downloads).toLocaleString()} downloads</span><div class="faint" style="font-size:12px">${esc(m.summary || '')}</div></div><button class="btn btn-sm" data-add="${esc(m.id)}" data-name="${esc(m.name)}" ${mods.some((x) => x.id === m.id) ? 'disabled' : ''}>Add</button></div>`).join('')
            : '<div class="faint">Nothing found.</div>';
          out.querySelectorAll('[data-add]').forEach((b) =>
            b.addEventListener('click', () => {
              mods.push({ id: b.dataset.add, name: b.dataset.name });
              dirty = true;
              draw('Added');
            })
          );
        } catch (err) {
          out.innerHTML = `<div class="faint">${esc(err.message)}</div>`;
        }
      });
    }
    host.querySelector('#ark-mod-add').addEventListener('click', () => {
      const input = host.querySelector('#ark-mod-id');
      const id = input.value.trim();
      if (!/^\d{1,12}$/.test(id)) return toast('A mod ID is a number', 'error');
      if (mods.some((m) => m.id === id)) return toast('That mod is already in the list', 'error');
      mods.push({ id, name: null });
      dirty = true;
      draw('Added');
    });
    host.querySelector('#ark-mod-save').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api(`${base(server)}/mods`, { method: 'PUT', body: { mods: mods.map((m) => m.id) } });
        data = r;
        mods = r.mods.map((m) => ({ ...m }));
        dirty = false;
        draw();
        toast(r.restartNeeded ? 'Saved. Restart the server to apply it.' : 'Saved');
      } catch (err) {
        toast(err.message, 'error');
        e.currentTarget.disabled = false;
      }
    });
  };
  draw();
}

/* ------------------------------------------------------ levels & engrams -- */

async function renderLevels(host, server) {
  host.innerHTML = '<div class="card faint">Loading…</div>';
  let data;
  try {
    data = await api(`${base(server)}/levels`);
  } catch (err) {
    host.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  const v = data.values;
  const side = (r, fallback) => ({ on: Boolean(r), cap: r?.cap || fallback, first: r?.ramp?.[0] || 5, curve: 2.4, text: r ? r.ramp.join(', ') : '' });
  const s = {
    player: side(v.player, 105),
    dino: side(v.dino, 150),
    points: { text: v.engramPoints ? v.engramPoints.join(', ') : '', on: Boolean(v.engramPoints), per: 10, every: 0, bonus: 0 },
    engrams: v.engrams.map((e) => ({ ...e })),
    unlocks: v.autoUnlocks.map((e) => ({ ...e })),
    only: v.onlyAllowSpecified,
  };
  const list = (text) => text.split(/[\s,]+/).filter(Boolean).map(Number);
  const xpBlock = (key, label) => {
    const x = s[key];
    return `<div class="ark-block"><label class="checkbox-row"><input type="checkbox" data-on="${key}" ${x.on ? 'checked' : ''} /><span>${label} level cap</span></label>
      <div class="${x.on ? '' : 'ark-off'}"><div class="form-grid">
        <label><span>Max level</span><input type="number" min="2" max="${data.maxLevel}" data-f="${key}.cap" value="${x.cap}" /></label>
        <label><span>XP for level 2</span><input type="number" min="1" data-f="${key}.first" value="${x.first}" /></label>
        <label><span>XP for the max level <em class="faint">(blank = suggest)</em></span><input type="number" min="1" data-f="${key}.final" value="${x.text ? list(x.text).at(-1) : ''}" /></label>
        <label><span>Curve (1 straight, higher = steeper end)</span><input type="number" step="0.1" min="0.5" max="6" data-f="${key}.curve" value="${x.curve}" /></label></div>
      <button class="btn btn-sm" data-gen="${key}">Generate XP list</button>
      <label class="mt-16"><span>XP needed for each level from 2 up (${x.text ? list(x.text).length : 0} levels)</span><textarea rows="3" data-f="${key}.text">${esc(x.text)}</textarea></label></div></div>`;
  };
  const engramRow = (e, i) =>
    e.raw
      ? `<div class="ark-row"><div class="grow mono" style="font-size:12px;word-break:break-all">${esc(e.raw)}</div><span class="faint">kept as is</span><button class="btn btn-sm btn-ghost btn-danger" data-rme="${i}" aria-label="Remove this engram line">✕</button></div>`
      : `<div class="ark-row ark-wrap"><input list="ark-engrams" data-f="engrams.${i}.className" value="${esc(e.className)}" placeholder="EngramEntry_Campfire_C" aria-label="Engram class" style="flex:2;min-width:200px" />
        <label class="ark-mini"><span>Points</span><input type="number" min="0" data-f="engrams.${i}.cost" value="${e.cost}" /></label>
        <label class="ark-mini"><span>Level</span><input type="number" min="0" data-f="engrams.${i}.level" value="${e.level}" /></label>
        <label class="checkbox-row"><input type="checkbox" data-f="engrams.${i}.hidden" ${e.hidden ? 'checked' : ''} /><span>Hidden</span></label>
        <label class="checkbox-row"><input type="checkbox" data-f="engrams.${i}.removePrereq" ${e.removePrereq ? 'checked' : ''} /><span>No prerequisite</span></label>
        <button class="btn btn-sm btn-ghost btn-danger" data-rme="${i}" aria-label="Remove engram">✕</button></div>`;
  const unlockRow = (e, i) =>
    e.raw
      ? `<div class="ark-row"><div class="grow mono" style="font-size:12px;word-break:break-all">${esc(e.raw)}</div><span class="faint">kept as is</span><button class="btn btn-sm btn-ghost btn-danger" data-rmu="${i}" aria-label="Remove this line">✕</button></div>`
      : `<div class="ark-row ark-wrap"><input list="ark-engrams" data-f="unlocks.${i}.className" value="${esc(e.className)}" placeholder="EngramEntry_Spear_C" aria-label="Engram class" style="flex:2;min-width:200px" />
        <label class="ark-mini"><span>Unlocks at level</span><input type="number" min="0" data-f="unlocks.${i}.level" value="${e.level}" /></label>
        <button class="btn btn-sm btn-ghost btn-danger" data-rmu="${i}" aria-label="Remove">✕</button></div>`;
  const draw = () => {
    host.innerHTML = `
      <div class="card">
        <h4>Level cap and engrams</h4>
        <p class="faint">Writes the overrides to <span class="mono">Game.ini</span>: a higher player or dino level cap, how much XP each level takes, and how many engram points each level gives. ${data.exists ? '' : 'Game.ini does not exist yet; it is created on save. '}Restart the server to apply it.${data.running ? ' The server is running now.' : ''}</p>
        ${v.unreadable ? '<div class="filter-note mb-16">An existing XP ramp line could not be read and will be replaced if you turn that cap on.</div>' : ''}
        ${xpBlock('player', 'Player')}${xpBlock('dino', 'Dino')}
        <div class="ark-block"><label class="checkbox-row"><input type="checkbox" data-on="points" ${s.points.on ? 'checked' : ''} /><span>Engram points per level</span></label>
          <div class="${s.points.on ? '' : 'ark-off'}"><div class="form-grid">
            <label><span>Points per level</span><input type="number" min="0" data-f="points.per" value="${s.points.per}" /></label>
            <label><span>Bonus every N levels (0 = none)</span><input type="number" min="0" data-f="points.every" value="${s.points.every}" /></label>
            <label><span>Bonus points</span><input type="number" min="0" data-f="points.bonus" value="${s.points.bonus}" /></label></div>
          <button class="btn btn-sm" data-gen="points">Generate for the player cap</button>
          <label class="mt-16"><span>Points for level 1, 2, 3...</span><textarea rows="2" data-f="points.text">${esc(s.points.text)}</textarea></label></div></div>
        <div class="ark-block"><div class="card-head"><h4>Engram changes</h4><div class="spacer"></div><button class="btn btn-sm" id="ark-add-e">Add engram</button></div>
          <div class="ark-list">${s.engrams.map(engramRow).join('') || '<div class="faint" style="padding:12px">No changes.</div>'}</div>
          <label class="checkbox-row"><input type="checkbox" data-f="only" ${s.only ? 'checked' : ''} /><span>Only allow the engrams listed above</span></label></div>
        <div class="ark-block"><div class="card-head"><h4>Engrams unlocked automatically</h4><div class="spacer"></div><button class="btn btn-sm" id="ark-add-u">Add</button></div>
          <div class="ark-list">${s.unlocks.map(unlockRow).join('') || '<div class="faint" style="padding:12px">None.</div>'}</div></div>
        <datalist id="ark-engrams">${data.suggestions.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
        <div class="hint">Engram class names look like EngramEntry_Campfire_C. The ARK wiki lists them. Not tested against a live server: check the result in game.</div>
        <div class="row mt-16"><button class="btn btn-primary" id="ark-lv-save">Save</button></div>
      </div>`;
    host.querySelectorAll('[data-f]').forEach((el) =>
      el.addEventListener('change', () => {
        const val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? num(el.value, '') : el.value;
        setPath(s, el.dataset.f, val);
        if (el.dataset.f.endsWith('.text') || el.dataset.f.endsWith('.final')) draw();
      })
    );
    host.querySelectorAll('[data-on]').forEach((el) =>
      el.addEventListener('change', () => {
        s[el.dataset.on].on = el.checked;
        draw();
      })
    );
    host.querySelectorAll('[data-gen]').forEach((b) =>
      b.addEventListener('click', async () => {
        const key = b.dataset.gen;
        try {
          if (key === 'points') {
            const cap = s.player.on ? s.player.cap : v.player?.cap || 105;
            s.points.text = (await api(`${base(server)}/levels/preview`, { method: 'POST', body: { kind: 'points', cap, perLevel: s.points.per, bonusEvery: s.points.every, bonus: s.points.bonus } })).points.join(', ');
          } else {
            const x = s[key];
            const finalEl = host.querySelector(`[data-f="${key}.final"]`);
            const r = await api(`${base(server)}/levels/preview`, { method: 'POST', body: { cap: x.cap, firstXp: x.first, finalXp: finalEl.value ? Number(finalEl.value) : undefined, curve: x.curve } });
            x.text = r.ramp.join(', ');
          }
          draw();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
    host.querySelector('#ark-add-e').addEventListener('click', () => {
      s.engrams.push({ className: '', cost: 0, level: 0, hidden: false, removePrereq: false });
      draw();
    });
    host.querySelector('#ark-add-u').addEventListener('click', () => {
      s.unlocks.push({ className: '', level: 1 });
      draw();
    });
    host.querySelectorAll('[data-rme]').forEach((b) => b.addEventListener('click', () => (s.engrams.splice(+b.dataset.rme, 1), draw())));
    host.querySelectorAll('[data-rmu]').forEach((b) => b.addEventListener('click', () => (s.unlocks.splice(+b.dataset.rmu, 1), draw())));
    host.querySelector('#ark-lv-save').addEventListener('click', async (e) => {
      const body = {
        player: s.player.on ? { ramp: list(s.player.text) } : null,
        dino: s.dino.on ? { ramp: list(s.dino.text) } : null,
        engramPoints: s.points.on ? list(s.points.text) : null,
        engrams: s.engrams,
        autoUnlocks: s.unlocks,
        onlyAllowSpecified: s.only,
      };
      e.currentTarget.disabled = true;
      try {
        const r = await api(`${base(server)}/levels`, { method: 'PUT', body });
        toast(r.restartNeeded ? 'Saved. Restart the server to apply it.' : 'Saved');
      } catch (err) {
        toast(err.message, 'error');
      }
      e.currentTarget.disabled = false;
    });
  };
  draw();
}

/* ---------------------------------------------------------- supply crates -- */

async function renderCrates(host, server) {
  host.innerHTML = '<div class="card faint">Loading…</div>';
  let data;
  try {
    data = await api(`${base(server)}/crates`);
  } catch (err) {
    host.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  const crates = data.crates;
  const blankEntry = () => ({ weight: 1, items: [{ cls: '', weight: 1 }], minQuantity: 1, maxQuantity: 1, minQuality: 1, maxQuality: 1, forceBlueprint: false, blueprintChance: 0 });
  const blankSet = () => ({ name: 'Set', minItems: 1, maxItems: 1, numItemsPower: 1, weight: 1, withoutReplacement: true, entries: [blankEntry()] });
  const blankCrate = () => ({ crate: 'SupplyCrate_Level03_C', minItemSets: 1, maxItemSets: 1, numItemSetsPower: 1, withoutReplacement: true, sets: [blankSet()] });
  const field = (label, path, value, attrs = '') => `<label class="ark-mini"><span>${label}</span><input data-p="${path}" value="${esc(value)}" ${attrs} /></label>`;
  const check = (label, path, on) => `<label class="checkbox-row"><input type="checkbox" data-p="${path}" ${on ? 'checked' : ''} /><span>${label}</span></label>`;
  const entryHtml = (e, p) => `<div class="ark-entry">
      ${e.items.map((it, k) => `<div class="ark-row ark-wrap"><input list="ark-items" data-p="${p}.items.${k}.cls" value="${esc(it.cls)}" placeholder="Search an item (PrimalItemResource_Metal_C)" aria-label="Item class" style="flex:2;min-width:220px" />${field('Weight', `${p}.items.${k}.weight`, it.weight, 'type="number" step="any" min="0"')}<button class="btn btn-sm btn-ghost btn-danger" data-act="rm-item" data-p="${p}.items" data-k="${k}" aria-label="Remove item">✕</button></div>`).join('')}
      <div class="ark-row ark-wrap">${field('Entry weight', `${p}.weight`, e.weight, 'type="number" step="any" min="0"')}${field('Min qty', `${p}.minQuantity`, e.minQuantity, 'type="number" min="1"')}${field('Max qty', `${p}.maxQuantity`, e.maxQuantity, 'type="number" min="1"')}${field('Min quality', `${p}.minQuality`, e.minQuality, 'type="number" step="any" min="0"')}${field('Max quality', `${p}.maxQuality`, e.maxQuality, 'type="number" step="any" min="0"')}${field('Blueprint chance (0-1)', `${p}.blueprintChance`, e.blueprintChance, 'type="number" step="any" min="0" max="1"')}${check('Always blueprint', `${p}.forceBlueprint`, e.forceBlueprint)}</div>
      <button class="btn btn-sm btn-ghost" data-act="add-item" data-p="${p}.items">Add another item to this entry</button>
      <button class="btn btn-sm btn-ghost btn-danger" data-act="rm" data-p="${p.replace(/\.\d+$/, '')}" data-k="${p.split('.').pop()}">Remove entry</button></div>`;
  const draw = () => {
    host.innerHTML = `
      <div class="card">
        <h4>Supply crate loot</h4>
        <p class="faint">Replaces what a crate drops. Each crate picks some item sets, each set picks some entries, and each entry gives one of its items with a quantity and quality in the ranges. Higher weights are picked more often. Written to <span class="mono">Game.ini</span> as ConfigOverrideSupplyCrateItems. Restart to apply.</p>
        ${crates
          .map((c, i) =>
            c.raw
              ? `<div class="ark-block"><div class="ark-row"><div class="grow"><b>${esc(c.crate || 'Crate')}</b> <span class="faint">has settings this editor does not know, so it is kept exactly as written.</span><div class="mono" style="font-size:11.5px;word-break:break-all;margin-top:6px">${esc(c.raw)}</div></div><button class="btn btn-sm btn-ghost btn-danger" data-act="rm" data-p="" data-k="${i}">Remove</button></div></div>`
              : `<div class="ark-block"><div class="ark-row ark-wrap"><label class="ark-mini" style="flex:2;min-width:240px"><span>Crate</span><input list="ark-crates" data-p="${i}.crate" value="${esc(c.crate)}" /></label>${field('Min sets', `${i}.minItemSets`, c.minItemSets, 'type="number" min="0"')}${field('Max sets', `${i}.maxItemSets`, c.maxItemSets, 'type="number" min="1"')}${field('Sets power', `${i}.numItemSetsPower`, c.numItemSetsPower, 'type="number" step="any"')}${check('Sets without repeats', `${i}.withoutReplacement`, c.withoutReplacement)}<button class="btn btn-sm btn-ghost btn-danger" data-act="rm" data-p="" data-k="${i}">Remove crate</button></div>
              ${c.sets
                .map(
                  (s, j) => `<div class="ark-set"><div class="ark-row ark-wrap">${field('Set name', `${i}.sets.${j}.name`, s.name)}${field('Min items', `${i}.sets.${j}.minItems`, s.minItems, 'type="number" min="0"')}${field('Max items', `${i}.sets.${j}.maxItems`, s.maxItems, 'type="number" min="1"')}${field('Set weight', `${i}.sets.${j}.weight`, s.weight, 'type="number" step="any" min="0"')}${field('Items power', `${i}.sets.${j}.numItemsPower`, s.numItemsPower, 'type="number" step="any"')}${check('Items without repeats', `${i}.sets.${j}.withoutReplacement`, s.withoutReplacement)}<button class="btn btn-sm btn-ghost btn-danger" data-act="rm" data-p="${i}.sets" data-k="${j}">Remove set</button></div>
                  ${s.entries.map((e, k) => entryHtml(e, `${i}.sets.${j}.entries.${k}`)).join('')}
                  <button class="btn btn-sm" data-act="add-entry" data-p="${i}.sets.${j}.entries">Add entry</button></div>`
                )
                .join('')}
              <button class="btn btn-sm" data-act="add-set" data-p="${i}.sets">Add item set</button></div>`
          )
          .join('') || '<div class="faint mb-16">No crate overrides: crates drop their normal loot.</div>'}
        <datalist id="ark-crates">${data.known.map((k) => `<option value="${esc(k.id)}">${esc(k.label)}</option>`).join('')}</datalist>
        <datalist id="ark-items"></datalist>
        <div class="row mt-16"><button class="btn" id="ark-add-crate">Add crate</button><button class="btn btn-primary" id="ark-cr-save">Save</button></div>
        <div class="hint">Item and crate names are class names ending in _C. Start typing an item name to get suggestions. Not tested against a live server.</div>
      </div>`;
    const at = (path) => path.split('.').filter(Boolean).reduce((n, p) => n[p], crates);
    host.querySelectorAll('[data-p]:not(button)').forEach((el) => {
      el.addEventListener('change', () => {
        const val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? num(el.value, '') : el.value;
        setPath(crates, el.dataset.p, val);
      });
      if (el.list?.id === 'ark-items') el.addEventListener('input', () => suggest(server, el.value));
    });
    host.querySelectorAll('button[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const { act, p, k } = b.dataset;
        if (act === 'rm') at(p).splice(+k, 1);
        if (act === 'rm-item') at(p).length > 1 ? at(p).splice(+k, 1) : toast('An entry needs at least one item', 'error');
        if (act === 'add-item') at(p).push({ cls: '', weight: 1 });
        if (act === 'add-entry') at(p).push(blankEntry());
        if (act === 'add-set') at(p).push(blankSet());
        draw();
      })
    );
    host.querySelector('#ark-add-crate').addEventListener('click', () => (crates.push(blankCrate()), draw()));
    host.querySelector('#ark-cr-save').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api(`${base(server)}/crates`, { method: 'PUT', body: { crates } });
        crates.splice(0, crates.length, ...r.crates);
        draw();
        toast(r.restartNeeded ? 'Saved. Restart the server to apply it.' : 'Saved');
      } catch (err) {
        toast(err.message, 'error');
        e.currentTarget.disabled = false;
      }
    });
  };
  draw();
}

let suggestTimer = null;
function suggest(server, text) {
  clearTimeout(suggestTimer);
  if (text.length < 2) return;
  suggestTimer = setTimeout(async () => {
    try {
      const r = await api(`${base(server)}/items?limit=20&q=${encodeURIComponent(text)}`);
      const list = document.getElementById('ark-items');
      if (list) list.innerHTML = r.items.map((i) => `<option value="${esc(i.cls)}">${esc(i.name)}</option>`).join('');
    } catch {
      /* suggestions are optional */
    }
  }, 250);
}

/* -------------------------------------------------------------- give item -- */

const idKey = (server, name) => `gp.ark.pid.${server.id}.${name}`;
const remembered = (server, name) => {
  try {
    return localStorage.getItem(idKey(server, name)) || '';
  } catch {
    return '';
  }
};

async function renderGive(host, server) {
  const st = { q: '', category: '', items: [], total: 0, picked: null, tiers: [], categories: [] };
  const online = () => state.servers.find((s) => s.id === server.id)?.playerList || [];
  host.innerHTML = `
    <div class="card">
      <h4>Give item</h4>
      <p class="faint">Pick an item, a player who is online, how many and what quality, and the panel sends ARK's GiveItemToPlayer command. ARK needs the player's in-game ID (a number) rather than their name; the panel remembers it per player once you enter it.</p>
      <div class="form-grid"><label><span>Search items</span><input id="gi-q" placeholder="Metal ingot, Rex saddle, Tek rifle…" autocomplete="off" /></label>
        <label><span>Category</span><select id="gi-cat"><option value="">All</option></select></label></div>
      <div class="ark-list ark-results" id="gi-results" role="listbox" aria-label="Items"></div>
      <div class="ark-block mt-16"><div id="gi-picked" class="faint">No item picked yet.</div>
        <label class="checkbox-row"><input type="checkbox" id="gi-custom" /><span>Use a custom blueprint path instead (modded or newer items)</span></label>
        <input id="gi-path" class="mono" placeholder="/Game/Mods/1234/Item/PrimalItem_Thing" hidden aria-label="Custom blueprint path" />
        <div class="form-grid mt-16">
          <label><span>Player</span><select id="gi-player"></select></label>
          <label><span>In-game player ID</span><input id="gi-pid" inputmode="numeric" placeholder="e.g. 1234567890" /></label>
          <label><span>Quantity</span><input id="gi-qty" type="number" min="1" value="1" /></label>
          <label><span>Quality tier</span><select id="gi-tier"></select></label>
          <label><span>or exact quality number</span><input id="gi-quality" type="number" min="0" step="any" placeholder="e.g. 700" /></label>
          <label><span>Command</span><select id="gi-style"><option value="GiveItemToPlayer">GiveItemToPlayer (sent to the server)</option><option value="GiveItemNumToPlayer">GiveItemNumToPlayer (item number, sent)</option><option value="giveitem">giveitem (copy for the in-game console)</option></select></label>
          <label id="gi-num-wrap" hidden><span>Item number</span><input id="gi-num" type="number" min="0" /></label></div>
        <label class="checkbox-row"><input type="checkbox" id="gi-bp" /><span>Give the blueprint instead of the item</span></label>
        <div class="row mt-16"><button class="btn btn-primary" id="gi-go">Give item</button></div>
        <pre class="mono ark-cmd" id="gi-out" hidden></pre></div>
    </div>`;
  const $q = (s) => host.querySelector(s);
  const fillPlayers = () => {
    const names = online();
    $q('#gi-player').innerHTML = names.length ? names.map((n) => `<option>${esc(n)}</option>`).join('') : '<option value="">Nobody is online</option>';
    $q('#gi-pid').value = remembered(server, $q('#gi-player').value);
  };
  const drawResults = () => {
    $q('#gi-results').innerHTML = st.items.length
      ? st.items.map((i, k) => `<button class="ark-item ${st.picked?.path === i.path ? 'active' : ''}" role="option" data-k="${k}"><b>${esc(i.name)}</b> <span class="faint">${esc(i.category)}</span></button>`).join('') + (st.total > st.items.length ? `<div class="faint" style="padding:8px">${st.total - st.items.length} more. Type to narrow it down.</div>` : '')
      : '<div class="faint" style="padding:12px">No items match.</div>';
    $q('#gi-results').querySelectorAll('[data-k]').forEach((b) =>
      b.addEventListener('click', () => {
        st.picked = st.items[+b.dataset.k];
        $q('#gi-picked').innerHTML = `Picked: <b>${esc(st.picked.name)}</b> <span class="mono faint">${esc(st.picked.cls)}</span>`;
        drawResults();
      })
    );
  };
  const search = async () => {
    try {
      const r = await api(`${base(server)}/items?limit=40&q=${encodeURIComponent(st.q)}&category=${encodeURIComponent(st.category)}`);
      Object.assign(st, { items: r.items, total: r.total });
      if (!st.categories.length) {
        st.categories = r.categories;
        $q('#gi-cat').innerHTML = '<option value="">All</option>' + r.categories.map((c) => `<option>${esc(c)}</option>`).join('');
        st.tiers = r.tiers;
        $q('#gi-tier').innerHTML = r.tiers.map((t) => `<option value="${esc(t.id)}">${esc(t.label)} (${t.value})</option>`).join('');
        $q('#gi-tier').value = 'ascendant';
      }
      drawResults();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  let timer;
  $q('#gi-q').addEventListener('input', (e) => {
    st.q = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(search, 200);
  });
  $q('#gi-cat').addEventListener('change', (e) => {
    st.category = e.target.value;
    search();
  });
  $q('#gi-custom').addEventListener('change', (e) => ($q('#gi-path').hidden = !e.target.checked));
  $q('#gi-style').addEventListener('change', (e) => ($q('#gi-num-wrap').hidden = !/Num/.test(e.target.value)));
  $q('#gi-player').addEventListener('change', () => ($q('#gi-pid').value = remembered(server, $q('#gi-player').value)));
  $q('#gi-go').addEventListener('click', async (e) => {
    const custom = $q('#gi-custom').checked;
    const player = $q('#gi-player').value;
    const style = $q('#gi-style').value;
    const body = {
      style,
      player,
      playerId: $q('#gi-pid').value.trim(),
      path: custom ? $q('#gi-path').value.trim() : st.picked?.path,
      custom,
      itemNum: $q('#gi-num').value,
      quantity: $q('#gi-qty').value,
      tier: $q('#gi-tier').value,
      quality: $q('#gi-quality').value,
      blueprint: $q('#gi-bp').checked,
    };
    e.currentTarget.disabled = true;
    try {
      const r = await api(`${base(server)}/give`, { method: 'POST', body });
      try {
        if (player && body.playerId) localStorage.setItem(idKey(server, player), body.playerId);
      } catch {
        /* optional */
      }
      const out = $q('#gi-out');
      out.hidden = false;
      out.textContent = r.command + (r.response ? `\n${r.response}` : '');
      toast(r.sent ? `Sent to ${player}` : 'Command ready to copy');
    } catch (err) {
      toast(err.message, 'error');
    }
    e.currentTarget.disabled = false;
  });
  fillPlayers();
  search();
}

/* ---------------------------------------------- settings changed from default -- */

async function renderDiff(host, server, file = 'GameUserSettings.ini') {
  host.innerHTML = '<div class="card faint">Loading…</div>';
  let d;
  try {
    d = await api(`${base(server)}/ini-diff?file=${encodeURIComponent(file)}`);
  } catch (err) {
    host.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  const rows = (list, cols) => (list.length ? `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${list.join('')}</tbody></table></div>` : '<div class="faint">None.</div>');
  host.innerHTML = `<div class="card">
    <h4>Settings changed from default</h4>
    <p class="faint">Compares the file with the values ARK uses when a setting is missing, for the settings people change most. Settings not in that table are listed apart, so nothing is hidden.</p>
    <div class="row gap-8" style="margin-bottom:8px">${d.files.map((f) => `<button class="btn btn-sm ${f === d.file ? 'primary' : ''}" data-f="${esc(f)}">${esc(f)}</button>`).join('')}</div>
    <h5>Changed (${d.changed.length})</h5>
    ${rows(d.changed.map((r) => `<tr><td>${esc(r.key)}</td><td class="mono">${esc(r.value)}</td><td class="mono faint">${esc(r.default)}</td></tr>`), ['Setting', 'Now', 'Default'])}
    <p class="hint">${d.matching} more setting(s) are already at their default.</p>
    <details><summary>Other entries (${d.unknown.length})</summary>${rows(d.unknown.slice(0, 300).map((r) => `<tr><td class="mono">${esc(r.section)}</td><td>${esc(r.key)}</td><td class="mono">${esc(r.value.slice(0, 120))}</td></tr>`), ['Section', 'Key', 'Value'])}</details>
  </div>`;
  host.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => renderDiff(host, server, b.dataset.f)));
}
