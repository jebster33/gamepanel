'use strict';

/**
 * Steam beta branches, per server. Steam games publish test builds on named
 * branches ("public" is the normal one; others are "beta", "experimental",
 * "unstable"...). A server can follow one: installs and updates then run
 * SteamCMD with `-beta <branch>` (and `-betapassword` for locked branches).
 *
 * The branch name is kept on the server (server.steamBranch, validated to
 * plain characters so it is safe in a command); the password is sealed with
 * server/core/secrets.js and never sent back to the browser.
 */

const { fail, interpolate } = require('../core/util');
const secrets = require('../core/secrets');

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const INFO_URL = 'https://api.steamcmd.net/v1/info/';
const CACHE_MS = 10 * 60_000;
const cache = new Map(); // appid -> { at, branches }

/** The Steam app (the game itself) behind a server, from its template's steamcmd steps. */
function steamApp(manager, server) {
  const template = manager.template(server);
  if (!template) return null;
  const steps = Array.isArray(template.update) ? template.update : template.install || [];
  const step = steps.find((s) => s.type === 'steamcmd' && s.appid) || (template.install || []).find((s) => s.type === 'steamcmd' && s.appid);
  if (!step) return null;
  const appid = String(interpolate(String(step.appid), manager.vars(server))).trim();
  if (!/^\d{1,10}$/.test(appid)) return null;
  return { appid, templateBranch: String(interpolate(String(step.branch || ''), manager.vars(server))).trim() };
}

/** Branches Steam lists for an app (cached). [{ name, buildid, updated, locked, description }] */
async function listBranches(appid, fetchJson) {
  if (!/^\d{1,10}$/.test(String(appid))) fail(400, 'Invalid Steam app id');
  const cached = cache.get(appid);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.branches;
  let data;
  try {
    data = fetchJson
      ? await fetchJson(`${INFO_URL}${appid}`)
      : await fetch(`${INFO_URL}${appid}`, { signal: AbortSignal.timeout(15_000) }).then((r) => {
          if (!r.ok) throw new Error(`answered ${r.status}`);
          return r.json();
        });
  } catch (err) {
    fail(502, `Could not ask Steam which branches exist: ${err.message}`);
  }
  const raw = data?.data?.[appid]?.depots?.branches || {};
  const branches = Object.entries(raw)
    .filter(([name]) => BRANCH.test(name))
    .map(([name, b]) => ({
      name,
      buildid: b?.buildid ? String(b.buildid) : null,
      updated: b?.timeupdated ? Number(b.timeupdated) * 1000 : null,
      locked: String(b?.pwdrequired) === '1',
      description: typeof b?.description === 'string' ? b.description.slice(0, 120) : '',
    }))
    .sort((a, b) => (a.name === 'public' ? -1 : b.name === 'public' ? 1 : a.name.localeCompare(b.name)));
  cache.set(appid, { at: Date.now(), branches });
  return branches;
}

function validateBranch(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'public') return '';
  if (!BRANCH.test(text)) fail(400, 'A branch name can only use letters, numbers, dots, dashes and underscores');
  return text;
}

/** What the settings card shows. Never the password. */
function view(manager, server) {
  const app = steamApp(manager, server);
  if (!app) return { supported: false };
  return {
    supported: true,
    appid: app.appid,
    branch: server.steamBranch || app.templateBranch || 'public',
    custom: Boolean(server.steamBranch),
    hasPassword: Boolean(server.steamBetaPassword),
    templateBranch: app.templateBranch || 'public',
  };
}

/** Save the choice. A blank password keeps the saved one; clearPassword removes it. */
function set(manager, server, { branch, password, clearPassword } = {}) {
  if (!steamApp(manager, server)) fail(400, 'This game is not installed through SteamCMD');
  server.steamBranch = validateBranch(branch) || undefined;
  if (!server.steamBranch) {
    delete server.steamBetaPassword; // the public branch takes no password
  } else if (clearPassword) {
    delete server.steamBetaPassword;
  } else if (password !== undefined && password !== null && password !== '') {
    const text = String(password);
    if (text.length > 128 || /[\u0000-\u001f]/.test(text)) fail(400, 'That password is not valid');
    server.steamBetaPassword = secrets.seal(text);
  }
  return view(manager, server);
}

/**
 * Put the server's branch onto the SteamCMD steps for its game. A password
 * travels as the variable GP_BETA_PASSWORD (the install script reads it from
 * the environment, so it is never written into a file or a command line).
 * Returns the steps to run; `vars` gains the password when there is one.
 */
function apply(manager, server, steps, vars) {
  if (!server.steamBranch) return steps;
  const app = steamApp(manager, server);
  if (!app) return steps;
  if (server.steamBetaPassword) vars.GP_BETA_PASSWORD = secrets.open(server.steamBetaPassword);
  return steps.map((step) =>
    step.type === 'steamcmd' && String(interpolate(String(step.appid), vars)) === app.appid
      ? { ...step, branch: server.steamBranch, ...(server.steamBetaPassword ? { betaPassword: '{{GP_BETA_PASSWORD}}' } : {}) }
      : step
  );
}

module.exports = { steamApp, listBranches, validateBranch, view, set, apply, BRANCH, _reset: () => cache.clear() };
