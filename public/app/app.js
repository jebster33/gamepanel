/*
 * GamePanel for iPhone. A home-screen web app: Safari → Share → Add to Home
 * Screen. Talks to the same API and WebSocket as the full panel.
 *
 * Screens are pushed onto a stack with iOS-style transitions; swipe from the
 * left edge to go back.
 */

/* ---------------------------------------------------------------- helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l6 6-6 6"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18v13H3zM2 3h20v4H2zM10 12h4"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  laptop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="11" rx="2"/><path d="M2 19h20"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
};

/** What players type: the Cloudflare name when there is one (no port with SRV). */
function addressOf(server) {
  const sub = server.subdomain;
  if (sub) return sub.srv || !sub.port ? sub.host : `${sub.host}:${sub.port}`;
  return `${location.hostname}:${server.ports?.game ?? Object.values(server.ports || {})[0]}`;
}

function fmtDuration(ms) {
  const m = Math.floor((ms || 0) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function fmtBytes(n) {
  if (!n) return '0 MB';
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}
const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const STATUS_WORD = {
  running: 'Online',
  starting: 'Starting',
  stopping: 'Stopping',
  offline: 'Offline',
  crashed: 'Crashed',
  installing: 'Installing',
  install_failed: 'Install failed',
};

const state = { user: null, servers: [], ws: null, subs: new Set(), consoles: new Map() };

function can(cap) {
  if (!state.user) return false;
  return state.user.role === 'admin' || (state.user.permissions || []).includes(cap);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401 && !path.includes('/auth/login')) {
    showAuth();
    throw new Error('Please sign in again');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast glass ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

async function copy(text) {
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
  toast('Copied');
}

function avatar(server, name) {
  const java = String(server.templateId || '').startsWith('minecraft') && server.templateId !== 'minecraft-bedrock';
  const letter = esc(String(name).slice(0, 1).toUpperCase());
  if (java && /^[A-Za-z0-9_]{3,16}$/.test(name)) {
    return `<span class="avatar"><img src="https://mc-heads.net/avatar/${esc(name)}/80" alt="" loading="lazy" data-fallback="${letter}"/></span>`;
  }
  return `<span class="avatar">${letter}</span>`;
}

document.addEventListener(
  'error',
  (event) => {
    const img = event.target;
    if (img?.tagName === 'IMG' && img.dataset.fallback) img.replaceWith(document.createTextNode(img.dataset.fallback));
  },
  true
);

/* ---------------------------------------------------------------- sheets */

/**
 * An iOS action sheet in Liquid Glass. `actions` are { label, danger, run };
 * resolves when one is picked or the sheet is dismissed.
 */
function sheet({ title, actions, input }) {
  return new Promise((resolve) => {
    const host = $('#sheets');
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const el = document.createElement('div');
    el.className = 'sheet glass';
    el.innerHTML = `
      ${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}
      ${input ? `<input class="sheet-input" placeholder="${esc(input)}" />` : ''}
      ${actions.map((a, i) => `<button class="sheet-btn ${a.danger ? 'danger' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}
      <button class="sheet-btn cancel" data-i="-1">Cancel</button>`;
    host.append(backdrop, el);
    requestAnimationFrame(() => {
      backdrop.classList.add('show');
      el.classList.add('show');
    });
    const close = (value) => {
      backdrop.classList.remove('show');
      el.classList.remove('show');
      setTimeout(() => {
        backdrop.remove();
        el.remove();
      }, 400);
      resolve(value);
    };
    backdrop.addEventListener('click', () => close(null));
    el.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-i]');
      if (!btn) return;
      const action = actions[Number(btn.dataset.i)];
      const value = input ? $('.sheet-input', el).value : undefined;
      close(action || null);
      if (action?.run) {
        try {
          await action.run(value);
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    });
  });
}

/* -------------------------------------------------------------- the stack */

const stack = [];

/**
 * A screen is { el, update?, destroy? }. `make(el)` fills the element and
 * returns hooks.
 */
function push(make, { animate = true } = {}) {
  const el = document.createElement('section');
  el.className = 'screen';
  const screen = { el };
  Object.assign(screen, make(el) || {});
  if (animate && stack.length) el.classList.add('enter');
  $('#stack').appendChild(el);
  const below = stack[stack.length - 1];
  stack.push(screen);
  watchScroll(el);
  if (animate && below) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.classList.remove('enter');
        below.el.classList.add('under');
      })
    );
  }
  return screen;
}

function pop() {
  if (stack.length < 2) return;
  const top = stack.pop();
  const below = stack[stack.length - 1];
  top.el.classList.remove('dragging');
  top.el.style.transform = '';
  below.el.style.transform = '';
  below.el.style.filter = '';
  top.el.classList.add('leaving');
  below.el.classList.remove('under');
  top.destroy?.();
  below.update?.();
  setTimeout(() => top.el.remove(), 500);
}

function resetStack(make) {
  while (stack.length) {
    const s = stack.pop();
    s.destroy?.();
    s.el.remove();
  }
  push(make, { animate: false });
}

/** Large titles hand over to the glass title capsule once scrolled away. */
function watchScroll(el) {
  const scroller = $('.scroll', el);
  if (!scroller) return;
  scroller.addEventListener('scroll', () => el.classList.toggle('scrolled', scroller.scrollTop > 28), { passive: true });
}

/* Swipe from the left edge to go back, following the finger like iOS. */
(() => {
  let start = null;
  document.addEventListener(
    'touchstart',
    (e) => {
      if (stack.length < 2 || e.touches[0].clientX > 28) return;
      start = { x: e.touches[0].clientX, t: Date.now() };
      stack[stack.length - 1].el.classList.add('dragging');
      stack[stack.length - 2].el.classList.add('dragging');
    },
    { passive: true }
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!start) return;
      const dx = Math.max(0, e.touches[0].clientX - start.x);
      const w = window.innerWidth;
      stack[stack.length - 1].el.style.transform = `translateX(${dx}px)`;
      const below = stack[stack.length - 2].el;
      below.style.transform = `translateX(${-28 + (dx / w) * 28}%)`;
      below.style.filter = `brightness(${0.6 + (dx / w) * 0.4})`;
    },
    { passive: true }
  );
  document.addEventListener('touchend', (e) => {
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const fast = dx > 60 && Date.now() - start.t < 250;
    const top = stack[stack.length - 1].el;
    const below = stack[stack.length - 2].el;
    top.classList.remove('dragging');
    below.classList.remove('dragging');
    start = null;
    if (dx > window.innerWidth / 3 || fast) pop();
    else {
      top.style.transform = '';
      below.style.transform = '';
      below.style.filter = '';
    }
  });
})();

/* -------------------------------------------------------------- live data */

function connect() {
  if (state.ws && state.ws.readyState <= 1) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    if (state.subs.size) ws.send(JSON.stringify({ type: 'subscribe', topics: [...state.subs] }));
  };
  ws.onclose = () => setTimeout(() => state.user && connect(), 2500);
  ws.onerror = () => ws.close();
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.topic === 'servers') state.servers = msg.servers;
    else if (msg.topic === 'server:status') {
      const i = state.servers.findIndex((s) => s.id === msg.serverId);
      if (i >= 0) state.servers[i] = msg.server;
    } else if (msg.topic === 'stats') {
      for (const s of msg.servers) Object.assign(state.servers.find((x) => x.id === s.id) || {}, s);
    } else if (String(msg.topic).startsWith('console:')) {
      const id = msg.topic.slice(8);
      const lines = state.consoles.get(id) || [];
      if (msg.type === 'clear') lines.length = 0;
      else lines.push(...(msg.lines || []));
      if (lines.length > 800) lines.splice(0, lines.length - 800);
      state.consoles.set(id, lines);
      stack[stack.length - 1]?.onConsole?.(id, msg);
      return;
    } else return;
    stack[stack.length - 1]?.update?.();
  };
}

function subscribe(topic) {
  state.subs.add(topic);
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
}
function unsubscribe(topic) {
  state.subs.delete(topic);
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: 'unsubscribe', topics: [topic] }));
}

// Coming back to the app after it sat in the background: catch up at once.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.user) return;
  connect();
  try {
    state.servers = (await api('/api/servers')).servers;
    stack[stack.length - 1]?.update?.();
  } catch {
    /* offline for a moment */
  }
});

/* ---------------------------------------------------------------- sign in */

function showAuth() {
  state.user = null;
  state.ws?.close();
  resetStack(authScreen);
}

function authScreen(el) {
  el.innerHTML = `
    <form class="auth" autocomplete="on">
      <img class="logo" src="/img/logo-192.png" alt="" />
      <h1 id="a-title">Welcome back</h1>
      <p id="a-sub">Sign in to your GamePanel.</p>
      <div class="fields" id="a-creds">
        <input class="field" id="a-user" name="username" autocomplete="username" autocapitalize="off" autocorrect="off" placeholder="Username" />
        <input class="field" id="a-pass" name="password" type="password" autocomplete="current-password" placeholder="Password" />
      </div>
      <div class="fields" id="a-code-wrap" hidden>
        <input class="field code" id="a-code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" placeholder="000000" />
      </div>
      <button class="primary" id="a-go" type="submit">Sign in</button>
      <div class="error" id="a-err"></div>
    </form>`;
  let ticket = null;
  $('form', el).addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = $('#a-go', el);
    btn.disabled = true;
    $('#a-err', el).textContent = '';
    try {
      let res;
      if (!ticket) {
        res = await api('/api/auth/login', { method: 'POST', body: { username: $('#a-user', el).value.trim(), password: $('#a-pass', el).value } });
        if (res.twoFactor) {
          ticket = res.ticket;
          $('#a-creds', el).hidden = true;
          $('#a-code-wrap', el).hidden = false;
          $('#a-title', el).textContent = 'Two-factor code';
          $('#a-sub', el).textContent = 'Enter the 6-digit code from your authenticator app, or a recovery code.';
          btn.textContent = 'Verify';
          btn.disabled = false;
          $('#a-code', el).focus();
          return;
        }
      } else {
        res = await api('/api/auth/login/2fa', { method: 'POST', body: { ticket, code: $('#a-code', el).value.replace(/\s/g, '') } });
      }
      state.user = res.user;
      await start();
    } catch (err) {
      $('#a-err', el).textContent = err.message;
      btn.disabled = false;
    }
  });
  // Submit as soon as iOS fills the code in from Passwords / Messages.
  $('#a-code', el).addEventListener('input', (e) => {
    if (/^\d{6}$/.test(e.target.value)) $('form', el).requestSubmit();
  });
}

/* ------------------------------------------------------------------- home */

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function homeScreen(el) {
  el.innerHTML = `
    <div class="topbar">
      <button class="glass glass-btn" id="h-me" aria-label="Account">${ICON.user}</button>
      <div class="glass title-capsule"><span>Servers</span></div>
      <span></span>
    </div>
    <div class="scroll">
      <h1 class="large-title">${esc(greeting())}, ${esc(state.user.username)}</h1>
      <p class="subtitle" id="h-sub"></p>
      <div class="hero-stats" id="h-stats"></div>
      <div class="section-label">Servers</div>
      <div class="group" id="h-list"></div>
    </div>`;

  $('#h-me', el).addEventListener('click', () =>
    sheet({
      title: `Signed in as ${state.user.username}`,
      actions: [
        { label: 'Notifications', run: () => push(notificationsScreen) },
        { label: 'Open the full panel', run: () => (location.href = '/') },
        {
          label: 'Sign out',
          danger: true,
          run: async () => {
            await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
            showAuth();
          },
        },
      ],
    })
  );
  $('#h-list', el).addEventListener('click', (e) => {
    const row = e.target.closest('[data-server]');
    if (row) push((s) => serverScreen(s, row.dataset.server));
  });

  const update = () => {
    const servers = state.servers;
    const running = servers.filter((s) => s.status === 'running');
    const players = running.reduce((n, s) => n + (s.players || 0), 0);
    $('#h-sub', el).textContent = servers.length ? `${running.length} of ${servers.length} running` : '';
    $('#h-stats', el).innerHTML = servers.length
      ? `<div class="hero-stat"><b class="${players ? 'lime' : ''}">${players}</b><span>players online</span></div>
         <div class="hero-stat"><b>${running.length}</b><span>servers up</span></div>`
      : '';
    $('#h-list', el).innerHTML = servers.length
      ? servers
          .map((s) => {
            const sub =
              s.status === 'running'
                ? `${s.players ?? 0}${s.maxPlayers ? `/${s.maxPlayers}` : ''} players · up ${fmtDuration(s.uptime)}`
                : `${STATUS_WORD[s.status] || s.status} · ${esc(s.templateName)}`;
            return `<button class="row" data-server="${esc(s.id)}">
              <span class="tile">${esc(s.templateIcon || '🎮')}<span class="dot ${esc(s.status)}"></span></span>
              <span class="row-main"><div class="row-title">${esc(s.name)}</div><div class="row-sub">${sub}</div></span>
              ${ICON.chev}
            </button>`;
          })
          .join('')
      : '<div class="empty">No servers yet. Create one in the full panel.</div>';
  };
  update();
  return { update };
}

/* ----------------------------------------------------------------- server */

function serverScreen(el, id) {
  const server = () => state.servers.find((s) => s.id === id);
  let view = can('console') ? 'console' : 'overview';
  const views = [can('console') && ['console', 'Console'], ['players', 'Players'], ['overview', 'Overview']].filter(Boolean);
  el.classList.add('server-screen');
  el.innerHTML = `
    <div class="topbar">
      <button class="glass glass-btn" id="s-back" aria-label="Back">${ICON.back}</button>
      <div class="glass title-capsule always"><span class="dot" id="s-dot"></span><span id="s-name"></span></div>
      <button class="glass glass-btn right" id="s-more" aria-label="More">${ICON.more}</button>
    </div>
    <div class="glass seg" id="s-seg"><span class="thumb"></span>${views.map(([v, l]) => `<button data-view="${v}">${l}</button>`).join('')}</div>
    <div class="scroll" id="s-scroll"><div id="s-body"></div></div>
    <button class="glass glass-btn jump" id="s-jump" aria-label="Latest">${ICON.down}</button>
    <form class="glass composer" id="s-composer" hidden>
      <textarea id="s-input" rows="1" placeholder="Send a command" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send"></textarea>
      <button class="send" id="s-send" type="submit" disabled aria-label="Send">${ICON.up}</button>
    </form>`;

  const scroller = $('#s-scroll', el);
  const body = $('#s-body', el);
  $('#s-back', el).addEventListener('click', pop);
  $('#s-more', el).addEventListener('click', () => powerSheet(server()));

  // The lime thumb slides under the active segment.
  const seg = $('#s-seg', el);
  const moveThumb = () => {
    const btn = $(`[data-view="${view}"]`, seg);
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    const thumb = $('.thumb', seg);
    thumb.style.width = `${btn.offsetWidth}px`;
    thumb.style.transform = `translateX(${btn.offsetLeft - 4}px)`;
  };
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn || btn.dataset.view === view) return;
    view = btn.dataset.view;
    moveThumb();
    show();
  });

  /* -- console -- */
  let pinned = true;
  const lineHtml = (entry) => {
    const raw = String(entry.line ?? '');
    if (entry.stream === 'input') return `<div class="bubble">${esc(raw.replace(/^> /, ''))}<small>${new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div>`;
    let tone = entry.stream === 'stderr' ? 'err' : entry.stream === 'system' ? 'system' : '';
    if (!tone && /\b(error|severe|fatal|exception)\b/i.test(raw)) tone = 'err';
    else if (!tone && /\bwarn(ing)?\b/i.test(raw)) tone = 'warn';
    const m = raw.match(/^(\[[^\]]*\](?:\s*\[[^\]]*\])?:?\s*)(.*)$/);
    const text = m && tone !== 'system' ? `<span class="ts">${esc(m[1])}</span>${esc(m[2])}` : esc(raw);
    return `<div class="line ${tone}">${text}</div>`;
  };
  const toBottom = () => (scroller.scrollTop = scroller.scrollHeight);
  scroller.addEventListener(
    'scroll',
    () => {
      pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      $('#s-jump', el).classList.toggle('show', view === 'console' && !pinned);
    },
    { passive: true }
  );
  $('#s-jump', el).addEventListener('click', () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }));

  const input = $('#s-input', el);
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
    $('#s-send', el).disabled = !input.value.trim();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#s-composer', el).requestSubmit();
    }
  });
  $('#s-composer', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const command = input.value.trim();
    if (!command) return;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    pinned = true;
    try {
      await api(`/api/servers/${id}/command`, { method: 'POST', body: { command } });
    } catch (err) {
      toast(err.message, 'error');
      input.value = command;
      input.dispatchEvent(new Event('input'));
    }
  });

  const showConsole = async () => {
    body.innerHTML = '<div class="log" id="s-log"></div>';
    if (!state.consoles.has(id)) {
      try {
        state.consoles.set(id, (await api(`/api/servers/${id}/console`)).lines || []);
      } catch (err) {
        body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
        return;
      }
    }
    const lines = state.consoles.get(id);
    $('#s-log', el).innerHTML = lines.length ? lines.slice(-400).map(lineHtml).join('') : '<div class="line system">Nothing here yet. Start the server to see its console.</div>';
    toBottom();
  };

  /* -- players -- */
  const showPlayers = async () => {
    const s = server();
    const online = [...(s.playerDetails || [])].sort((a, b) => a.since - b.since);
    body.innerHTML = `
      <div class="section-label">Online now · ${s.status === 'running' ? (s.players ?? online.length) : 0}</div>
      <div class="group" id="p-online">${
        online.length
          ? online
              .map(
                (p) => `<button class="row" data-player="${esc(p.name)}">${avatar(s, p.name)}
                  <span class="row-main"><div class="row-title">${esc(p.name)}</div><div class="row-sub">${Date.now() - p.since < 60000 ? 'Just joined' : `Online for ${fmtDuration(Date.now() - p.since)}`}</div></span>
                  <span class="dot running"></span></button>`
              )
              .join('')
          : `<div class="empty" style="padding:28px">${s.status === 'running' ? 'Nobody is on right now.' : 'The server is offline.'}</div>`
      }</div>
      <div id="p-history"></div>`;
    if (!can('console')) return;
    try {
      const h = await api(`/api/servers/${id}/player-history`);
      const recent = h.players.filter((p) => !p.online).slice(0, 25);
      if (!$('#p-history', el)) return;
      $('#p-history', el).innerHTML = `
        <div class="hero-stats" style="margin-top:18px">
          <div class="hero-stat"><b>${h.summary.unique}</b><span>players seen</span></div>
          <div class="hero-stat"><b>${h.summary.peak24h}</b><span>peak today</span></div>
          <div class="hero-stat"><b>${h.summary.hours}</b><span>hours played</span></div>
        </div>
        ${
          recent.length
            ? `<div class="section-label">Recently seen</div><div class="group">${recent
                .map(
                  (p) => `<button class="row" data-player="${esc(p.name)}" data-offline>${avatar(s, p.name)}
                    <span class="row-main"><div class="row-title">${esc(p.name)}</div><div class="row-sub">${esc(ago(p.last))} · ${Math.round(p.seconds / 360) / 10}h played</div></span></button>`
                )
                .join('')}</div>`
            : ''
        }`;
    } catch {
      /* history is a bonus */
    }
  };
  body.addEventListener('click', (e) => {
    const row = e.target.closest('[data-player]');
    if (row) playerSheet(server(), row.dataset.player, !row.hasAttribute('data-offline'));
  });

  /* -- overview -- */
  const showOverview = () => {
    const s = server();
    const on = s.status === 'running';
    const busy = ['starting', 'stopping', 'installing'].includes(s.status);
    const mem = s.memoryLimit ? Math.min(100, ((s.memory || 0) / s.memoryLimit) * 100) : 0;
    const address = addressOf(s);
    body.innerHTML = `
      <div class="status-hero ${on ? '' : 'off'}">
        ${can('power') ? `<button class="glass power ${on ? 'on' : ''} ${busy ? 'busy' : ''}" id="o-power" aria-label="Power">${busy ? ICON.restart : ICON.power}</button>` : ''}
        <div class="status-word">${esc(STATUS_WORD[s.status] || s.status)}</div>
        <div class="status-meta">${on ? `Up ${fmtDuration(s.uptime)}` : esc(s.templateName)}${s.gameVersion ? ` · ${esc(s.gameVersion)}` : ''}</div>
      </div>
      <div class="stats">
        <div class="stat"><span>CPU</span><b>${on ? (s.cpu ?? 0).toFixed(0) : 0}<small>%</small></b><div class="meter"><i style="width:${Math.min(100, s.cpu || 0)}%"></i></div></div>
        <div class="stat"><span>Memory</span><b>${on ? fmtBytes(s.memory) : '0 MB'}</b><div class="meter"><i style="width:${on ? mem : 0}%"></i></div></div>
        <div class="stat"><span>Players</span><b>${on ? (s.players ?? 0) : 0}<small>/${s.maxPlayers || '—'}</small></b></div>
        <div class="stat"><span>Ping</span><b>${s.ping != null && on ? s.ping : '—'}<small>${s.ping != null && on ? 'ms' : ''}</small></b></div>
      </div>
      <div class="section-label">Connect</div>
      <div class="group flat"><button class="row" id="o-copy"><span class="row-main"><div class="row-title" style="font-family:var(--mono);font-size:15px">${esc(address)}</div><div class="row-sub">Tap to copy the address</div></span>${ICON.copy.replace('<svg', '<svg width="20" height="20" style="color:var(--faint)"')}</button></div>
      <div class="section-label">Actions</div>
      <div class="group">
        ${can('power') && on ? `<button class="row" data-act="restart"><span class="action-icon">${ICON.restart}</span><span class="row-main"><div class="row-title">Restart</div></span>${ICON.chev}</button>` : ''}
        ${can('backups') ? `<button class="row" data-act="backup"><span class="action-icon gray">${ICON.box}</span><span class="row-main"><div class="row-title">Back up now</div></span>${ICON.chev}</button>` : ''}
        <a class="row" href="/#/servers/${esc(s.id)}" style="color:inherit;text-decoration:none"><span class="action-icon gray">${ICON.laptop}</span><span class="row-main"><div class="row-title">Open in the full panel</div></span>${ICON.chev}</a>
        ${can('power') && (on || busy) ? `<button class="row danger" data-act="kill"><span class="action-icon red">${ICON.bolt}</span><span class="row-main"><div class="row-title">Force stop</div></span></button>` : ''}
      </div>`;
    $('#o-copy', el).addEventListener('click', () => copy(address));
    $('#o-power', el)?.addEventListener('click', () => (busy ? null : power(s, on ? 'stop' : 'start')));
    body.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', async () => {
        const act = b.dataset.act;
        if (act === 'restart') power(s, 'restart');
        if (act === 'kill')
          sheet({ title: 'Force stop kills the server without saving. Use it only if it is stuck.', actions: [{ label: 'Force stop', danger: true, run: () => power(s, 'kill') }] });
        if (act === 'backup') {
          toast('Backing up…');
          try {
            await api(`/api/servers/${id}/backups`, { method: 'POST', body: { label: 'phone' } });
            toast('Backup saved');
          } catch (err) {
            toast(err.message, 'error');
          }
        }
      })
    );
  };

  const show = () => {
    $('#s-composer', el).hidden = view !== 'console' || !can('command');
    el.classList.toggle('has-composer', view === 'console' && can('command'));
    $('#s-jump', el).classList.remove('show');
    if (view === 'console') showConsole();
    else if (view === 'players') showPlayers();
    else showOverview();
    if (view !== 'console') scroller.scrollTop = 0;
  };

  const header = () => {
    const s = server();
    if (!s) return pop();
    $('#s-name', el).textContent = s.name;
    $('#s-dot', el).className = `dot ${s.status}`;
  };

  header();
  requestAnimationFrame(moveThumb);
  show();
  subscribe(`console:${id}`);

  let lastPatch = 0;
  return {
    update() {
      header();
      if (!server()) return;
      // Stats arrive every couple of seconds; redraw the live views, not the console.
      if (view === 'overview' && Date.now() - lastPatch > 900) {
        lastPatch = Date.now();
        showOverview();
      }
      if (view === 'players' && Date.now() - lastPatch > 5000) {
        lastPatch = Date.now();
        const top = scroller.scrollTop;
        showPlayers().then(() => (scroller.scrollTop = top));
      }
    },
    onConsole(serverId, msg) {
      if (serverId !== id || view !== 'console') return;
      const log = $('#s-log', el);
      if (!log) return;
      if (msg.type === 'clear') log.innerHTML = '';
      else {
        if (log.firstElementChild?.classList.contains('system') && log.children.length === 1) log.innerHTML = '';
        log.insertAdjacentHTML('beforeend', (msg.lines || []).map(lineHtml).join(''));
        while (log.children.length > 600) log.firstElementChild.remove();
      }
      if (pinned) toBottom();
    },
    destroy() {
      unsubscribe(`console:${id}`);
    },
  };
}

async function power(server, action) {
  try {
    await api(`/api/servers/${server.id}/power`, { method: 'POST', body: { action } });
    toast({ start: 'Starting…', stop: 'Stopping…', restart: 'Restarting…', kill: 'Stopped' }[action]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function powerSheet(server) {
  if (!server) return;
  const on = server.status === 'running' || server.status === 'starting';
  const actions = [];
  if (can('power')) {
    if (on) actions.push({ label: 'Restart', run: () => power(server, 'restart') }, { label: 'Stop', danger: true, run: () => power(server, 'stop') });
    else actions.push({ label: 'Start', run: () => power(server, 'start') });
  }
  actions.push({ label: 'Copy address', run: () => copy(addressOf(server)) });
  sheet({ title: server.name, actions });
}

function playerSheet(server, name, online) {
  const actions = [];
  const commands = can('command') ? server.playerCommands || [] : [];
  const lists = can('command') ? server.playerLists || [] : [];
  const listAction = (list, action, label, danger = false) => ({
    label,
    danger,
    run: async () => {
      await api(`/api/servers/${server.id}/player-lists`, { method: 'POST', body: { list, action, name } });
      toast(`${label}: ${name}`);
    },
  });
  if (online && commands.includes('kick'))
    actions.push({ label: 'Kick', run: () => api(`/api/servers/${server.id}/players/action`, { method: 'POST', body: { action: 'kick', name } }).then(() => toast(`Kicked ${name}`)) });
  if (lists.includes('whitelist')) actions.push(listAction('whitelist', 'add', 'Add to whitelist'));
  if (lists.includes('ops')) actions.push(listAction('ops', 'add', 'Make operator'));
  if (lists.includes('bans')) actions.push(listAction('bans', 'add', 'Ban', true));
  else if (online && commands.includes('ban'))
    actions.push({ label: 'Ban', danger: true, run: () => api(`/api/servers/${server.id}/players/action`, { method: 'POST', body: { action: 'ban', name } }).then(() => toast(`Banned ${name}`)) });
  sheet({ title: name, actions });
}

/* ---------------------------------------------------------- notifications */

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function notificationsScreen(el) {
  el.innerHTML = `
    <div class="topbar">
      <button class="glass glass-btn" id="n-back" aria-label="Back">${ICON.back}</button>
      <div class="glass title-capsule"><span>Notifications</span></div>
      <span></span>
    </div>
    <div class="scroll"><h1 class="large-title">Notifications</h1><div id="n-body"></div></div>`;
  $('#n-back', el).addEventListener('click', pop);
  const body = $('#n-body', el);

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported || (/iPhone|iPad/.test(navigator.userAgent) && !standalone())) {
    body.innerHTML = `<p class="subtitle" style="margin-top:-6px">Get a buzz when a server crashes or a backup fails.</p>
      <div class="group flat"><div class="row"><span class="row-main"><div class="row-title" style="white-space:normal">Add GamePanel to your Home Screen first</div>
      <div class="row-sub" style="white-space:normal">In Safari tap Share, then Add to Home Screen. Open it from there and come back here. Needs iOS 16.4 or newer.</div></span></div></div>`;
    return {};
  }

  let endpoint = '';
  const draw = async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    endpoint = sub?.endpoint || '';
    const info = await api(`/api/push?endpoint=${encodeURIComponent(endpoint)}`);
    const on = Boolean(sub && info.subscribed);
    body.innerHTML = `
      <p class="subtitle" style="margin-top:-6px">${Notification.permission === 'denied' ? 'Notifications are blocked. Turn them on in Settings, Notifications, GamePanel.' : 'Get a buzz when something needs you.'}</p>
      <div class="group flat"><label class="row"><span class="row-main"><div class="row-title">Allow notifications</div></span>
        <input type="checkbox" class="ios-switch" id="n-on" ${on ? 'checked' : ''} ${Notification.permission === 'denied' ? 'disabled' : ''}/></label></div>
      ${
        on
          ? `<div class="section-label">Tell me when</div><div class="group flat">${Object.entries(info.choices)
              .map(([id, label]) => `<label class="row"><span class="row-main"><div class="row-title" style="font-weight:500">${esc(label)}</div></span><input type="checkbox" class="ios-switch" data-ev="${esc(id)}" ${info.events.includes(id) ? 'checked' : ''}/></label>`)
              .join('')}</div>
             <div class="section-label"></div><div class="group flat"><button class="row" id="n-test"><span class="row-main"><div class="row-title lime">Send a test notification</div></span></button></div>`
          : ''
      }`;

    $('#n-on', el).addEventListener('change', async (e) => {
      e.target.disabled = true;
      try {
        if (e.target.checked) {
          if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed');
          const fresh =
            (await reg.pushManager.getSubscription()) ||
            (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(info.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) }));
          await api('/api/push', { method: 'POST', body: { subscription: fresh.toJSON(), device: /iPhone/.test(navigator.userAgent) ? 'iPhone' : navigator.platform } });
          toast('Notifications on');
        } else {
          const current = await reg.pushManager.getSubscription();
          if (current) {
            await api('/api/push', { method: 'DELETE', body: { endpoint: current.endpoint } });
            await current.unsubscribe();
          }
          toast('Notifications off');
        }
      } catch (err) {
        toast(err.message, 'error');
      }
      draw();
    });
    body.querySelectorAll('[data-ev]').forEach((box) =>
      box.addEventListener('change', async () => {
        const events = [...body.querySelectorAll('[data-ev]:checked')].map((b) => b.dataset.ev);
        const current = await reg.pushManager.getSubscription();
        await api('/api/push', { method: 'POST', body: { subscription: current.toJSON(), events } }).catch((err) => toast(err.message, 'error'));
      })
    );
    $('#n-test', el)?.addEventListener('click', () =>
      api('/api/push/test', { method: 'POST', body: { endpoint } })
        .then(() => toast('Sent. It should arrive in a moment.'))
        .catch((err) => toast(err.message, 'error'))
    );
  };
  draw().catch((err) => (body.innerHTML = `<div class="empty">${esc(err.message)}</div>`));
  return {};
}

/** Open a server from a notification tap (/app/#server/<id>). */
function openFromHash(hash = location.hash) {
  const m = String(hash).match(/#server\/([\w-]+)/);
  if (!m || !state.servers.some((s) => s.id === m[1])) return;
  history.replaceState(null, '', '/app/');
  push((s) => serverScreen(s, m[1]));
}
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'open' && state.user) openFromHash(new URL(event.data.url, location.origin).hash);
});

/* ------------------------------------------------------------------ boot */

async function start() {
  const { servers } = await api('/api/servers');
  state.servers = servers;
  connect();
  resetStack(homeScreen);
  openFromHash();
}

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
  try {
    const status = await api('/api/status');
    if (status.setupRequired) {
      location.href = '/';
      return;
    }
    state.user = (await api('/api/auth/me')).user;
    await start();
  } catch {
    if (!state.user) showAuth();
  }
})();
