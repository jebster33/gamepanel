/*
 * The player portal: /portal. Standalone, no dashboard modules. Everything
 * from the server is put on the page as text, never as markup.
 */

const $ = (sel) => document.querySelector(sel);

async function call(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...kids.flat().filter((x) => x != null));
  return node;
}

const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const num = (n) => Number(n || 0).toLocaleString('en-US');
const stat = (label, value) => el('div', { class: 'stat' }, el('b', { text: String(value) }), el('span', { text: label }));

let poll = null;

function applyBrand(config) {
  $('#brand').textContent = config.panelName;
  if (config.accent && /^#[0-9a-f]{6}$/i.test(config.accent)) {
    document.documentElement.style.setProperty('--lime', config.accent);
    document.documentElement.style.setProperty('--lime-text', config.accent);
  }
}

function profileCard(p, onRemove) {
  const s = p.stats;
  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'head' }, el('h2', { text: p.name }), el('span', {}, p.online ? el('span', { class: 'pill', text: 'Online now' }) : null, ' ', el('button', { class: 'linkbtn', text: 'Unlink', onclick: () => onRemove(p) }))),
    el('div', { class: 'k', text: `${p.server.name} · ${p.server.game}` }),
    el(
      'div',
      { class: 'stats' },
      stat('Hours played', p.hours),
      stat('Visits', num(p.sessions)),
      p.rank ? stat('Play time rank', `#${p.rank.place} of ${p.rank.of}`) : null,
      stat('First seen', when(p.firstSeen)),
      stat('Last seen', p.online ? 'now' : when(p.lastSeen)),
      s ? [stat('Deaths', num(s.deaths)), stat('Mob kills', num(s.mobKills)), stat('Player kills', num(s.playerKills)), stat('Blocks mined', num(s.mined)), stat('Distance', `${num(s.km)} km`), stat('Advancements', num(s.advancements))] : null
    )
  );
}

function banCard(b) {
  const lines = [el('div', { class: 'head' }, el('h2', { text: `${b.name} is ${b.active ? 'banned' : 'no longer banned'}` }), el('span', { class: b.active ? 'pill bad' : 'pill', text: b.until ? (b.active ? `Until ${when(b.until)}` : 'Expired') : 'Permanent' }))];
  if (b.reason) lines.push(el('div', { class: 'reply', text: b.reason }));
  lines.push(el('div', { class: 'faint', text: `Since ${when(b.at)}` }));
  if (b.appeal) {
    const label = { open: 'Appeal waiting for an admin', accepted: 'Appeal accepted', denied: 'Appeal denied' }[b.appeal.status] || b.appeal.status;
    lines.push(el('div', { class: 'status', text: label }));
    if (b.appeal.reply) lines.push(el('div', { class: 'reply', text: b.appeal.reply }));
  }
  return el('div', { class: 'card' }, lines);
}

async function signOut() {
  await call('/api/portal/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}

async function showMe() {
  const me = await call('/api/portal/me');
  $('#signin').classList.add('hidden');
  const box = $('#me');
  box.classList.remove('hidden');
  const remove = async (p) => {
    try {
      await call(`/api/portal/names/${encodeURIComponent(p.server.id)}/${encodeURIComponent(p.name)}`, { method: 'DELETE' });
      showMe();
    } catch (err) {
      $('#error').textContent = err.message;
    }
  };
  box.replaceChildren(
    ...me.profiles.map((p) => profileCard(p, remove)),
    me.profiles.length ? null : el('div', { class: 'card' }, el('h2', { text: 'No in-game name yet' }), el('p', { class: 'faint', style: 'margin:0', text: 'Add your name below to see your stats.' })),
    ...me.bans.map(banCard),
    me.bans.some((b) => b.active) && me.appeals ? el('a', { class: 'btn ghost', href: '/appeal', text: 'Appeal a ban' }) : null,
    el(
      'div',
      { class: 'card' },
      el('h2', { text: 'Linked accounts' }),
      me.accounts.length ? el('div', {}, me.accounts.map((a) => el('div', { class: 'k', style: 'margin-bottom:6px', text: `${a.kind === 'game' ? 'In-game' : a.kind}: ${a.label}${a.server ? ` (${a.server})` : ''}` }))) : el('p', { class: 'faint', text: 'Nothing linked yet.' }),
      el('button', { text: 'Add an in-game name', onclick: () => startCode({}) }),
      ' ',
      el('button', { class: 'linkbtn', text: 'Sign out', onclick: signOut })
    )
  );
}

/** Ask for a code, then watch until it has been said in chat. */
async function startCode(body) {
  $('#error').textContent = '';
  clearInterval(poll);
  let started;
  try {
    started = await call('/api/portal/code', { method: 'POST', body });
  } catch (err) {
    $('#error').textContent = err.message;
    return;
  }
  $('#code').textContent = started.code;
  $('#code-box').classList.remove('hidden');
  const until = Date.now() + started.expiresIn * 1000;
  poll = setInterval(async () => {
    try {
      const r = await call(`/api/portal/code/${encodeURIComponent(started.ticket)}`);
      if (r.state === 'waiting' && Date.now() < until) return;
      clearInterval(poll);
      if (r.state === 'verified') {
        $('#code-box').classList.add('hidden');
        showMe();
      } else $('#code-note').textContent = 'That code ran out. Reload to get a new one.';
    } catch (err) {
      clearInterval(poll);
      $('#error').textContent = err.message;
    }
  }, 3000);
}

async function main() {
  const q = new URLSearchParams(location.search);
  if (q.get('error')) $('#error').textContent = q.get('error');
  let config;
  try {
    config = await call('/api/portal/config');
  } catch (err) {
    $('#error').textContent = err.message;
    return;
  }
  applyBrand(config);
  if (!config.enabled) return $('#off').classList.remove('hidden');
  if (config.signedIn) {
    try {
      return await showMe();
    } catch {
      /* session expired: show sign-in */
    }
  }
  $('#signin').classList.remove('hidden');
  $('#providers').replaceChildren(...config.providers.map((p) => el('a', { class: 'btn', href: `/api/portal/auth/${encodeURIComponent(p.id)}/start`, text: `Sign in with ${p.label}` })));
  $('#name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    startCode({ name: $('#name').value });
  });
}

main();
