import { api } from '../../core/api.js';
import { esc, toast } from '../../core/util.js';

/* ------------------------------------- Minecraft server-list appearance */

/*
 * The server icon and MOTD, edited against a live copy of how the server
 * looks in Minecraft's multiplayer list. Colours use Minecraft's § codes.
 */

const COLORS = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
  8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};
const FORMATS = [
  ['l', 'B', 'Bold'],
  ['o', 'I', 'Italic'],
  ['n', 'U', 'Underline'],
  ['m', 'S', 'Strikethrough'],
  ['k', '?', 'Obfuscated (scrambles)'],
  ['r', '⟲', 'Reset'],
];

/** server.properties form ("§a…\n…") ↔ what people edit ("§a…" over two lines). */
const decode = (v) => String(v || '').replace(/\\u00a7/gi, '§').replace(/\\n/g, '\n');
const encode = (v) => String(v).replace(/§/g, '\\u00A7').replace(/\r?\n/g, '\\n');

export function motdHtml(text) {
  let style = { color: COLORS[7] };
  let out = '';
  const lines = decode(text).split('\n').slice(0, 2);
  lines.forEach((line, i) => {
    if (i) out += '<br>';
    style = { color: COLORS[7] };
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '§' && j + 1 < line.length) {
        const code = line[++j].toLowerCase();
        if (COLORS[code]) style = { color: COLORS[code] };
        else if (code === 'r') style = { color: COLORS[7] };
        else style = { ...style, [code]: true };
        continue;
      }
      const css = [`color:${style.color}`, style.l && 'font-weight:700', style.o && 'font-style:italic', (style.n || style.m) && `text-decoration:${[style.n && 'underline', style.m && 'line-through'].filter(Boolean).join(' ')}`]
        .filter(Boolean)
        .join(';');
      out += `<span style="${css}"${style.k ? ' class="mc-obf"' : ''}>${esc(line[j])}</span>`;
    }
  });
  return out;
}

export function renderAppearance(host, server, fields) {
  const motd = fields.get('motd');
  if (!motd) return;
  const running = server.status === 'running';
  let value = decode(motd.value);
  let iconUrl = `/api/servers/${server.id}/icon?t=${Date.now()}`;

  host.innerHTML = `
    <div class="card mb-16">
      <h4 style="margin:0 0 12px">How it looks in Minecraft</h4>
      <div class="mc-list">
        <div class="mc-entry">
          <img class="mc-icon" id="ap-icon" src="${iconUrl}" alt="" />
          <div class="mc-text">
            <div class="mc-top"><span class="mc-name">${esc(server.name)}</span><span class="mc-count">${running ? `${server.players ?? 0}/${server.maxPlayers || 20}` : '0/20'} <span class="mc-bars"><i></i><i></i><i></i><i></i><i></i></span></span></div>
            <div class="mc-motd" id="ap-preview"></div>
          </div>
        </div>
      </div>
      <div class="ap-grid">
        <div>
          <div class="field-label">Icon</div>
          <label class="btn btn-sm" style="display:inline-flex">Upload image<input type="file" id="ap-file" accept="image/*" hidden /></label>
          <div class="hint">Any picture works. It is cropped to a square and scaled to 64×64.</div>
        </div>
        <div>
          <div class="field-label">Description (MOTD)</div>
          <div class="mc-tools">${Object.entries(COLORS)
            .map(([c, hex]) => `<button type="button" class="mc-swatch" data-code="${c}" style="background:${hex}" title="§${c}"></button>`)
            .join('')}${FORMATS.map(([c, label, title]) => `<button type="button" class="mc-fmt" data-code="${c}" title="${title}">${label}</button>`).join('')}</div>
          <textarea id="ap-motd" rows="2" class="mono" spellcheck="false">${esc(value)}</textarea>
          <div class="row" style="justify-content:space-between;margin-top:8px">
            <span class="hint" style="margin:0">Two lines at most. Pick a colour, then type.</span>
            <button class="btn btn-primary btn-sm" id="ap-save">Save description</button>
          </div>
        </div>
      </div>
    </div>`;

  const icon = host.querySelector('#ap-icon');
  icon.addEventListener('error', () => (icon.src = '/img/logo-192.png'), { once: true });
  const area = host.querySelector('#ap-motd');
  const preview = () => (host.querySelector('#ap-preview').innerHTML = motdHtml(encode(area.value)));
  preview();
  area.addEventListener('input', () => {
    const lines = area.value.split('\n');
    if (lines.length > 2) area.value = lines.slice(0, 2).join('\n');
    preview();
  });

  host.querySelectorAll('[data-code]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const code = `§${btn.dataset.code}`;
      const { selectionStart: a, selectionEnd: b } = area;
      area.value = area.value.slice(0, a) + code + area.value.slice(b);
      area.focus();
      area.selectionStart = area.selectionEnd = a + code.length;
      preview();
    })
  );

  host.querySelector('#ap-save').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const r = await api(`/api/servers/${server.id}/game-settings`, { method: 'PUT', body: { values: { motd: encode(area.value) } } });
      toast(r.restartNeeded ? 'Saved. Restart the server to show it.' : 'Description saved');
    } catch (err) {
      toast(err.message, 'error');
    }
    btn.disabled = false;
  });

  host.querySelector('#ap-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const png = await toIcon(file);
      await api(`/api/servers/${server.id}/icon`, { method: 'PUT', body: { png } });
      icon.src = png;
      toast(running ? 'Icon saved. Restart the server to show it.' : 'Icon saved');
    } catch (err) {
      toast(err.message || 'Could not read that image', 'error');
    }
  });
}

/** Centre-crop to a square and scale to the 64×64 PNG Minecraft wants. */
function toIcon(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 64, 64);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('That file is not an image the browser can read'));
    img.src = URL.createObjectURL(file);
  });
}
