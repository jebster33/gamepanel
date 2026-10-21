import { api } from '../../core/api.js';
import { can, esc } from '../../core/util.js';
import { section, attempt, table, field } from './tools-kit.js';

/* ------------------------------------------- Minecraft Java: Tools tab cards */

const isMc = (server) => /^minecraft-(?!bedrock$)/.test(String(server.templateId || ''));
const pct = (n) => `${(n * 100).toFixed(1)}%`;

export function minecraftSections(server) {
  if (!isMc(server) || server.node) return [];
  const base = `/api/servers/${server.id}`;
  return [
    can('files') && pluginSection(base),
    can('files') && borderSection(base),
    can('files') && switchSection(server, base),
    can('console') && flameSection(base),
  ].filter(Boolean);
}

/* ---------------------------------------------------------- plugin updates */

function pluginSection(base) {
  return {
    id: 'plugin-updates',
    title: 'Plugin updates',
    lead: 'Checks Modrinth, Hangar and SpigotMC',
    load: async (body) => {
      body.innerHTML = '<span class="spinner"></span> Checking…';
      const d = await api(`${base}/plugin-updates`);
      if (!d.items.length) {
        body.innerHTML = '<div class="faint">No plugins or mods found.</div>';
        return;
      }
      const rows = d.items.map((i) => [
        esc(i.name),
        `<span class="mono">${esc(i.version || '?')}</span>`,
        i.outdated === true ? `<span class="badge warn">${esc(i.latest)}</span>` : i.outdated === false ? '<span class="badge ok">Up to date</span>' : '<span class="faint">Unknown</span>',
        i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.source || 'open')}</a>${i.exact === false ? ' <span class="faint">(matched by name)</span>' : ''}${i.premium ? ' <span class="faint">premium</span>' : ''}` : '',
      ]);
      body.innerHTML = `${table(['Name', 'Installed', 'Latest', 'Source'], rows)}<div class="hint mt-8">${d.checked} file(s) checked for ${esc(d.filter || 'this server')}. Matches by file hash on Modrinth are exact; others are matched by name, so check it is the same plugin. Download and replace the file on the Files or Mods tab.</div>`;
    },
  };
}

/* ------------------------------------------------------------ world border */

function borderSection(base) {
  return {
    id: 'worldborder',
    title: 'World border',
    lead: 'See what is generated, then set the border',
    load: async (body) => {
      let d = await api(`${base}/worldborder`);
      const canEdit = can('files.write') && can('console');
      const draw = () => {
        const cv = body.querySelector('canvas');
        if (!cv) return;
        const ctx = cv.getContext('2d');
        const W = cv.width;
        const H = cv.height;
        const f = (id) => Number(body.querySelector(id).value) || 0;
        const size = Math.max(1, f('#wb-size'));
        const cx = f('#wb-x');
        const cz = f('#wb-z');
        // Fit the border, all generated regions and spawn.
        let ext = Math.max(size / 2 + Math.max(Math.abs(cx), Math.abs(cz)), 512);
        for (const [rx, rz] of d.regions) ext = Math.max(ext, Math.abs(rx) * 512 + 512, Math.abs(rz) * 512 + 512);
        ext *= 1.08;
        const px = (x) => W / 2 + (x / ext) * (W / 2);
        const pz = (z) => H / 2 + (z / ext) * (H / 2);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(127,127,127,.12)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(120,180,80,.55)';
        const s = (512 / ext) * (W / 2);
        for (const [rx, rz] of d.regions) ctx.fillRect(px(rx * 512), pz(rz * 512), s, s);
        ctx.strokeStyle = 'rgba(127,127,127,.5)';
        ctx.beginPath();
        ctx.moveTo(W / 2, 0);
        ctx.lineTo(W / 2, H);
        ctx.moveTo(0, H / 2);
        ctx.lineTo(W, H / 2);
        ctx.stroke();
        ctx.strokeStyle = '#e5484d';
        ctx.lineWidth = 2;
        ctx.strokeRect(px(cx - size / 2), pz(cz - size / 2), (size / ext) * (W / 2), (size / ext) * (H / 2));
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(px(d.spawnX), pz(d.spawnZ), 4, 0, 7);
        ctx.fill();
      };
      const render = () => {
        body.innerHTML = `
          <canvas width="520" height="520" style="width:100%;max-width:520px;border-radius:10px;cursor:crosshair"></canvas>
          <div class="hint mt-8">Green: regions already generated. Blue dot: spawn. Red square: the border. ${canEdit ? 'Click the map to move the centre.' : ''} ${esc(d.note)}</div>
          <div class="row wrap gap-8 mt-8">
            ${field('Size (blocks across)', `<input id="wb-size" type="number" min="1" value="${d.size}">`)}
            ${field('Centre X', `<input id="wb-x" type="number" value="${d.centerX}">`)}
            ${field('Centre Z', `<input id="wb-z" type="number" value="${d.centerZ}">`)}
            ${d.running ? field('Shrink/grow over (seconds)', '<input id="wb-s" type="number" min="0" value="0">') : ''}
          </div>
          <div class="row gap-8 mt-8">
            <button class="btn" data-act="spawn">Centre on spawn</button>
            <button class="btn primary" data-act="apply" ${canEdit ? '' : 'disabled'}>Apply</button>
          </div>`;
        body.querySelectorAll('input').forEach((i) => i.addEventListener('input', draw));
        body.querySelector('canvas').addEventListener('click', (e) => {
          if (!canEdit) return;
          const r = e.target.getBoundingClientRect();
          const fx = ((e.clientX - r.left) / r.width) * 2 - 1;
          const fz = ((e.clientY - r.top) / r.height) * 2 - 1;
          let ext = Math.max(Number(body.querySelector('#wb-size').value) / 2 + Math.max(Math.abs(Number(body.querySelector('#wb-x').value)), Math.abs(Number(body.querySelector('#wb-z').value))), 512);
          for (const [rx, rz] of d.regions) ext = Math.max(ext, Math.abs(rx) * 512 + 512, Math.abs(rz) * 512 + 512);
          ext *= 1.08;
          body.querySelector('#wb-x').value = Math.round(fx * ext);
          body.querySelector('#wb-z').value = Math.round(fx === 0 ? 0 : fz * ext);
          draw();
        });
        body.querySelector('[data-act=spawn]').onclick = () => {
          body.querySelector('#wb-x').value = d.spawnX;
          body.querySelector('#wb-z').value = d.spawnZ;
          draw();
        };
        body.querySelector('[data-act=apply]').onclick = async () => {
          const v = (id) => Number(body.querySelector(id).value);
          const out = await attempt(
            () => api(`${base}/worldborder`, { method: 'PUT', body: { size: v('#wb-size'), centerX: v('#wb-x'), centerZ: v('#wb-z'), seconds: body.querySelector('#wb-s') ? v('#wb-s') : 0 } }),
            'World border updated'
          );
          if (out) {
            d = out;
            render();
          }
        };
        draw();
      };
      render();
    },
  };
}

/* ----------------------------------------------------------- switch check */

function switchSection(server, base) {
  const types = [
    ['minecraft-paper', 'Paper'],
    ['minecraft-purpur', 'Purpur'],
    ['minecraft-fabric', 'Fabric'],
    ['minecraft-quilt', 'Quilt'],
    ['minecraft-forge', 'Forge'],
    ['minecraft-neoforge', 'NeoForge'],
    ['minecraft-vanilla', 'Vanilla'],
  ];
  return {
    id: 'switch-check',
    title: 'Switch check',
    lead: 'Will my mods work on another type or version?',
    load: (body) => {
      body.innerHTML = `<div class="row wrap gap-8">
        ${field('Server type', `<select id="sc-type">${types.map(([id, n]) => `<option value="${id}" ${id === server.templateId ? 'selected' : ''}>${n}</option>`).join('')}</select>`)}
        ${field('Minecraft version', '<input id="sc-ver" placeholder="1.21.4">')}
        <button class="btn primary" id="sc-go">Check my mods</button></div><div id="sc-out" class="mt-8"></div>`;
      body.querySelector('#sc-go').onclick = async () => {
        const out = body.querySelector('#sc-out');
        out.innerHTML = '<span class="spinner"></span>';
        const d = await attempt(() => api(`${base}/switch-check`, { method: 'POST', body: { templateId: body.querySelector('#sc-type').value, version: body.querySelector('#sc-ver').value } }));
        if (!d) {
          out.innerHTML = '';
          return;
        }
        const label = { ok: '<span class="badge ok">Works</span>', update: '<span class="badge warn">Needs update</span>', missing: '<span class="badge bad">No release</span>', unknown: '<span class="faint">Not on Modrinth: check by hand</span>', 'wrong-kind': '<span class="badge bad">Wrong kind</span>' };
        const s = d.summary;
        out.innerHTML = `${d.notes.map((n) => `<div class="hint">${esc(n)}</div>`).join('')}<div class="mb-8">${s.ok} work, ${s.update} need an update, ${s.missing} have no release, ${s.unknown + s.wrongKind} unknown.</div>${table(['File', 'Installed', 'Result'], d.rows.map((r) => [esc(r.name), `<span class="mono">${esc(r.version || '?')}${r.latest ? ` → ${esc(r.latest)}` : ''}</span>`, label[r.status] || '']), { empty: 'No mods or plugins installed.' })}`;
      };
    },
  };
}

/* ------------------------------------------------------------ flame graph */

function node(n, total, depth = 0) {
  const share = n.value / total;
  const kids = (n.children || []).filter((k) => k.value / total >= 0.02).sort((a, b) => b.value - a.value);
  const label = `<div class="mono" style="width:${Math.max(share * 100, 3).toFixed(1)}%;background:hsl(${Math.round(30 - share * 30)},80%,${Math.round(55 - share * 15)}%);color:#111;padding:1px 4px;margin:1px 0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;border-radius:3px" title="${esc(n.name)} · ${n.value} samples (${pct(share)})">${esc(n.name)}</div>`;
  return `${label}${kids.length ? `<div style="margin-left:10px">${kids.map((k) => node(k, total, depth + 1)).join('')}</div>` : ''}`;
}

function flameSection(base) {
  return {
    id: 'flame',
    title: 'Profiler (flame graph)',
    lead: 'Where the server spends its time',
    load: async (body) => {
      const render = async () => {
        const d = await api(`${base}/flame`);
        if (d.state === 'running') {
          body.innerHTML = `<span class="spinner"></span> Sampling… ${d.dumps} thread dumps so far (${d.seconds}s).`;
          setTimeout(() => body.isConnected && render().catch(() => {}), 2000);
          return;
        }
        const form = `<div class="row wrap gap-8">${field('Seconds', '<input id="fl-s" type="number" min="5" max="120" value="30">')}<button class="btn primary" id="fl-go">Profile now</button></div><div class="hint">Samples the Java process with thread dumps while it is busy. Linux only; Java servers only. It adds a little load while it runs.</div>`;
        if (d.state === 'failed') body.innerHTML = `<div class="faint">${esc(d.error)}</div>${form}`;
        else if (d.state === 'done') {
          const r = d.result;
          const tree = r.main || r.all;
          const total = tree.value || 1;
          body.innerHTML = `${form}<h4 class="mt-8">${r.main ? 'Server thread' : 'All threads'}</h4><div>${(tree.children || []).sort((a, b) => b.value - a.value).map((k) => node(k, total)).join('') || '<span class="faint">Empty</span>'}</div>
            <h4 class="mt-8">Busiest packages</h4>${table(['Package', 'Share'], r.packages.slice(0, 12).map((p) => [`<span class="mono">${esc(p.pkg || p.name || '')}</span>`, pct(p.share ?? 0)]))}
            <h4 class="mt-8">Hottest frames</h4>${table(['Frame', 'Share'], r.top.map((t) => [`<span class="mono">${esc(t.frame)}</span>`, pct(t.share)]))}
            <div class="hint mt-8">${r.samples} samples. Hover a bar for details.</div>`;
        } else body.innerHTML = form;
        body.querySelector('#fl-go').onclick = async () => {
          if (await attempt(() => api(`${base}/flame`, { method: 'POST', body: { seconds: Number(body.querySelector('#fl-s').value) } }))) render().catch(() => {});
        };
      };
      await render();
    },
  };
}

