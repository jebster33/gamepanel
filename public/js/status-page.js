/*
 * The public status page (/status/<link id>). Standalone: no sign-in and none
 * of the dashboard's modules, just the one public endpoint.
 */

const slug = location.pathname.split('/').filter(Boolean)[1] || '';
const $ = (id) => document.getElementById(id);

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  button.textContent = 'Copied';
  setTimeout(() => (button.textContent = 'Copy'), 1500);
}

let first = true;

function render(data) {
  document.title = `${data.title} · status`;
  $('title').textContent = data.title;
  $('description').hidden = !data.description;
  $('description').textContent = data.description || '';
  const host = data.host || location.hostname;
  const online = data.servers.filter((s) => s.status === 'online');
  const players = online.reduce((n, s) => n + (s.players || 0), 0);
  $('summary').innerHTML = `
    <span class="pill"><span class="led ${online.length ? 'on' : ''}"></span>${online.length} of ${data.servers.length} online</span>
    <span class="pill">${players} player${players === 1 ? '' : 's'} on now</span>`;

  if (!data.servers.length) {
    $('cards').innerHTML = '<div class="card empty">No servers on this page yet.</div>';
    return;
  }
  $('cards').innerHTML = data.servers
    .map((s, i) => {
      const address = s.address || (s.port ? `${host}:${s.port}` : null);
      const pct = s.maxPlayers ? Math.min(100, (s.players / s.maxPlayers) * 100) : 0;
      return `
      <article class="card ${esc(s.status)}" style="${first ? `animation-delay:${i * 50}ms` : 'animation:none'}">
        <div class="top">
          <span class="icon">${esc(s.icon || '🎮')}</span>
          <div style="min-width:0">
            <div class="name">${esc(s.name)}</div>
            <div class="game">${esc(s.game)}${s.version ? ` · ${esc(s.version)}` : ''}</div>
          </div>
          <span class="state"><span class="led"></span>${s.status === 'online' ? 'Online' : s.status === 'starting' ? 'Starting' : 'Offline'}</span>
        </div>
        ${
          s.status === 'online'
            ? `<div class="meter"><i style="width:${pct.toFixed(0)}%"></i></div>
               <div class="row">
                 <span class="count"><b>${s.players}</b>${s.maxPlayers ? ` / ${s.maxPlayers}` : ''} players</span>
                 ${s.uptime ? `<span class="meta">up ${duration(s.uptime)}</span>` : ''}
               </div>`
            : ''
        }
        ${address ? `<div class="row"><span class="address">${esc(address)} <button data-copy="${esc(address)}">Copy</button></span></div>` : ''}
        ${s.joinNote ? `<div class="meta" style="margin-top:8px">${esc(s.joinNote)}</div>` : ''}
        ${s.playerNames?.length ? `<div class="names">${s.playerNames.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''}
      </article>`;
    })
    .join('');
  first = false;
  $('footer').textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()} · refreshes every 15 seconds`;
}

async function load() {
  try {
    const res = await fetch(`/api/public/status/${encodeURIComponent(slug)}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Not found');
    render(data);
  } catch (err) {
    $('title').textContent = 'Status page not found';
    $('cards').innerHTML = `<div class="card empty">${esc(err.message)}</div>`;
    $('summary').innerHTML = '';
  }
}

document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-copy]');
  if (btn) copy(btn.dataset.copy, btn);
});

load();
setInterval(() => document.visibilityState === 'visible' && load(), 15000);
