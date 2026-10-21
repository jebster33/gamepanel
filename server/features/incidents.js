'use strict';

/**
 * Incident notes for the public status page, with a longer uptime history.
 *
 * An incident is a short story anyone can read: a title, the servers it
 * touches, and updates as it goes (investigating → identified → monitoring →
 * resolved). Staff write them; a server that crashes and stays down for two
 * minutes also opens one by itself, and closes it when the server is back.
 * Maintenance windows are announced the same way.
 *
 * state.incidents = [{ id, title, impact, serverIds, startedAt, resolvedAt, auto, status, updates: [{ at, status, text }] }]
 */

const { uid, fail } = require('../core/util');

const STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'];
const IMPACTS = ['minor', 'major', 'maintenance'];
const KEEP = 200;
const AUTO_AFTER_MS = 2 * 60_000;
const downSince = new Map();

const list = (store) => (store.state.incidents ||= []);
const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

function add(store, body = {}, by) {
  const title = clean(body.title, 120);
  if (!title) fail(400, 'Give the incident a title');
  const impact = IMPACTS.includes(body.impact) ? body.impact : 'minor';
  const status = impact === 'maintenance' && body.status === 'scheduled' ? 'monitoring' : STATUSES.includes(body.status) ? body.status : 'investigating';
  const text = clean(body.text, 1000);
  const incident = {
    id: uid(6),
    title,
    impact,
    serverIds: Array.isArray(body.serverIds) ? body.serverIds.map(String).slice(0, 50) : [],
    startedAt: Date.now(),
    resolvedAt: status === 'resolved' ? Date.now() : null,
    auto: false,
    status,
    by: by || null,
    updates: text ? [{ at: Date.now(), status, text }] : [],
  };
  const all = list(store);
  all.unshift(incident);
  if (all.length > KEEP) all.length = KEEP;
  store.save();
  return incident;
}

function addUpdate(store, id, body = {}) {
  const incident = list(store).find((i) => i.id === id);
  if (!incident) fail(404, 'Incident not found');
  const status = STATUSES.includes(body.status) ? body.status : incident.status;
  const text = clean(body.text, 1000);
  if (!text && status === incident.status) fail(400, 'Write an update or change the status');
  incident.status = status;
  incident.resolvedAt = status === 'resolved' ? incident.resolvedAt || Date.now() : null;
  if (text || status !== incident.updates[0]?.status) incident.updates.unshift({ at: Date.now(), status, text: text || `Status: ${status}` });
  if (incident.updates.length > 40) incident.updates.length = 40;
  store.save();
  return incident;
}

function remove(store, id) {
  const all = list(store);
  const i = all.findIndex((x) => x.id === id);
  if (i === -1) fail(404, 'Incident not found');
  all.splice(i, 1);
  store.save();
}

/** For the public page: only servers the page shows, no staff names, the last 90 days. */
function publicList(store, visibleIds, now = Date.now()) {
  const show = new Set(visibleIds);
  return list(store)
    .filter((i) => now - (i.resolvedAt || now) < 90 * 86400_000 && (!i.serverIds.length || i.serverIds.some((id) => show.has(id))))
    .slice(0, 40)
    .map((i) => ({ id: i.id, title: i.title, impact: i.impact, status: i.status, startedAt: i.startedAt, resolvedAt: i.resolvedAt, auto: i.auto, serverIds: i.serverIds.filter((id) => show.has(id)), updates: i.updates.map((u) => ({ at: u.at, status: u.status, text: u.text })) }));
}

/** Open an incident for a server that stays down, and close it when it is back. */
function tick(manager, store, now) {
  const page = store.state.settings.statusPage;
  if (!page?.enabled) return;
  for (const id of page.servers || []) {
    const server = manager.servers.find((s) => s.id === id);
    if (!server) continue;
    const status = manager.rt(id).status;
    const down = status === 'crashed';
    const open = list(store).find((i) => i.auto && !i.resolvedAt && i.serverIds[0] === id);
    if (down) {
      if (!downSince.has(id)) downSince.set(id, now);
      if (!open && now - downSince.get(id) >= AUTO_AFTER_MS) {
        const created = add(store, { title: `${server.name} is down`, impact: 'major', serverIds: [id], text: 'The server stopped unexpectedly. We are looking into it.' });
        created.auto = true;
        store.save();
      }
    } else {
      downSince.delete(id);
      if (open && status === 'running') addUpdate(store, open.id, { status: 'resolved', text: 'The server is back online.' });
    }
  }
}

module.exports = { list, add, addUpdate, remove, publicList, tick, STATUSES, IMPACTS };
