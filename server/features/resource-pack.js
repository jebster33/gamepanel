'use strict';

/**
 * Resource pack hosting for Minecraft Java servers: upload a pack, the panel
 * serves it at an unguessable public address and writes resource-pack,
 * resource-pack-sha1, require-resource-pack and resource-pack-prompt into
 * server.properties, so players get it when they join.
 *
 * The public address serves that one file and nothing else. The zip lives in
 * <data>/resource-packs/<serverId>.zip, out of reach of the server's own Files tab,
 * so the hash in server.properties always matches what is served.
 *
 * settings.resourcePacks[serverId] = { slug, name, size, sha1, uploadedAt, require, prompt, baseUrl }
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { fail } = require('../core/util');
const { config } = require('../core/config');
const zip = require('../core/zip');
const { isJava } = require('./datapacks');

// Minecraft's client refuses larger packs.
const MAX_SIZE = 250 * 1024 * 1024;
const MARK = '/api/public/resource-pack/';

const all = (store) => (store.state.settings.resourcePacks ||= {});
const fileFor = (serverId) => path.join(config.dataDir, 'resource-packs', `${String(serverId).replace(/[^\w-]/g, '_')}.zip`);

function need(server) {
  if (!isJava(server)) fail(400, 'Resource packs are for Minecraft Java servers');
}

/** The address players reach the panel at: the admin's choice, else the one this request came in on. */
function origin(req, saved) {
  if (saved) return saved;
  const { isSecure } = require('../api/helpers');
  const host = /^[A-Za-z0-9.:[\]-]+$/.test(req?.headers?.host || '') ? req.headers.host : 'localhost';
  return `${isSecure(req) ? 'https' : 'http'}://${host}`;
}

// Before a start there is no request: use the address the last change came in on.
const urlOf = (cfg, req) => `${cfg.baseUrl || (req ? origin(req, '') : cfg.lastBase || 'http://localhost')}${MARK}${cfg.slug}/pack.zip`;

function cleanBase(value) {
  const v = String(value || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/i.test(v)) fail(400, 'The address must look like https://panel.example.com (no path)');
  return v;
}

/** The prompt is a JSON chat component inside server.properties: plain text only, no quotes or backslashes. */
const cleanPrompt = (v) => String(v || '').replace(/[\\"\u0000-\u001f]/g, '').trim().slice(0, 200);

function checkZip(buf) {
  let z;
  try {
    z = zip.open(buf);
  } catch {
    fail(400, 'That is not a zip file');
  }
  try {
    if (z.has('pack.mcmeta')) return;
    const nested = z.names.find((n) => /^[^/]+\/pack\.mcmeta$/.test(n));
    if (nested) fail(400, `pack.mcmeta is inside the folder "${nested.split('/')[0]}" in this zip. Zip what is inside that folder instead, so pack.mcmeta is at the top.`);
    fail(400, 'This zip has no pack.mcmeta, so Minecraft would not accept it as a resource pack');
  } finally {
    z.close();
  }
}

function view(manager, store, server, req) {
  need(server);
  const cfg = all(store)[server.id];
  const base = { running: manager.rt(server.id).status === 'running', maxSize: MAX_SIZE, baseUrl: cfg?.baseUrl || '', detectedBase: origin(req, '') };
  if (!cfg?.slug) return { ...base, pack: null };
  const current = manager.readProperties(server).match(/^resource-pack=(.*)$/m)?.[1]?.trim() || '';
  const applied = current.includes(`${MARK}${cfg.slug}/pack.zip`);
  return { ...base, pack: { name: cfg.name, size: cfg.size, sha1: cfg.sha1, uploadedAt: cfg.uploadedAt, require: Boolean(cfg.require), prompt: cfg.prompt || '', url: applied ? current : urlOf(cfg, req), applied } };
}

/** Write the keys into server.properties. */
function apply(manager, server, cfg, req) {
  if (req) cfg.lastBase = origin(req, '');
  manager.setProperties(server, {
    'resource-pack': urlOf(cfg, req),
    'resource-pack-sha1': cfg.sha1,
    'require-resource-pack': cfg.require ? 'true' : 'false',
    'resource-pack-prompt': cfg.prompt ? JSON.stringify({ text: cfg.prompt }) : '',
  });
}

/** Before each start: keep server.properties in line with the pack (a game-settings edit may have changed it). */
function reapply(manager, store, server) {
  const cfg = all(store)[server.id];
  if (!cfg?.slug || !fs.existsSync(fileFor(server.id)) || !isJava(server)) return;
  const wasUrl = manager.readProperties(server).match(/^resource-pack=(.*)$/m)?.[1]?.trim();
  // Only when it already points at this pack: a pack the admin set by hand is left alone.
  if (wasUrl && wasUrl.includes(`${MARK}${cfg.slug}/`)) apply(manager, server, cfg, null);
}

async function upload(manager, store, server, name, buf, req, actor) {
  need(server);
  if (!buf.length) fail(400, 'That file is empty');
  if (buf.length > MAX_SIZE) fail(400, 'Minecraft does not accept resource packs over 250 MB');
  checkZip(buf);
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const target = fileFor(server.id);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temp, buf);
    await fsp.rename(temp, target);
  } finally {
    await fsp.rm(temp, { force: true });
  }
  const cfg = { require: false, prompt: '', baseUrl: '', ...(all(store)[server.id] || {}) };
  cfg.slug ||= crypto.randomBytes(12).toString('base64url');
  Object.assign(cfg, { name: path.basename(String(name || 'pack.zip')).replace(/[^\w.+\- ()]/g, '_').slice(0, 80) || 'pack.zip', size: buf.length, sha1, uploadedAt: Date.now() });
  all(store)[server.id] = cfg;
  apply(manager, server, cfg, req);
  store.save();
  manager.logActivity?.(server.id, { type: 'datapack', text: `Resource pack ${cfg.name} uploaded`, by: actor });
  store.addEvent('mod.installed', `Resource pack ${cfg.name} hosted for ${server.name}`, { serverId: server.id });
  return view(manager, store, server, req);
}

function update(manager, store, server, body, req) {
  need(server);
  const cfg = all(store)[server.id];
  if (!cfg?.slug) fail(404, 'Upload a resource pack first');
  if (body.require !== undefined) cfg.require = Boolean(body.require);
  if (body.prompt !== undefined) cfg.prompt = cleanPrompt(body.prompt);
  if (body.baseUrl !== undefined) cfg.baseUrl = cleanBase(body.baseUrl);
  if (body.newLink) cfg.slug = crypto.randomBytes(12).toString('base64url');
  apply(manager, server, cfg, req);
  store.save();
  return view(manager, store, server, req);
}

async function remove(manager, store, server, actor) {
  need(server);
  const cfg = all(store)[server.id];
  if (!cfg) return { ok: true };
  // Only clear what points at this pack.
  if (manager.readProperties(server).match(/^resource-pack=(.*)$/m)?.[1]?.includes(`${MARK}${cfg.slug}/`)) {
    manager.setProperties(server, { 'resource-pack': '', 'resource-pack-sha1': '', 'require-resource-pack': 'false', 'resource-pack-prompt': '' });
  }
  await fsp.rm(fileFor(server.id), { force: true });
  delete all(store)[server.id];
  store.save();
  manager.logActivity?.(server.id, { type: 'datapack', text: `Resource pack ${cfg.name} removed`, by: actor });
  store.addEvent('mod.removed', `Resource pack ${cfg.name} removed from ${server.name}`, { serverId: server.id });
  return { ok: true };
}

/** For the public address: the file behind a slug, or null. Nothing else is ever reachable from it. */
function lookup(store, manager, slug) {
  const hit = Object.entries(all(store)).find(([, c]) => c.slug && c.slug === String(slug));
  if (!hit || !manager.servers.some((s) => s.id === hit[0])) return null;
  const file = fileFor(hit[0]);
  return fs.existsSync(file) ? { file, size: hit[1].size, sha1: hit[1].sha1 } : null;
}

function forget(store, serverId) {
  delete all(store)[serverId];
  fs.rmSync(fileFor(serverId), { force: true });
}

module.exports = { view, upload, update, remove, lookup, forget, reapply };
