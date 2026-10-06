/* The public ban appeal page: /appeal */

const $ = (sel) => document.querySelector(sel);

async function call(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function say(el, text, error = false) {
  el.textContent = text;
  el.classList.toggle('error', error);
}

const STATUS = { open: 'Waiting for an admin', accepted: 'Accepted: your ban is lifted', denied: 'Denied' };

async function check(code) {
  const out = $('#check-msg');
  say(out, 'Checking…');
  try {
    const a = await call(`/api/public/appeals/${encodeURIComponent(code.trim().toUpperCase())}`);
    out.innerHTML = '';
    const line = document.createElement('div');
    line.className = `status ${a.status}`;
    line.textContent = `${a.name}: ${STATUS[a.status] || a.status}`;
    out.append(line);
    if (a.reply) {
      const reply = document.createElement('div');
      reply.className = 'reply';
      reply.textContent = a.reply;
      out.append(reply);
    }
  } catch (err) {
    say(out, err.message, true);
  }
}

async function start() {
  let info = { enabled: false };
  try {
    info = await call('/api/public/appeals');
  } catch {
    /* shown as closed */
  }
  $('#brand').textContent = info.panelName || '';
  if (info.panelName) document.title = `Ban appeal · ${info.panelName}`;
  if (info.accent && /^#[0-9a-f]{6}$/i.test(info.accent)) document.documentElement.style.setProperty('--lime', info.accent);
  if (info.intro) $('#intro').textContent = info.intro;
  if (!info.enabled) {
    $('#closed').classList.remove('hidden');
    $('#form').classList.add('hidden');
  }

  $('#form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = $('#send');
    btn.disabled = true;
    say($('#form-msg'), '');
    try {
      const { code } = await call('/api/public/appeals', {
        method: 'POST',
        body: { name: $('#name').value, message: $('#message').value, contact: $('#contact').value },
      });
      $('#form').classList.add('hidden');
      $('#done').classList.remove('hidden');
      $('#new-code').textContent = code;
      $('#code').value = code;
      try {
        localStorage.setItem('gp-appeal-code', code);
      } catch {
        /* private mode */
      }
    } catch (err) {
      say($('#form-msg'), err.message, true);
      btn.disabled = false;
    }
  });

  $('#check').addEventListener('submit', (event) => {
    event.preventDefault();
    if ($('#code').value.trim()) check($('#code').value);
  });

  const fromLink = new URLSearchParams(location.search).get('code');
  let saved = null;
  try {
    saved = localStorage.getItem('gp-appeal-code');
  } catch {
    /* private mode */
  }
  const code = fromLink || saved;
  if (code) {
    $('#code').value = code;
    check(code);
  }
}

start();
