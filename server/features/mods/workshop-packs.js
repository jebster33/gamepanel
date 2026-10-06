'use strict';

/**
 * Workshop packs: a named list of Steam Workshop items for one game, saved on
 * the panel so it can be put onto any server of that game in one go. Made
 * from a collection link, a list of item links, or what a server already has.
 *
 * settings.workshopPacks = [{ id, name, appId, items: [id], createdBy, createdAt }]
 */

const { uid, fail } = require('../../core/util');
const steam = require('./providers/workshop');
const manifest = require('./manifest');

const MAX_ITEMS = 300;

const all = (store) => store.state.settings.workshopPacks || [];

/** Collections are opened up into their items; the result keeps the order given. */
async function expand(input) {
  const ids = [];
  for (const id of steam.parseIds(input)) {
    const children = await steam.collection(id).catch(() => null);
    ids.push(...(children || [id]));
  }
  return [...new Set(ids)];
}

/** Names and pictures for the items, checked against the game. */
async function preview(input, appId) {
  const ids = await expand(input);
  if (ids.length > MAX_ITEMS) fail(400, `A pack can hold up to ${MAX_ITEMS} items`);
  const items = [];
  for (let i = 0; i < ids.length; i += 100) items.push(...(await steam.details(ids.slice(i, i + 100))));
  // Old collections often hold items that were since removed or made private: leave those out.
  const skipped = items.filter((i) => !i.ok).map((i) => i.id);
  const found = items.filter((i) => i.ok);
  const wrong = found.filter((i) => appId && i.appId && String(i.appId) !== String(appId));
  if (wrong.length) fail(400, `"${wrong[0].title}" is a Workshop item for a different game.`);
  if (!found.length) fail(404, 'None of those Workshop items exist or are public');
  return { items: found.map((i) => ({ id: i.id, title: i.title, icon: i.icon, url: i.url })), skipped };
}

function list(store, appId) {
  return all(store).filter((p) => !appId || p.appId === String(appId));
}

async function create(store, { name, appId, input, fromServer }, user) {
  const label = String(name || '').trim().slice(0, 60);
  if (!label) fail(400, 'Give the pack a name');
  if (!appId) fail(400, 'This game has no Steam Workshop');
  let items;
  if (fromServer) {
    items = manifest
      .load(fromServer)
      .filter((m) => m.provider === 'workshop' && !m.auto)
      .map((m) => String(m.projectId));
    if (!items.length) fail(400, 'This server has no Workshop items yet');
  } else {
    items = (await preview(input, appId)).items.map((i) => i.id);
  }
  if (!items.length) fail(400, 'The pack is empty');
  const pack = { id: uid(8), name: label, appId: String(appId), items: items.slice(0, MAX_ITEMS), createdBy: user?.username || 'panel', createdAt: Date.now() };
  store.state.settings.workshopPacks = [...all(store), pack];
  store.save();
  return pack;
}

function remove(store, id) {
  const before = all(store).length;
  store.state.settings.workshopPacks = all(store).filter((p) => p.id !== id);
  if (store.state.settings.workshopPacks.length === before) fail(404, 'No such pack');
  store.save();
}

function get(store, id) {
  const pack = all(store).find((p) => p.id === id);
  if (!pack) fail(404, 'No such pack');
  return pack;
}

module.exports = { list, create, remove, get, preview, expand, MAX_ITEMS };
