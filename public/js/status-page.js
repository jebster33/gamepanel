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

/** 30 small bars, one per day, like a classic status page. */
function uptimeBars(u) {
  if (!u || !u.days.some((d) => d != null)) return '';
  const pct = (v) => (v == null ? '–' : `${(v * 100).toFixed(v === 1 ? 0 : 1)}%`);
  const bars = u.days
    .map((d, i) => {
      const date = new Date(Date.now() - (u.days.length - 1 - i) * 86400000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const cls = d == null ? 'none' : d >= 0.99 ? 'up' : d >= 0.9 ? 'some' : 'down';
      return `<i class="${cls}" title="${esc(date)}: ${d == null ? 'no data' : `${pct(d)} online`}"></i>`;
    })
    .join('');
  return `<div class="uptime"><div class="bars">${bars}</div><div class="uptime-legend"><span>30 days ago</span><span>${pct(u.month)} uptime</span><span>Today</span></div></div>`;
}

let first = true;

/** The owner's logo and colour, instead of GamePanel's. */
function brand(data) {
  const root = document.documentElement.style;
  if (data.accent && /^#[0-9a-f]{6}$/i.test(data.accent)) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(data.accent.slice(i, i + 2), 16));
    const light = matchMedia('(prefers-color-scheme: light)').matches;
    root.setProperty('--lime', data.accent);
    // On a light background a pale accent needs darkening to stay readable as text.
    root.setProperty('--lime-text', light ? `rgb(${Math.round(r * 0.55)}, ${Math.round(g * 0.55)}, ${Math.round(b * 0.55)})` : data.accent);
    root.setProperty('--lime-soft', `rgba(${r}, ${g}, ${b}, 0.14)`);
  }
  const badge = $('brand');
  if (data.logo) {
    badge.hidden = false;
    badge.className = 'brand brand-logo';
    badge.innerHTML = `<img src="${esc(data.logo)}" alt="${esc(data.title)}" />`;
    const icon = document.querySelector('link[rel="icon"]');
    if (icon) icon.href = data.logo;
  } else {
    badge.hidden = Boolean(data.hideBadge);
  }
}

function render(data) {
  document.title = `${data.title} · status`;
  $('title').textContent = data.title;
  $('description').hidden = !data.description;
  $('description').textContent = data.description || '';
  const host = data.host || location.hostname;
  brand(data);
  const links = [
    data.links?.discord && `<a href="${esc(data.links.discord)}" target="_blank" rel="noopener">💬 Discord</a>`,
    data.links?.vote && `<a href="${esc(data.links.vote)}" target="_blank" rel="noopener">⭐ Vote for us</a>`,
    data.links?.website && `<a href="${esc(data.links.website)}" target="_blank" rel="noopener">🌐 Website</a>`,
  ].filter(Boolean);
  $('links').hidden = !links.length;
  $('links').innerHTML = links.join('');
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
      <article class="card ${esc(s.maintenance ? 'starting' : s.status)}" style="${first ? `animation-delay:${i * 50}ms` : 'animation:none'}">
        <div class="top">
          <span class="icon">${esc(s.icon || '🎮')}</span>
          <div style="min-width:0">
            <div class="name">${esc(s.name)}</div>
            <div class="game">${esc(s.game)}${s.version ? ` · ${esc(s.version)}` : ''}</div>
          </div>
          <span class="state"><span class="led"></span>${s.maintenance ? 'Maintenance' : s.status === 'online' ? 'Online' : s.status === 'starting' ? 'Starting' : 'Offline'}</span>
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
        ${s.blurb ? `<div class="blurb">${esc(s.blurb)}</div>` : ''}
        ${s.motd ? `<div class="motd">${esc(s.motd)}</div>` : ''}
        ${address ? `<div class="row"><span class="address">${esc(address)} <button data-copy="${esc(address)}">Copy</button></span>${s.join && s.status === 'online' ? `<a class="join" href="${esc(s.join.replace('{host}', host))}">Join</a>` : ''}${s.mapPort ? `<a class="meta" href="http://${esc(host)}:${s.mapPort}" target="_blank" rel="noopener">🗺️ Live map</a>` : s.mapUrl ? `<a class="meta" href="${esc(s.mapUrl)}" target="_blank" rel="noopener">🗺️ Map</a>` : ''}</div>` : ''}
        ${s.maintenance ? `<div class="meta" style="margin-top:8px">🛠 ${esc(s.maintenance)}</div>` : ''}
        ${s.joinNote ? `<div class="meta" style="margin-top:8px">${esc(s.joinNote)}</div>` : ''}
        ${uptimeBars(s.uptime30)}
        ${
          s.topPlayers?.length
            ? `<div class="most"><span class="meta">Most played</span> ${s.topPlayers.map((p) => `<span>${esc(p.name)} <b>${p.hours}h</b></span>`).join('')}</div>` +
              (s.leaderboards || []).map((b) => `<div class="most"><span class="meta">${esc(b.label)}</span> ${b.top.map((p) => `<span>${esc(p.name)} <b>${esc(p.value)}</b></span>`).join('')}</div>`).join('')
            : ''
        }
        ${s.playerNames?.length ? `<div class="names">${s.playerNames.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''}
      </article>`;
    })
    .join('');
  first = false;
  $('footer').textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()} · refreshes every 15 seconds`;
  if (data.appeals) {
    const link = document.createElement('a');
    link.href = '/appeal';
    link.textContent = 'Appeal a ban';
    $('footer').append(' · ', link);
  }
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
