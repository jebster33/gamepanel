import { api } from '../core/api.js';
import { esc, fmtBytes } from '../core/util.js';

/* Capacity: what each machine has, what its servers reserve and what they really use. */

const COLORS = ['#c6f432', '#6cb6ff', '#ffb340', '#b48cff', '#4fd1c5', '#ff8fab', '#9bd16b', '#f0e68c'];
let last = 0;

const cores = (n) => `${+n.toFixed(2)} core${n === 1 ? '' : 's'}`;
const pct = (n, total) => (total > 0 ? Math.max(0, Math.min(100, (n / total) * 100)) : 0);

/** Fill the card; refreshes at most every 10 seconds when the dashboard's live numbers arrive. */
export async function renderCapacity(box, force = false) {
  if (!box || (!force && Date.now() - last < 10_000)) return;
  last = Date.now();
  let data;
  try {
    data = await api('/api/system/capacity');
  } catch {
    box.innerHTML = '';
    return;
  }
  if (!box.isConnected) return;
  box.innerHTML = `
    <div class="row" style="margin-bottom:10px"><h2 class="section-title" style="margin:0">Capacity</h2></div>
    ${data.machines.map((m) => machineCard(m, data.limits)).join('')}`;
}

function machineCard(m, limits) {
  const rows = [memoryRow(m, limits), cpuRow(m), diskRow(m)].join('');
  return `<div class="card capacity" style="margin-bottom:12px">
    <div class="row mb-16"><h3 style="font-size:16px">${esc(m.name)}</h3>
      <span class="badge ${m.online ? 'accent' : ''}">${m.online ? (m.local ? 'this machine' : 'online') : 'offline'}</span></div>
    ${m.online ? rows : '<div class="faint">This node is offline, so its numbers are not available.</div>'}
  </div>`;
}

/** One stacked bar: [{label, value, color, used?, hatch?}] against a total. */
function bar(parts, total, used) {
  const sum = parts.reduce((a, p) => a + p.value, 0);
  const scale = Math.max(total, sum);
  const mark = sum > total && total > 0 ? `<i class="cap-limit" style="left:${pct(total, scale)}%" title="Machine total"></i>` : '';
  return `<div class="cap-bar">${parts
    .map((p) => {
      const inner = p.used ? `<i style="width:${pct(p.used, p.value)}%"></i>` : '';
      return `<span class="cap-seg${p.hatch ? ' hatch' : ''}${p.free ? ' free' : ''}" style="width:${pct(p.value, scale)}%;${p.color ? `--c:${p.color}` : ''}" title="${esc(p.title)}">${inner}</span>`;
    })
    .join('')}${mark}</div>`;
}

function section(title, headline, warn, barHtml, legend) {
  return `<div class="cap-row"><div class="row" style="gap:10px;margin-bottom:6px">
    <b class="mono" style="font-size:12px;letter-spacing:.06em;text-transform:uppercase">${title}</b>
    <span class="faint" style="font-size:13px">${headline}</span>
    ${warn ? `<span class="badge ${/^Over/.test(warn) ? 'bad' : 'warn'}" style="margin-left:auto">${esc(warn)}</span>` : ''}</div>
    ${barHtml}<div class="cap-legend">${legend}</div></div>`;
}

const legendItem = (color, text, hatch) => `<span><i class="cap-key${hatch ? ' hatch' : ''}" style="--c:${color}"></i>${esc(text)}</span>`;

function memoryRow(m, limits) {
  const total = m.memory.total;
  const running = m.servers.filter((s) => s.active);
  const reserved = running.reduce((a, s) => a + s.memReserved, 0);
  const usedBy = running.reduce((a, s) => a + s.memUsed, 0);
  const other = Math.max(0, m.memory.used - usedBy);
  const free = total - reserved - other;
  const parts = running.map((s, i) => ({ value: s.memReserved, used: s.memUsed, color: COLORS[i % COLORS.length], title: `${s.name}: reserves ${fmtBytes(s.memReserved)}, using ${fmtBytes(s.memUsed)}` }));
  parts.push({ value: other, hatch: true, color: '#8a887f', title: `System and other programs: ${fmtBytes(other)}` });
  if (free > 0) parts.push({ value: free, free: true, title: `Free to reserve: ${fmtBytes(free)}` });
  const avg = running.length ? reserved / running.length : 0;
  const room = avg && free > 0 ? ` · room for about ${Math.floor(free / avg)} more like the average (${fmtBytes(avg)})` : '';
  const over = free < 0 ? `Over-committed by ${fmtBytes(-free)}` : '';
  const near = !over && total && free < total * 0.1 ? 'Almost full' : '';
  const stopped = m.servers.filter((s) => !s.active).reduce((a, s) => a + s.memReserved, 0);
  const note = stopped ? ` · ${fmtBytes(stopped)} more if the stopped servers start` : '';
  const legend =
    running.map((s, i) => legendItem(COLORS[i % COLORS.length], `${s.name} ${fmtBytes(s.memUsed)} / ${fmtBytes(s.memReserved)}`)).join('') +
    legendItem('#8a887f', `System ${fmtBytes(other)}`, true) +
    (free > 0 ? legendItem('var(--border-strong)', `Free ${fmtBytes(free)}`) : '');
  const limit = limits.memoryMb ? ` · panel limit ${fmtBytes(limits.memoryMb * 1024 * 1024)}` : '';
  return section('Memory', `${fmtBytes(reserved)} reserved of ${fmtBytes(total)}${limit}${room}${note}`, over || near, bar(parts, total), legend);
}

function cpuRow(m) {
  const total = m.cpu.cores;
  const running = m.servers.filter((s) => s.active);
  // A server with a CPU cap reserves the cap; one without takes what it uses.
  const take = (s) => s.cpuCap || s.cpuUsed;
  const reserved = running.reduce((a, s) => a + take(s), 0);
  const parts = running.map((s, i) => ({ value: take(s), used: Math.min(s.cpuUsed, take(s)), color: COLORS[i % COLORS.length], title: `${s.name}: ${s.cpuCap ? `capped at ${cores(s.cpuCap)}` : 'no cap'}, using ${cores(s.cpuUsed)}` }));
  const free = total - reserved;
  if (free > 0) parts.push({ value: free, free: true, title: `Free: ${cores(free)}` });
  const over = free < 0 ? `Over-committed by ${cores(-free)}` : '';
  const legend = running.map((s, i) => legendItem(COLORS[i % COLORS.length], `${s.name} ${cores(s.cpuUsed)}${s.cpuCap ? ` / ${cores(s.cpuCap)}` : ' (no cap)'}`)).join('') + (free > 0 ? legendItem('var(--border-strong)', `Free ${cores(free)}`) : '');
  return section('CPU', `${cores(reserved)} reserved or in use of ${total} · machine at ${m.cpu.percent.toFixed(0)}%`, over, bar(parts, total), legend);
}

function diskRow(m) {
  const total = m.disk.total;
  const sized = m.servers.filter((s) => s.disk > 0);
  const own = sized.reduce((a, s) => a + s.disk, 0);
  const other = Math.max(0, m.disk.used - own);
  const free = Math.max(0, total - own - other);
  const parts = sized.map((s, i) => ({ value: s.disk, color: COLORS[i % COLORS.length], title: `${s.name}: ${fmtBytes(s.disk)} on disk` }));
  parts.push({ value: other, hatch: true, color: '#8a887f', title: `Everything else: ${fmtBytes(other)}` });
  if (free > 0) parts.push({ value: free, free: true, title: `Free: ${fmtBytes(free)}` });
  const near = total && free < total * 0.1 ? 'Almost full' : '';
  const legend = sized.map((s, i) => legendItem(COLORS[i % COLORS.length], `${s.name} ${fmtBytes(s.disk)}`)).join('') + legendItem('#8a887f', `Other ${fmtBytes(other)}`, true) + legendItem('var(--border-strong)', `Free ${fmtBytes(free)}`);
  return section('Disk', `${fmtBytes(own)} used by servers · ${fmtBytes(free)} free of ${fmtBytes(total)}`, near, bar(parts, total), legend);
}
