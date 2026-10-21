import { esc } from '../../core/util.js';

/* ----------------------------------------------- Minecraft skin previews */

/*
 * Skins come from the panel (/api/servers/:id/players/:name/skin), which
 * fetches them from Mojang (Java) or the Geyser global API (Bedrock) and
 * caches them. The browser only ever talks to the panel. Heads in lists are
 * the skin PNG cropped with CSS; the body preview is drawn on a canvas.
 */

export const skinUrl = (serverId, name) => `/api/servers/${encodeURIComponent(serverId)}/players/${encodeURIComponent(name)}/skin`;

/** The face (with hat layer) as small pixelated tile; the page's image-error handler swaps in a letter when there is no skin. */
export function faceHtml(serverId, name, size, letter) {
  const url = esc(skinUrl(serverId, name));
  const big = size * 8;
  const img = (x, y) => `<img src="${url}" alt="" loading="lazy" data-mc-letter="${esc(letter)}" style="position:absolute;left:${-x * size}px;top:${-y * size}px;width:${big}px;height:auto;max-width:none;border-radius:0;image-rendering:pixelated" />`;
  return `<span style="position:relative;display:block;width:${size}px;height:${size}px;overflow:hidden">${img(1, 1)}${img(5, 1)}</span>`;
}

// No skin (offline-mode server, unknown name): show the letter instead. Image errors do not bubble, hence capture.
document.addEventListener(
  'error',
  (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.dataset.mcLetter !== undefined) img.parentElement.replaceWith(document.createTextNode(img.dataset.mcLetter));
  },
  true
);

function load(url) {
  return fetch(url, { credentials: 'same-origin' }).then(async (res) => {
    if (!res.ok) throw new Error('no skin');
    const slim = res.headers.get('X-Skin-Model') === 'slim';
    const bmp = await createImageBitmap(await res.blob());
    return { bmp, slim };
  });
}

/** Draw the front of the player (and a big head) into `box`. */
export async function renderSkinPreview(box, serverId, name) {
  let skin;
  try {
    skin = await load(skinUrl(serverId, name));
  } catch {
    box.innerHTML = '<div class="faint" style="font-size:12.5px">No skin to show (offline-mode server, no account with that name, or no internet on the panel).</div>';
    return;
  }
  if (!box.isConnected) return;
  const { bmp, slim } = skin;
  const modern = bmp.height >= 64;
  const arm = slim ? 3 : 4;
  const scale = 6;
  const body = document.createElement('canvas');
  body.width = 16 * scale;
  body.height = 32 * scale;
  const c = body.getContext('2d');
  c.imageSmoothingEnabled = false;
  const part = (sx, sy, w, h, dx, dy, flip = false) => {
    c.save();
    if (flip) {
      c.translate((dx + w) * scale, dy * scale);
      c.scale(-1, 1);
      c.drawImage(bmp, sx, sy, w, h, 0, 0, w * scale, h * scale);
    } else c.drawImage(bmp, sx, sy, w, h, dx * scale, dy * scale, w * scale, h * scale);
    c.restore();
  };
  // Layout, facing the viewer: the player's right arm and leg are on the left of the picture.
  part(8, 8, 8, 8, 4, 0);
  part(20, 20, 8, 12, 4, 8);
  part(4, 20, 4, 12, 4, 20);
  part(44, 20, arm, 12, 4 - arm, 8);
  if (modern) {
    part(20, 52, 4, 12, 8, 20);
    part(36, 52, arm, 12, 12, 8);
  } else {
    part(4, 20, 4, 12, 8, 20, true);
    part(44, 20, arm, 12, 12, 8, true);
  }
  part(40, 8, 8, 8, 4, 0); // hat
  if (modern) {
    part(20, 36, 8, 12, 4, 8); // jacket
    part(4, 36, 4, 12, 4, 20);
    part(4, 52, 4, 12, 8, 20);
    part(44, 36, arm, 12, 4 - arm, 8);
    part(52, 52, arm, 12, 12, 8);
  }
  body.className = 'mc-skin-body';
  body.setAttribute('role', 'img');
  body.setAttribute('aria-label', `${name}'s skin`);
  box.innerHTML = '';
  box.appendChild(body);
}
