'use strict';

/**
 * More places to copy backups to, next to S3: Google Drive, Dropbox and SFTP.
 * Each class has the same small surface as the S3 client in cloud.js:
 *   putFile(key, file), list(prefix) -> [{ key, size, modified }], download(key, target),
 *   remove(key), selfTest(prefix) -> short text.
 * Keys look like "gamepanel/<server id>/<backup name>.tar.gz" everywhere.
 *
 * Google Drive and Dropbox use OAuth with an app the administrator registers
 * themselves (nothing is shipped with the panel). SFTP uses the system's
 * OpenSSH `sftp` client, so the panel stays free of dependencies.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

const CHUNK = 32 * 1024 * 1024; // a multiple of 256 KiB, as Drive requires

const OAUTH = {
  gdrive: {
    label: 'Google Drive',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    // drive.file: the panel only ever sees files and folders it created itself.
    extra: { scope: 'https://www.googleapis.com/auth/drive.file', access_type: 'offline', prompt: 'consent' },
    console: 'https://console.cloud.google.com/apis/credentials',
  },
  dropbox: {
    label: 'Dropbox',
    authorize: 'https://www.dropbox.com/oauth2/authorize',
    token: 'https://api.dropboxapi.com/oauth2/token',
    extra: { token_access_type: 'offline' },
    console: 'https://www.dropbox.com/developers/apps',
  },
};

async function readError(res) {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    const msg = j.error_summary || j.error?.message || j.error_description || (typeof j.error === 'string' ? j.error : '');
    if (msg) return `${msg} (HTTP ${res.status})`;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`;
}

/** Shared by the OAuth-based targets: a cached access token, refreshed from the saved refresh token. */
class OAuthClient {
  constructor(kind, cfg) {
    this.kind = kind;
    this.cfg = cfg;
    this.accessToken = '';
    this.expires = 0;
  }

  async token() {
    if (this.accessToken && Date.now() < this.expires - 60_000) return this.accessToken;
    const c = this.cfg;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret });
    const res = await fetch(OAUTH[this.kind].token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${OAUTH[this.kind].label} refused the saved sign-in (${await readError(res)}). Connect it again in Settings.`);
    const j = await res.json();
    this.accessToken = j.access_token;
    this.expires = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return this.accessToken;
  }

  async fetch(url, init = {}, { timeout = 10 * 60_000 } = {}) {
    const headers = { ...(init.headers || {}), Authorization: `Bearer ${await this.token()}` };
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(await readError(res));
    return res;
  }
}

/** Swap an authorisation code for tokens. Returns { refreshToken }. */
async function exchangeCode(kind, cfg, code, redirectUri) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret });
  const res = await fetch(OAUTH[kind].token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${OAUTH[kind].label} said: ${await readError(res)}`);
  const j = await res.json();
  if (!j.refresh_token) throw new Error(`${OAUTH[kind].label} did not hand out a long-lived sign-in. Remove the panel under your account's connected apps and try again.`);
  return { refreshToken: j.refresh_token, accessToken: j.access_token };
}

/* ------------------------------------------------------------ Google Drive */

const qs = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

class GoogleDrive extends OAuthClient {
  constructor(cfg) {
    super('gdrive', cfg);
    this.folders = new Map(); // "a/b" -> folder id
  }

  api(pathAndQuery, init, opts) {
    return this.fetch(`https://www.googleapis.com/drive/v3/${pathAndQuery}`, init, opts);
  }

  async find(parent, name, folder) {
    const q = `name='${qs(name)}' and '${parent}' in parents and trashed=false${folder ? " and mimeType='application/vnd.google-apps.folder'" : ''}`;
    const res = await this.api(`files?${new URLSearchParams({ q, fields: 'files(id,size,modifiedTime)', pageSize: '10', spaces: 'drive' })}`);
    return (await res.json()).files || [];
  }

  /** Folder id for "a/b/c", optionally creating what is missing. Null when it does not exist. */
  async folder(dir, create) {
    let parent = 'root';
    let walked = '';
    for (const part of dir.split('/').filter(Boolean)) {
      walked += part + '/';
      let id = this.folders.get(walked);
      if (!id) {
        id = (await this.find(parent, part, true))[0]?.id;
        if (!id && create) {
          const res = await this.api('files?fields=id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: part, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
          });
          id = (await res.json()).id;
        }
        if (!id) return null;
        this.folders.set(walked, id);
      }
      parent = id;
    }
    return parent;
  }

  async putFile(key, file) {
    const dir = path.posix.dirname(key);
    const name = path.posix.basename(key);
    const parent = await this.folder(dir === '.' ? '' : dir, true);
    // Uploading again replaces the earlier copy.
    for (const old of await this.find(parent, name, false)) await this.api(`files/${old.id}`, { method: 'DELETE' }).catch(() => {});
    const size = fs.statSync(file).size;
    const init = await this.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/gzip', 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify({ name, parents: [parent] }),
    });
    const session = init.headers.get('location');
    if (!session) throw new Error('Google Drive did not start an upload');
    const fd = fs.openSync(file, 'r');
    try {
      if (size === 0) {
        await this.fetch(session, { method: 'PUT', headers: { 'Content-Length': '0' }, body: Buffer.alloc(0) });
        return;
      }
      for (let offset = 0; offset < size; offset += CHUNK) {
        const chunk = Buffer.alloc(Math.min(CHUNK, size - offset));
        fs.readSync(fd, chunk, 0, chunk.length, offset);
        const last = offset + chunk.length >= size;
        const res = await fetch(session, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${offset}-${offset + chunk.length - 1}/${size}`, Authorization: `Bearer ${await this.token()}` },
          body: chunk,
          signal: AbortSignal.timeout(10 * 60_000),
        });
        // 308 means "send the next piece"; the last piece answers 200/201.
        if (!(last ? res.ok : res.status === 308)) throw new Error(await readError(res));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  async list(prefix) {
    const dir = prefix.replace(/\/+$/, '');
    const parent = await this.folder(dir, false);
    if (!parent) return [];
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q: `'${parent}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`, fields: 'nextPageToken,files(name,size,modifiedTime)', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const j = await (await this.api(`files?${params}`)).json();
      for (const f of j.files || []) out.push({ key: prefix + f.name, size: Number(f.size) || 0, modified: Date.parse(f.modifiedTime) });
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  async idOf(key) {
    const dir = path.posix.dirname(key);
    const parent = await this.folder(dir === '.' ? '' : dir, false);
    const found = parent ? (await this.find(parent, path.posix.basename(key), false))[0] : null;
    if (!found) throw new Error('Not found in Google Drive');
    return found.id;
  }

  async download(key, target) {
    const res = await this.api(`files/${await this.idOf(key)}?alt=media`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));
  }

  async remove(key) {
    await this.api(`files/${await this.idOf(key)}`, { method: 'DELETE' });
  }

  async selfTest(prefix) {
    const about = await (await this.api('about?fields=user(emailAddress)')).json();
    await this.folder(prefix.replace(/\/+$/, ''), true);
    await this.list(prefix);
    return `Signed in as ${about.user?.emailAddress || 'your Google account'}`;
  }
}

/* ----------------------------------------------------------------- Dropbox */

/** Header values must be ASCII, so anything else is written as a \u escape. */
const argHeader = (obj) => JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const dbxPath = (key) => '/' + key.replace(/^\/+/, '');

class Dropbox extends OAuthClient {
  constructor(cfg) {
    super('dropbox', cfg);
  }

  rpc(endpoint, args) {
    return this.fetch(`https://api.dropboxapi.com/2/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  }

  content(endpoint, arg, body, extra = {}) {
    return this.fetch(`https://content.dropboxapi.com/2/${endpoint}`, {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': argHeader(arg), 'Content-Type': 'application/octet-stream', ...extra },
      body,
    });
  }

  async putFile(key, file) {
    const size = fs.statSync(file).size;
    const commit = { path: dbxPath(key), mode: 'overwrite', mute: true };
    if (size <= CHUNK) {
      await this.content('files/upload', commit, fs.readFileSync(file));
      return;
    }
    const fd = fs.openSync(file, 'r');
    try {
      const read = (offset) => {
        const chunk = Buffer.alloc(Math.min(CHUNK, size - offset));
        fs.readSync(fd, chunk, 0, chunk.length, offset);
        return chunk;
      };
      const started = await (await this.content('files/upload_session/start', { close: false }, read(0))).json();
      let offset = Math.min(CHUNK, size);
      while (size - offset > CHUNK) {
        await this.content('files/upload_session/append_v2', { cursor: { session_id: started.session_id, offset }, close: false }, read(offset));
        offset += CHUNK;
      }
      await this.content('files/upload_session/finish', { cursor: { session_id: started.session_id, offset }, commit }, read(offset));
    } finally {
      fs.closeSync(fd);
    }
  }

  async list(prefix) {
    const out = [];
    let res;
    try {
      res = await (await this.rpc('files/list_folder', { path: dbxPath(prefix).replace(/\/+$/, ''), limit: 2000 })).json();
    } catch (err) {
      if (/not_found/.test(err.message)) return [];
      throw err;
    }
    for (;;) {
      for (const e of res.entries) if (e['.tag'] === 'file') out.push({ key: prefix + e.name, size: e.size, modified: Date.parse(e.server_modified) });
      if (!res.has_more) return out;
      res = await (await this.rpc('files/list_folder/continue', { cursor: res.cursor })).json();
    }
  }

  async download(key, target) {
    const res = await this.fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': argHeader({ path: dbxPath(key) }) } });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));
  }

  async remove(key) {
    await this.rpc('files/delete_v2', { path: dbxPath(key) });
  }

  async selfTest(prefix) {
    const me = await (await this.fetch('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST' })).json();
    await this.list(prefix);
    return `Signed in as ${me.email || 'your Dropbox account'}`;
  }
}

/* -------------------------------------------------------------------- SFTP */

const quote = (p) => {
  if (/[\r\n\0]/.test(p)) throw new Error('Bad character in a path');
  return `"${p.replace(/\\/g, '/').replace(/(["\\])/g, '\\$1')}"`;
};

/**
 * Talks to the server by feeding commands to the OpenSSH `sftp` client. Password
 * logins use SSH_ASKPASS (OpenSSH 8.4+), keys are written to a private temporary
 * file for the length of the command. The server's key is remembered the first
 * time (in the panel's own known_hosts), and a changed key is refused.
 */
class Sftp {
  constructor(cfg, { dataDir }) {
    this.cfg = cfg;
    this.dir = path.join(dataDir, 'run');
  }

  /** Runs sftp with a list of commands. Resolves with its output; rejects on a failure it can recognise. */
  async run(commands) {
    const c = this.cfg;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = fs.mkdtempSync(path.join(this.dir, 'sftp-'));
    const env = { ...process.env, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'gamepanel:0' };
    const args = [
      '-P', String(c.port || 22),
      '-o', 'BatchMode=no',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${path.join(this.dir, 'sftp_known_hosts').replace(/\\/g, '/')}`,
      '-o', 'ConnectTimeout=20',
      '-o', 'ServerAliveInterval=30',
      '-o', `NumberOfPasswordPrompts=1`,
    ];
    try {
      if (c.privateKey) {
        const keyFile = path.join(tmp, 'key');
        fs.writeFileSync(keyFile, c.privateKey.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'), { mode: 0o600 });
        args.push('-i', keyFile.replace(/\\/g, '/'), '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey');
      } else {
        args.push('-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no');
      }
      const secret = c.privateKey ? c.passphrase || '' : c.password || '';
      // Both the password and a key passphrase are asked for through the helper, which reads them from the environment.
      env.GP_SFTP_SECRET = secret;
      const win = process.platform === 'win32';
      const helper = path.join(tmp, win ? 'askpass.cmd' : 'askpass.sh');
      fs.writeFileSync(helper, win ? '@echo off\r\necho %GP_SFTP_SECRET%\r\n' : '#!/bin/sh\nprintf \'%s\\n\' "$GP_SFTP_SECRET"\n', { mode: 0o700 });
      env.SSH_ASKPASS = helper;
      args.push(`${c.username}@${c.host}`);
      return await new Promise((resolve, reject) => {
        const child = spawn('sftp', args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'The OpenSSH client (sftp) is not installed on this machine' : e.message)));
        const timer = setTimeout(() => child.kill(), 30 * 60_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          const text = `${err}\n${out}`;
          const bad = text.match(/(Permission denied[^\n]*|Host key verification failed[^\n]*|REMOTE HOST IDENTIFICATION HAS CHANGED[^\n]*|Connection (?:refused|timed out|closed|reset)[^\n]*|Could not resolve hostname[^\n]*|No route to host[^\n]*|Couldn't [^\n]*|Can't ls[^\n]*|[^\n]*not found[^\n]*|No such file[^\n]*|Failure[^\n]*|remote open[^\n]*)/i);
          if (bad && !commands.ignoreErrors) return reject(new Error(bad[1].trim()));
          if (code !== 0 && !out.trim()) return reject(new Error(err.trim().split('\n').pop() || `sftp exited with ${code}`));
          resolve(out);
        });
        child.stdin.end(commands.lines.join('\n') + '\nbye\n');
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  script(lines, ignoreErrors = false) {
    return Object.assign({ lines }, { ignoreErrors });
  }

  async mkdirs(dir) {
    // sftp has no "mkdir -p"; existing folders just answer with a failure, which is fine here.
    const lines = [];
    let walked = dir.startsWith('/') ? '/' : '';
    for (const part of dir.split('/').filter(Boolean)) {
      walked += part + '/';
      lines.push(`-mkdir ${quote(walked.replace(/\/$/, ''))}`);
    }
    if (lines.length) await this.run(this.script(lines, true)).catch(() => {}); // a real problem shows up on the upload
  }

  async putFile(key, file) {
    await this.mkdirs(path.posix.dirname(key));
    const partial = key + '.part';
    await this.run(this.script([`rm ${quote(key)}`], true)).catch(() => {}); // replaces an earlier copy
    await this.run(this.script([`put ${quote(file)} ${quote(partial)}`, `rename ${quote(partial)} ${quote(key)}`]));
    const size = fs.statSync(file).size;
    const stored = (await this.list(path.posix.dirname(key) + '/')).find((o) => o.key === key);
    if (!stored || stored.size !== size) throw new Error('The server did not keep the whole file');
  }

  async list(prefix) {
    const dir = prefix.replace(/\/+$/, '') || '.';
    let out;
    try {
      out = await this.run(this.script([`ls -l ${quote(dir)}`]));
    } catch (err) {
      if (/No such file|not found/i.test(err.message)) return [];
      throw err;
    }
    return parseListing(out, prefix);
  }

  async download(key, target) {
    await this.run(this.script([`get ${quote(key)} ${quote(target)}`]));
  }

  async remove(key) {
    await this.run(this.script([`rm ${quote(key)}`]));
  }

  async selfTest(prefix) {
    const probe = `${prefix}.gamepanel-test-${Date.now()}`;
    const local = path.join(this.dir, `sftp-test-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(local, 'GamePanel can write here.\n');
    try {
      await this.mkdirs(prefix.replace(/\/+$/, ''));
      await this.run(this.script([`put ${quote(local)} ${quote(probe)}`, `ls -l ${quote(prefix.replace(/\/+$/, '') || '.')}`, `rm ${quote(probe)}`]));
    } finally {
      fs.rmSync(local, { force: true });
    }
    return `Connected to ${this.cfg.host}`;
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Reads `ls -l` lines from an OpenSSH server (the format sftp prints). */
function parseListing(text, prefix, now = new Date()) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^-[rwxsStT-]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s+(.+)$/);
    if (!m) continue;
    const [, size, mon, day, when, name] = m;
    const month = MONTHS.indexOf(mon.toLowerCase());
    let year = now.getUTCFullYear();
    let hh = 0;
    let mm = 0;
    if (when.includes(':')) {
      [hh, mm] = when.split(':').map(Number);
      // No year printed means within the last six months.
      if (Date.UTC(year, month, Number(day), hh, mm) > now.getTime() + 86_400_000) year--;
    } else year = Number(when);
    out.push({ key: prefix + name, size: Number(size), modified: Date.UTC(year, month, Number(day), hh, mm) });
  }
  return out;
}

module.exports = { OAUTH, GoogleDrive, Dropbox, Sftp, exchangeCode, parseListing };
