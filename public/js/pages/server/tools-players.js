import { api } from '../../core/api.js';
import { can, esc } from '../../core/util.js';
import { state } from '../../core/state.js';

/* ------------------------------------------- when and where players are */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Average players by weekday and hour. */
export async function drawHeatmap(box, url) {
  let d;
  try {
    d = await api(url);
  } catch (err) {
    box.innerHTML = `<div class="faint">${esc(err.message)}</div>`;
    return;
  }
  if (!d.max) {
    box.innerHTML = '<div class="faint">Not enough player history yet. The panel records the player count every 5 minutes.</div>';
    return;
  }
  const order = [1, 2, 3, 4, 5, 6, 0];
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="lab" style="text-align:center">${h % 3 === 0 ? h : ''}</div>`).join('');
  const rows = order
    .map(
      (day) =>
        `<div class="lab">${DAYS[day]}</div>${d.grid[day]
          .map((v, h) => `<div class="cell" style="--v:${v == null ? 0 : Math.max(0.06, v / d.max).toFixed(2)}" title="${DAYS[day]} ${String(h).padStart(2, '0')}:00 · ${v == null ? 'no data' : `${v} players on average`}"></div>`)
          .join('')}`
    )
    .join('');
  box.innerHTML = `<div class="heat"><div></div>${hours}${rows}</div>
    <div class="hint mt-8">${d.best ? `Busiest: <b>${DAYS[d.best.day]} ${String(d.best.hour).padStart(2, '0')}:00</b> with ${d.best.avg} players on average. ` : ''}Local time of the panel's machine, from the last ${d.days} days. Darker means busier: a good time for restarts is the palest hour.</div>`;
}

const flag = (cc) => String(cc).toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
const countryName = (cc) => {
  try {
    return new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }).of(cc) || cc;
  } catch {
    return cc;
  }
};

/** A bubble map of where players connect from, with the ranked list beside it. */
export async function drawCountries(box, url) {
  let d;
  try {
    d = await api(url);
  } catch (err) {
    box.innerHTML = `<div class="faint">${esc(err.message)}</div>`;
    return;
  }
  if (!d.countries.length) {
    box.innerHTML = `<div class="faint">No locations yet.${d.pending ? ` Looking up ${d.pending} address${d.pending === 1 ? '' : 'es'} in the background: check again in a minute.` : ' Locations are collected from the addresses players join with (Minecraft Java, Rust and Source games), and need the location lookup turned on in Settings.'}</div>`;
    return;
  }
  const max = d.countries[0].players;
  box.innerHTML = `
    <canvas class="cmap" width="720" height="360" style="width:100%;max-width:720px;border-radius:10px;background:var(--bg-sunken, rgba(127,127,127,.1))"></canvas>
    <div class="mt-8">${d.countries.slice(0, 12).map((c) => `<div class="tools-row" style="gap:10px"><span style="width:2em">${flag(c.cc)}</span><span style="min-width:150px">${esc(countryName(c.cc))}</span><div class="tools-bar" style="flex:1;max-width:260px"><i style="width:${(c.players / max) * 100}%"></i></div><span>${c.players}</span></div>`).join('')}</div>
    <div class="hint mt-8">${d.total} player${d.total === 1 ? '' : 's'} with a known location${d.pending ? `; ${d.pending} more being looked up` : ''}. Each player counts once, at the country of their latest address.</div>`;
  const canvas = box.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#c6f432';
  const grid = 'rgba(127,127,127,.28)';
  const W = canvas.width;
  const H = canvas.height;
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = ((lon + 180) / 360) * W;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let lat = -90; lat <= 90; lat += 30) {
    const y = ((90 - lat) / 180) * H;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(127,127,127,.7)';
  ctx.font = '11px sans-serif';
  [['N. America', -100, 45], ['S. America', -60, -15], ['Europe', 15, 52], ['Africa', 20, 5], ['Asia', 90, 45], ['Oceania', 135, -25]].forEach(([n, lon, lat]) => ctx.fillText(n, ((lon + 180) / 360) * W - 24, ((90 - lat) / 180) * H));
  for (const c of d.countries) {
    if (c.lat == null) continue;
    const x = ((c.lon + 180) / 360) * W;
    const y = ((90 - c.lat) / 180) * H;
    const r = 5 + 20 * Math.sqrt(c.players / max);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `${accent}99`;
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.stroke();
    ctx.fillStyle = css.getPropertyValue('--text').trim() || '#fff';
    ctx.fillText(c.cc, x - 6, y + 4);
  }
}

/** Sections of the Tools tab about this server's players. */
export function playerSections(server) {
  const out = [];
  if (can('console')) {
    out.push({ id: 'heatmap', title: 'Peak times', lead: 'Players by hour and weekday', load: (body) => drawHeatmap(body, `/api/player-insights/heatmap?server=${encodeURIComponent(server.id)}`) });
  }
  if (state.user.role === 'admin' && !server.node) {
    out.push({ id: 'countries', title: 'Where players connect from', lead: 'Countries on a map', load: (body) => drawCountries(body, `/api/player-insights/countries?server=${encodeURIComponent(server.id)}`) });
  }
  return out;
}
