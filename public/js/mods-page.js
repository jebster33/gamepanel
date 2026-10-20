/*
 * The public "mods you need" page (/mods/<link id>). Standalone: no sign-in
 * and none of the dashboard's modules, just the one public endpoint.
 */

const slug = location.pathname.split('/').filter(Boolean)[1] || '';
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Only ever link to web addresses, whatever the data says.
const safeUrl = (url) => (/^https?:\/\//i.test(url || '') ? url : '');

function row(item, tag) {
  const url = safeUrl(item.url);
  const image = item.icon && safeUrl(item.icon) ? `<img src="${esc(item.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="ph"></span>';
  return `<div class="mod">${image}<div class="meta"><div class="nm">${esc(item.name)}</div><div class="sub">${esc([item.version, tag].filter(Boolean).join(' · '))}</div></div>${
    url ? `<a class="go" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''
  }</div>`;
}

function asText(data) {
  const lines = [`${data.server} (${data.game})`];
  if (data.gameVersion) lines.push(`Minecraft ${data.gameVersion}${data.loader ? `, ${data.loader}${data.loaderVersion ? ` ${data.loaderVersion}` : ''}` : ''}`);
  if (data.mods.length) lines.push('', 'Mods:', ...data.mods.map((m) => `- ${m.name}${m.version ? ` ${m.version}` : ''}${m.side === 'optional' ? ' (optional)' : ''}${m.url ? ` ${m.url}` : ''}`));
  for (const c of data.workshop.collections) lines.push('', `Subscribe to the Workshop collection ${c.title}: ${c.url}`);
  if (data.workshop.items.length) lines.push('', 'Workshop items:', ...data.workshop.items.map((m) => `- ${m.name} ${m.url}`));
  if (data.extras.length) lines.push('', 'Also:', ...data.extras.map((e) => `- ${e.name} ${e.url}${e.note ? ` (${e.note})` : ''}`));
  return lines.join('\n');
}

async function main() {
  let data;
  try {
    const res = await fetch(`/api/public/mods/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Not found');
    data = await res.json();
  } catch (err) {
    $('title').textContent = 'Not available';
    $('content').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  document.title = `Mods for ${data.server}`;
  $('title').textContent = data.server;
  const facts = [data.game, data.gameVersion && `Minecraft ${data.gameVersion}`, data.loader && `${data.loader}${data.loaderVersion ? ` ${data.loaderVersion}` : ''}`].filter(Boolean);
  $('lede').hidden = false;
  $('lede').textContent = facts.join(' · ');

  const required = data.mods.filter((m) => m.side === 'required');
  const optional = data.mods.filter((m) => m.side === 'optional');
  const parts = [];
  if (data.notes) parts.push(`<div class="note">${esc(data.notes)}</div>`);

  const actions = [];
  if (data.pack) actions.push(`<a href="/api/public/mods/${encodeURIComponent(slug)}/pack.mrpack" download>Download modpack (.mrpack)</a>`);
  for (const c of data.workshop.collections) {
    if (safeUrl(c.url)) actions.push(`<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Subscribe: ${esc(c.title)}</a>`);
  }
  actions.push('<button class="alt" id="copy">Copy list</button>', '<button class="alt" id="save">Download list (.txt)</button>');
  parts.push(`<div class="actions">${actions.join('')}</div>`);
  if (data.pack) parts.push('<div class="note">Open the .mrpack in the Modrinth app, Prism Launcher or another launcher that supports Modrinth packs. It installs the right Minecraft and mod versions for you.</div>');

  if (required.length) parts.push(`<div class="group">Required (${required.length})</div>`, ...required.map((m) => row(m, m.provider)));
  if (optional.length) parts.push(`<div class="group">Optional (${optional.length})</div>`, ...optional.map((m) => row(m, m.provider)));
  if (data.workshop.items.length) parts.push(`<div class="group">Steam Workshop (${data.workshop.items.length})</div>`, ...data.workshop.items.map((m) => row(m, 'subscribe on Steam')));
  if (data.extras.length) parts.push('<div class="group">Also</div>', ...data.extras.map((e) => row({ name: e.name, version: e.note, url: e.url })));
  if (!data.mods.length && !data.workshop.items.length && !data.extras.length) parts.push('<div class="empty">You do not need to install anything to join this server.</div>');
  $('content').innerHTML = parts.join('');

  const text = asText(data);
  $('copy')?.addEventListener('click', async (event) => {
    try {
      await navigator.clipboard.writeText(text);
      event.currentTarget.textContent = 'Copied';
    } catch {
      event.currentTarget.textContent = 'Copy failed';
    }
  });
  $('save')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `${data.server.replace(/[^\w.-]+/g, '_')}-mods.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

main();
