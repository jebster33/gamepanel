'use strict';

/**
 * Home-screen widgets. A widget link shows a handful of servers (status and
 * players) to a phone widget without signing in: iOS Scriptable, Android KWGT
 * or Glance, anything that can fetch JSON or show an image.
 *
 * A widget is a random token. The panel keeps only a hash of it, so the link
 * is shown once. It reveals server names, game, status and player counts of
 * the servers picked, nothing else, and can be deleted any time.
 *
 * settings.widgets = [{ id, name, hash, serverIds, createdAt, lastUsed }]
 */

const crypto = require('crypto');
const { fail, uid } = require('../core/util');

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const list = (store) => (store.state.settings.widgets ||= []);

function create(store, body = {}) {
  const name = String(body.name || '').trim().slice(0, 40) || 'Phone widget';
  const serverIds = Array.isArray(body.serverIds) ? body.serverIds.map(String).slice(0, 12) : [];
  if (list(store).length >= 20) fail(400, '20 widgets at most');
  const token = crypto.randomBytes(18).toString('base64url');
  const widget = { id: uid(6), name, hash: hashOf(token), serverIds, createdAt: Date.now(), lastUsed: null };
  list(store).push(widget);
  store.save();
  return { widget: summary(widget), token };
}

const summary = (w) => ({ id: w.id, name: w.name, serverIds: w.serverIds, createdAt: w.createdAt, lastUsed: w.lastUsed });
const all = (store) => list(store).map(summary);

function remove(store, id) {
  const l = list(store);
  const i = l.findIndex((w) => w.id === id);
  if (i === -1) fail(404, 'Widget not found');
  l.splice(i, 1);
  store.save();
}

function find(store, token) {
  const h = hashOf(token);
  return list(store).find((w) => {
    const a = Buffer.from(w.hash);
    const b = Buffer.from(h);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

function data(store, manager, token) {
  const w = find(store, token);
  if (!w) return null;
  w.lastUsed = Date.now();
  const servers = (w.serverIds.length ? w.serverIds : manager.servers.slice(0, 6).map((s) => s.id))
    .map((id) => manager.servers.find((s) => s.id === id))
    .filter(Boolean)
    .map((server) => {
      const p = manager.publicServer(server);
      return { name: server.name, game: p.templateName, status: p.status === 'running' ? 'online' : p.status === 'starting' ? 'starting' : 'offline', players: p.status === 'running' ? p.players ?? p.playerList.length : 0, maxPlayers: p.maxPlayers };
    });
  return { name: w.name, servers, updatedAt: Date.now() };
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A small picture of the same data, for widgets that can only show an image. */
function badgeSvg(d) {
  const rows = d.servers.slice(0, 6);
  const h = 34 + rows.length * 26;
  const color = { online: '#7bd88f', starting: '#ffb340', offline: '#8a8f98' };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${h}" viewBox="0 0 320 ${h}" font-family="system-ui,sans-serif">
<rect width="320" height="${h}" rx="14" fill="#111210"/>
<text x="16" y="24" fill="#c6f432" font-size="12" font-weight="700" letter-spacing="1">${esc(d.name.toUpperCase())}</text>
${rows.map((s, i) => `<circle cx="22" cy="${52 + i * 26}" r="5" fill="${color[s.status]}"/><text x="36" y="${56 + i * 26}" fill="#f2f2ee" font-size="14">${esc(s.name.slice(0, 24))}</text><text x="304" y="${56 + i * 26}" fill="#aab" font-size="13" text-anchor="end">${s.status === 'online' ? `${s.players}${s.maxPlayers ? `/${s.maxPlayers}` : ''}` : esc(s.status)}</text>`).join('\n')}
</svg>`;
}

/** The Scriptable (iOS) script with this panel's address filled in. */
function scriptable(origin) {
  return `// GamePanel widget for Scriptable. Put the widget link's token in TOKEN.
const TOKEN = args.widgetParameter || "PASTE_TOKEN_HERE";
const data = await new Request("${origin}/api/public/widget/" + TOKEN).loadJSON();
const w = new ListWidget();
w.backgroundColor = new Color("#111210");
const title = w.addText(data.name.toUpperCase());
title.font = Font.boldSystemFont(11);
title.textColor = new Color("#c6f432");
w.addSpacer(6);
for (const s of data.servers.slice(0, 5)) {
  const row = w.addText((s.status === "online" ? "● " : "○ ") + s.name + "  " + (s.status === "online" ? s.players + (s.maxPlayers ? "/" + s.maxPlayers : "") : s.status));
  row.font = Font.systemFont(13);
  row.textColor = s.status === "online" ? Color.white() : Color.gray();
}
w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
if (config.runsInWidget) Script.setWidget(w); else await w.presentSmall();
Script.complete();
`;
}

module.exports = { create, all, remove, data, badgeSvg, scriptable };
