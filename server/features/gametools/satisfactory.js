'use strict';

/**
 * Satisfactory save manager. Talks to the dedicated server's HTTPS API (v1, the
 * game port, 7777 by default) to list sessions and saves, download, upload,
 * load, delete and start a new game. The server's certificate is self-signed,
 * so the panel pins it: "Trust certificate" reads the certificate once from
 * 127.0.0.1 and from then on every request must present exactly that
 * certificate (SHA-256 fingerprint compared before anything is sent).
 *
 * The API token is kept sealed (core/secrets). Signing in with the admin
 * password only keeps the token the server returns, never the password.
 *
 * Without a token (or with the server stopped) the .sav files in the save
 * folder can still be listed, downloaded, uploaded and deleted.
 */

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { fail, HttpError } = require('../../core/util');
const secrets = require('../../core/secrets');
const { containedPath } = require('../files');
const common = require('./common');

const HOST = '127.0.0.1';
const SAVE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}$/;
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,63}$/;
const START_LOCATIONS = ['Grass Fields', 'Rocky Desert', 'Northern Forest', 'Dune Desert'];
const MAX_JSON = 8 * 1024 * 1024;
const MAX_UPLOAD = 1024 * 1024 * 1024;

const SAVE_DIRS = [
  'FactoryGame/Saved/SaveGames/server',
  '.config/Epic/FactoryGame/Saved/SaveGames/server',
  'config/Epic/FactoryGame/Saved/SaveGames/server',
  'saves/server',
];

const st = (server) => (server.satisfactory && typeof server.satisfactory === 'object' ? server.satisfactory : (server.satisfactory = {}));

const portOf = (server) => Number(server.ports?.game || 7777);

const pem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
const fingerprint = (der) => crypto.createHash('sha256').update(der).digest('hex');

function connect(server, { pinned }) {
  return new Promise((resolve, reject) => {
    // The server's certificate is self-signed, so the normal chain check cannot pass. Safety comes from pinning:
    // the connection is to this machine only, and the SHA-256 fingerprint must equal the trusted one before use.
    // codeql[js/disabling-certificate-validation]
    const socket = tls.connect({ host: HOST, port: portOf(server), servername: 'localhost', rejectUnauthorized: false, timeout: 10000 });
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('timed out')));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(true);
      if (!cert?.raw) return socket.destroy(new Error('no certificate'));
      if (pinned && fingerprint(cert.raw) !== pinned) {
        socket.destroy();
        return reject(new HttpError(400, 'The server presented a different certificate than the one you trusted. If you reinstalled the server, trust the certificate again.'));
      }
      socket.removeAllListeners('error');
      socket.on('error', () => {});
      resolve({ socket, cert });
    });
  });
}

/** Read the certificate the server presents and trust it from now on. */
async function trustCertificate(store, server) {
  let conn;
  try {
    conn = await connect(server, { pinned: null });
  } catch (err) {
    fail(502, `Could not reach the server's API on port ${portOf(server)}: ${err.message}. Is it running?`);
  }
  const s = st(server);
  s.certFingerprint = fingerprint(conn.cert.raw);
  s.cert = pem(conn.cert.raw);
  conn.socket.destroy();
  store.save();
  return status(server);
}

/** One request; resolves with the IncomingMessage. */
async function open(server, { path: urlPath = '/api/v1', headers = {}, body = null, token = true, length = null }) {
  const s = st(server);
  if (!s.certFingerprint) fail(400, 'Trust the server certificate first');
  let conn;
  try {
    conn = await connect(server, { pinned: s.certFingerprint });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    fail(502, `Could not reach the server's API: ${err.message}. Is it running?`);
  }
  const auth = token && s.token ? { Authorization: `Bearer ${secrets.open(s.token)}` } : {};
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method: 'POST', path: urlPath, host: HOST, createConnection: () => conn.socket, agent: false, headers: { ...auth, ...headers, ...(length !== null ? { 'Content-Length': length } : {}) } },
      resolve
    );
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('timed out')));
    req.on('error', (err) => reject(new HttpError(502, `API request failed: ${err.message}`)));
    if (body && typeof body.pipe === 'function') body.pipe(req);
    else req.end(body || undefined);
  });
}

async function readJson(res) {
  const chunks = [];
  let size = 0;
  for await (const c of res) {
    size += c.length;
    if (size > MAX_JSON) fail(502, 'The API answered with too much data');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

/** Call an API function; returns its `data`. */
async function call(server, fn, data = {}, { token = true } = {}) {
  const res = await open(server, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ function: fn, data }), token });
  const json = await readJson(res);
  if (res.statusCode === 401 || res.statusCode === 403) fail(401, 'The server rejected the API token. Sign in again.');
  if (res.statusCode >= 300) fail(502, `The server said: ${String(json.errorMessage || json.errorCode || res.statusCode).slice(0, 200)}`);
  return json.data || {};
}

/* ------------------------------------------------------------- sign-in -- */

async function login(store, server, input = {}) {
  const s = st(server);
  if (typeof input.token === 'string' && input.token.trim()) {
    const token = input.token.trim();
    if (token.length > 4096 || /[\s\r\n]/.test(token)) fail(400, 'That does not look like an API token');
    s.token = secrets.seal(token);
  } else if (typeof input.password === 'string' && input.password) {
    const data = await call(server, 'PasswordLogin', { password: input.password, minimumPrivilegeLevel: 'Administrator' }, { token: false });
    if (!data.authenticationToken) fail(401, 'The server did not accept that password');
    s.token = secrets.seal(data.authenticationToken);
  } else if (input.passwordless) {
    const data = await call(server, 'PasswordlessLogin', { minimumPrivilegeLevel: 'Administrator' }, { token: false });
    if (!data.authenticationToken) fail(401, 'The server has an admin password, use it to sign in');
    s.token = secrets.seal(data.authenticationToken);
  } else fail(400, 'Give an admin password or an API token');
  store.save();
  return status(server);
}

function logout(store, server) {
  delete st(server).token;
  store.save();
  return status(server);
}

function status(server) {
  const s = st(server);
  return { port: portOf(server), certTrusted: Boolean(s.certFingerprint), certFingerprint: s.certFingerprint || null, signedIn: Boolean(s.token), saveFolder: saveDir(server)?.rel || null };
}

/* -------------------------------------------------------------- the API -- */

const checkSave = (name) => {
  if (!SAVE_NAME.test(String(name || ''))) fail(400, 'That is not a valid save name');
  return String(name);
};

async function sessions(server) {
  const data = await call(server, 'EnumerateSessions');
  return {
    current: data.currentSessionIndex ?? null,
    sessions: (data.sessions || []).map((s) => ({
      name: String(s.sessionName || ''),
      saves: (s.saveHeaders || []).map((h) => ({
        name: String(h.saveName || ''),
        date: h.saveDateTime || null,
        seconds: h.playDurationSeconds ?? null,
        map: h.mapName || null,
        build: h.buildVersion ?? null,
      })),
    })),
  };
}

const loadSave = (server, name, advanced) => call(server, 'LoadGame', { SaveName: checkSave(name), EnableAdvancedGameSettings: Boolean(advanced) });
const saveNow = (server, name) => call(server, 'SaveGame', { SaveName: checkSave(name) });
const deleteSave = (server, name) => call(server, 'DeleteSaveFile', { SaveName: checkSave(name) });

function deleteSession(server, name) {
  if (!SESSION_NAME.test(String(name || ''))) fail(400, 'That is not a valid session name');
  return call(server, 'DeleteSaveSession', { SessionName: String(name) });
}

function newGame(server, input = {}) {
  const name = String(input.sessionName || '');
  if (!SESSION_NAME.test(name)) fail(400, 'Give the new game a name (letters, digits, spaces, dots, dashes)');
  const location = START_LOCATIONS.includes(input.startingLocation) ? input.startingLocation : START_LOCATIONS[0];
  return call(server, 'CreateNewGame', { NewGameData: { SessionName: name, StartingLocation: location, SkipOnboarding: input.skipOnboarding !== false } });
}

/** Stream a save from the API into `res`. */
async function download(server, name, res) {
  const upstream = await open(server, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ function: 'DownloadSaveGame', data: { SaveName: checkSave(name) } }) });
  if (upstream.statusCode !== 200) {
    const json = await readJson(upstream);
    fail(upstream.statusCode === 401 ? 401 : 502, `The server said: ${String(json.errorMessage || upstream.statusCode).slice(0, 200)}`);
  }
  const filename = `${name}.sav`.replace(/[^\x20-\x7e]|["\\]/g, '_');
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"`, ...(upstream.headers['content-length'] ? { 'Content-Length': upstream.headers['content-length'] } : {}) });
  await pipeline(upstream, res);
}

/** Upload a .sav from `stream` to the API (multipart/form-data). */
async function upload(server, name, stream, length, { load = false } = {}) {
  checkSave(name);
  const boundary = `gp${crypto.randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ function: 'UploadSaveGame', data: { saveName: name, loadSaveGame: Boolean(load), enableAdvancedGameSettings: false } })}\r\n--${boundary}\r\nContent-Disposition: form-data; name="saveGameFile"; filename="${name}.sav"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  let size = 0;
  const limited = Readable.from(
    (async function* () {
      yield head;
      for await (const c of stream) {
        size += c.length;
        if (size > MAX_UPLOAD) throw new HttpError(413, 'That file is larger than 1 GB');
        yield c;
      }
      yield tail;
    })()
  );
  const res = await open(server, { path: '/api/v1', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: limited, length: length ? Number(length) + head.length + tail.length : null });
  const json = await readJson(res);
  if (res.statusCode >= 300) fail(502, `The server said: ${String(json.errorMessage || res.statusCode).slice(0, 200)}`);
  return { ok: true, size };
}

/* ---------------------------------------------------------- save files -- */

function saveDir(server) {
  for (const rel of SAVE_DIRS) {
    try {
      const dir = containedPath(server.dir, rel);
      if (fs.statSync(dir).isDirectory()) return { rel, dir };
    } catch {
      /* try the next */
    }
  }
  return null;
}

function listFiles(server) {
  const found = saveDir(server);
  if (!found) return { folder: null, files: [] };
  const files = fs
    .readdirSync(found.dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.sav$/i.test(e.name))
    .map((e) => {
      const stat = fs.statSync(path.join(found.dir, e.name));
      return { name: e.name.slice(0, -4), size: stat.size, modified: stat.mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified);
  return { folder: found.rel, files };
}

function fileOf(server, name) {
  checkSave(name);
  const found = saveDir(server);
  if (!found) fail(404, 'The save folder was not found. Start the server once so it creates it.');
  return path.join(found.dir, `${name}.sav`);
}

function openFile(server, name) {
  const file = fileOf(server, name);
  const stat = fs.existsSync(file) ? fs.statSync(file) : null;
  if (!stat?.isFile()) fail(404, 'Save not found');
  return { file, size: stat.size, name: `${name}.sav` };
}

function deleteFile(manager, server, name) {
  common.requireStopped(manager, server, 'Deleting a save file');
  const file = fileOf(server, name);
  if (!fs.existsSync(file)) fail(404, 'Save not found');
  // Kept under the same folder's trash until someone empties it by hand.
  const trash = path.join(path.dirname(file), '.gamepanel-trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(file, path.join(trash, `${name}.${Date.now()}.sav`));
  return listFiles(server);
}

async function uploadFile(manager, server, name, stream) {
  common.requireStopped(manager, server, 'Uploading a save file');
  const found = saveDir(server);
  if (!found) fail(404, 'The save folder was not found. Start the server once so it creates it.');
  checkSave(name);
  const target = path.join(found.dir, `${name}.sav`);
  const tmp = `${target}.${crypto.randomBytes(5).toString('hex')}.upload`;
  let size = 0;
  try {
    await pipeline(
      stream,
      async function* (source) {
        for await (const c of source) {
          size += c.length;
          if (size > MAX_UPLOAD) throw new HttpError(413, 'That file is larger than 1 GB');
          yield c;
        }
      },
      fs.createWriteStream(tmp, { flags: 'wx' })
    );
    if (fs.existsSync(target)) fs.renameSync(target, path.join(found.dir, `${name}.${Date.now()}.sav.bak`));
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { ok: true, size };
}

module.exports = { START_LOCATIONS, SAVE_NAME, status, trustCertificate, login, logout, sessions, loadSave, saveNow, deleteSave, deleteSession, newGame, download, upload, listFiles, openFile, deleteFile, uploadFile, saveDir, fingerprint, pem };
