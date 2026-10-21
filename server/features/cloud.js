'use strict';

/**
 * Optional off-site copies of backups in any S3-compatible bucket: Amazon S3,
 * Backblaze B2, Cloudflare R2, Wasabi, MinIO… Requests are signed with AWS
 * Signature V4 using node:crypto, so there is still no dependency. Google
 * Drive, Dropbox and SFTP work the same way (see cloud-targets.js); the
 * `provider` setting picks one.
 *
 * Every backup the panel makes (by hand or on a schedule) is uploaded in the
 * background once this is turned on. Objects live at
 *   <prefix><server id>/<backup name>.tar.gz
 * and can be pulled back down onto the panel from the server's Backups tab.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { logger, fail } = require('../core/util');
const backups = require('./backups');
const targets = require('./cloud-targets');
const secrets = require('../core/secrets');

const PART_SIZE = 32 * 1024 * 1024; // above this, upload in parts (S3 caps one PUT at 5 GB)

const DEFAULTS = {
  enabled: false,
  provider: 's3',
  endpoint: '',
  region: '',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  prefix: 'gamepanel/',
  keep: 0,
  pathStyle: true,
  gdrive: { clientId: '', clientSecret: '', refreshToken: '' },
  dropbox: { clientId: '', clientSecret: '', refreshToken: '' },
  sftp: { host: '', port: 22, username: '', password: '', privateKey: '', passphrase: '' },
};
const PROVIDERS = ['s3', 'gdrive', 'dropbox', 'sftp'];
/** The secrets inside each provider's settings, sealed on disk. */
const SECRET_FIELDS = { gdrive: ['clientSecret', 'refreshToken'], dropbox: ['clientSecret', 'refreshToken'], sftp: ['password', 'privateKey', 'passphrase'] };

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Most providers put the region in the endpoint's host name. */
function guessRegion(endpoint) {
  const host = (() => {
    try {
      return new URL(endpoint).host;
    } catch {
      return '';
    }
  })();
  const m = host.match(/s3[.-]([a-z0-9-]+)\.(amazonaws\.com|backblazeb2\.com|wasabisys\.com)/);
  if (m && m[1] !== 'external-1') return m[1];
  if (host.endsWith('r2.cloudflarestorage.com')) return 'auto';
  return 'us-east-1';
}

class S3 {
  constructor(cfg) {
    this.cfg = cfg;
    this.endpoint = new URL(cfg.endpoint);
    this.region = cfg.region || guessRegion(cfg.endpoint);
  }

  url(key = '', query = {}) {
    const encodedKey = key.split('/').map(rfc3986).join('/');
    const base = new URL(this.endpoint.href);
    if (this.cfg.pathStyle) base.pathname = `/${this.cfg.bucket}${key ? '/' + encodedKey : '/'}`;
    else {
      base.host = `${this.cfg.bucket}.${this.endpoint.host}`;
      base.pathname = `/${encodedKey}`;
    }
    const qs = Object.entries(query)
      .map(([k, v]) => [rfc3986(k), rfc3986(String(v))])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return { href: `${base.origin}${base.pathname}${qs ? '?' + qs : ''}`, host: base.host, pathname: base.pathname, qs };
  }

  async request(method, key, { query = {}, body = null, headers = {}, raw = false } = {}) {
    const u = this.url(key, query);
    const payload = body ?? Buffer.alloc(0);
    const payloadHash = sha256(payload);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const all = { ...headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
    const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const canonical = [method, u.pathname, u.qs, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const key4 = hmac(hmac(hmac(hmac('AWS4' + this.cfg.secretAccessKey, date), this.region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', key4).update(toSign).digest('hex');
    delete lower.host; // fetch sets it
    const res = await fetch(u.href, {
      method,
      headers: { ...lower, authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` },
      body: body ?? undefined,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
      const message = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
      throw new Error(`${code || 'HTTP ' + res.status}${message ? ': ' + message : ''}`);
    }
    return raw ? res : res.text();
  }

  async putFile(key, file) {
    const size = fs.statSync(file).size;
    if (size <= PART_SIZE) {
      await this.request('PUT', key, { body: fs.readFileSync(file), headers: { 'content-type': 'application/gzip' } });
      return;
    }
    const created = await this.request('POST', key, { query: { uploads: '' }, headers: { 'content-type': 'application/gzip' } });
    const uploadId = created.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
    if (!uploadId) throw new Error('The bucket did not start a multipart upload');
    const parts = [];
    const fd = fs.openSync(file, 'r');
    try {
      for (let offset = 0, n = 1; offset < size; offset += PART_SIZE, n++) {
        const chunk = Buffer.alloc(Math.min(PART_SIZE, size - offset));
        fs.readSync(fd, chunk, 0, chunk.length, offset);
        const res = await this.request('PUT', key, { query: { partNumber: n, uploadId }, body: chunk, raw: true });
        parts.push(`<Part><PartNumber>${n}</PartNumber><ETag>${res.headers.get('etag')}</ETag></Part>`);
      }
      await this.request('POST', key, {
        query: { uploadId },
        body: Buffer.from(`<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`),
        headers: { 'content-type': 'application/xml' },
      });
    } catch (err) {
      await this.request('DELETE', key, { query: { uploadId } }).catch(() => {});
      throw err;
    } finally {
      fs.closeSync(fd);
    }
  }

  async list(prefix) {
    const out = [];
    let token = null;
    do {
      const query = { 'list-type': 2, prefix };
      if (token) query['continuation-token'] = token;
      const xml = await this.request('GET', '', { query });
      for (const [, block] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const tag = (name) => block.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
        out.push({ key: decodeXml(tag('Key')), size: Number(tag('Size')), modified: Date.parse(tag('LastModified')) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(xml.match(/<NextContinuationToken>([^<]+)</)?.[1] || '') : null;
    } while (token);
    return out;
  }

  async download(key, target) {
    const res = await this.request('GET', key, { raw: true });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));
  }

  remove(key) {
    return this.request('DELETE', key);
  }
}

function decodeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

class CloudBackups {
  constructor(store, manager) {
    this.store = store;
    this.manager = manager;
    this.status = new Map(); // "<server>/<name>" -> uploading | queued | failed message
    this.chain = Promise.resolve();
    store.on('event', (event) => {
      // Incremental backups are packed as a .tar.gz for the upload (unencrypted vaults only, see upload()).
      if (event.type === 'backup.created' && event.backup && this.enabled) this.queue(event.serverId, event.backup);
    });
  }

  get settings() {
    const saved = this.store.state.settings.cloudBackups || {};
    const out = { ...DEFAULTS, ...saved, secretAccessKey: secrets.open(saved.secretAccessKey || '') };
    for (const [p, fields] of Object.entries(SECRET_FIELDS)) {
      out[p] = { ...DEFAULTS[p], ...(saved[p] || {}) };
      for (const f of fields) out[p][f] = secrets.open(out[p][f] || '');
    }
    if (!PROVIDERS.includes(out.provider)) out.provider = 's3';
    return out;
  }

  /** True when the chosen provider has everything it needs to connect. */
  ready(s) {
    switch (s.provider) {
      case 'gdrive':
      case 'dropbox':
        return Boolean(s[s.provider].clientId && s[s.provider].clientSecret && s[s.provider].refreshToken);
      case 'sftp':
        return Boolean(s.sftp.host && s.sftp.username && (s.sftp.password || s.sftp.privateKey));
      default:
        return Boolean(s.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey);
    }
  }

  get enabled() {
    const s = this.settings;
    return Boolean(s.enabled && this.ready(s));
  }

  client(cfg = this.settings) {
    if (!this.ready(cfg)) {
      fail(400, { s3: 'Fill in the endpoint, bucket and both keys first', gdrive: 'Connect Google Drive first', dropbox: 'Connect Dropbox first', sftp: 'Fill in the host, user name and a password or key first' }[cfg.provider]);
    }
    if (cfg.provider === 'gdrive') return new targets.GoogleDrive(cfg.gdrive);
    if (cfg.provider === 'dropbox') return new targets.Dropbox(cfg.dropbox);
    if (cfg.provider === 'sftp') return new targets.Sftp(cfg.sftp, { dataDir: require('../core/config').dataDir });
    return new S3(cfg);
  }

  prefixFor(serverId, cfg = this.settings) {
    return `${cfg.prefix || ''}${serverId}/`;
  }

  /** What the settings page shows: everything but the secrets themselves. */
  publicSettings() {
    const s = this.settings;
    const out = { ...s, secretAccessKey: '', hasSecret: Boolean(s.secretAccessKey), regionGuess: s.endpoint ? guessRegion(s.endpoint) : '' };
    for (const [p, fields] of Object.entries(SECRET_FIELDS)) {
      out[p] = { ...s[p] };
      for (const f of fields) {
        out[p][f + 'Set'] = Boolean(s[p][f]);
        out[p][f] = '';
      }
    }
    out.gdrive.connected = Boolean(s.gdrive.refreshToken);
    out.dropbox.connected = Boolean(s.dropbox.refreshToken);
    return out;
  }

  /** Merge the typed values into `s`; secrets are only replaced when something is typed. */
  merge(s, body) {
    if (body.provider !== undefined) {
      if (!PROVIDERS.includes(body.provider)) fail(400, 'Unknown backup target');
      s.provider = body.provider;
    }
    if (body.endpoint !== undefined) {
      const endpoint = String(body.endpoint).trim().replace(/\/+$/, '');
      if (endpoint && !/^https?:\/\/[^/]+/.test(endpoint)) fail(400, 'The endpoint must be a URL like https://s3.us-west-004.backblazeb2.com');
      if (body.pathStyle === undefined && endpoint !== s.endpoint) s.pathStyle = !/amazonaws\.com/.test(endpoint);
      s.endpoint = endpoint;
    }
    for (const k of ['region', 'bucket', 'accessKeyId']) if (body[k] !== undefined) s[k] = String(body[k]).trim();
    if (body.secretAccessKey) s.secretAccessKey = String(body.secretAccessKey).trim();
    if (body.prefix !== undefined) {
      let prefix = String(body.prefix).trim().replace(/^\/+/, '');
      if (/(^|\/)\.\.(\/|$)|[\r\n\0]/.test(prefix)) fail(400, 'The folder cannot contain ".."');
      if (prefix && !prefix.endsWith('/')) prefix += '/';
      s.prefix = prefix;
    }
    if (body.keep !== undefined) s.keep = Math.max(0, Math.min(1000, Number(body.keep) || 0));
    if (body.pathStyle !== undefined) s.pathStyle = Boolean(body.pathStyle);
    for (const p of ['gdrive', 'dropbox']) {
      const b = body[p];
      if (!b || typeof b !== 'object') continue;
      if (b.clientId !== undefined) s[p].clientId = String(b.clientId).trim();
      if (b.clientSecret) s[p].clientSecret = String(b.clientSecret).trim();
      if (b.disconnect) s[p].refreshToken = '';
    }
    const f = body.sftp;
    if (f && typeof f === 'object') {
      if (f.host !== undefined) {
        const host = String(f.host).trim();
        if (host && !/^[A-Za-z0-9.:[\]_-]+$/.test(host)) fail(400, 'That does not look like a host name');
        s.sftp.host = host;
      }
      if (f.port !== undefined) s.sftp.port = Math.max(1, Math.min(65535, Number(f.port) || 22));
      if (f.username !== undefined) {
        const username = String(f.username).trim();
        if (username && !/^[A-Za-z0-9._@-]+$/.test(username)) fail(400, 'That user name has characters SFTP logins do not use');
        s.sftp.username = username;
      }
      for (const k of ['password', 'privateKey', 'passphrase']) if (f[k]) s.sftp[k] = String(f[k]);
      if (f.clearKey) {
        s.sftp.privateKey = '';
        s.sftp.passphrase = '';
      }
    }
    return s;
  }

  save(s) {
    const out = { ...s, secretAccessKey: secrets.seal(s.secretAccessKey) };
    for (const [p, fields] of Object.entries(SECRET_FIELDS)) {
      out[p] = { ...s[p] };
      for (const f of fields) out[p][f] = secrets.seal(s[p][f]);
    }
    this.store.state.settings.cloudBackups = out;
    this.store.save();
  }

  update(body) {
    const s = this.merge(this.settings, body);
    if (body.enabled !== undefined) s.enabled = Boolean(body.enabled);
    if (s.enabled && !this.ready(s)) {
      fail(400, { s3: 'Fill in the endpoint, bucket and both keys before turning cloud backups on', gdrive: 'Connect Google Drive before turning cloud backups on', dropbox: 'Connect Dropbox before turning cloud backups on', sftp: 'Fill in the host, user name and a password or key before turning cloud backups on' }[s.provider]);
    }
    this.save(s);
    return this.publicSettings();
  }

  /** Store the refresh token a finished OAuth sign-in produced. */
  connected(provider, refreshToken) {
    const s = this.settings;
    s[provider].refreshToken = refreshToken;
    this.save(s);
  }

  /** Write, list and delete a small object, so a bad key shows up now rather than at 3am. */
  async test(body = {}) {
    const cfg = this.merge(this.settings, body);
    const client = this.client(cfg);
    const prefix = cfg.prefix || '';
    if (client instanceof S3) {
      const key = `${prefix}.gamepanel-test-${Date.now()}`;
      await client.request('PUT', key, { body: Buffer.from('GamePanel can write here.\n'), headers: { 'content-type': 'text/plain' } });
      await client.list(prefix);
      await client.remove(key);
      return { ok: true, detail: `region ${client.region}` };
    }
    return { ok: true, detail: await client.selfTest(prefix) };
  }

  /** Uploads run one at a time so a big batch never saturates the uplink. */
  queue(serverId, name) {
    const id = `${serverId}/${name}`;
    if (this.status.get(id) === 'queued' || this.status.get(id) === 'uploading') return;
    this.status.set(id, 'queued');
    this.chain = this.chain.then(() => this.upload(serverId, name)).catch(() => {});
  }

  async upload(serverId, name) {
    const id = `${serverId}/${name}`;
    const server = this.manager.servers.find((s) => s.id === serverId);
    let file;
    let remoteName = name;
    let temp = false;
    if (backups.vault.isSnapshot(name)) {
      try {
        const packed = await require('./vault-tools').exportSnapshot(backups.dirFor(serverId), name);
        file = packed.file;
        remoteName = packed.name;
        temp = true;
      } catch (err) {
        this.status.delete(id);
        // Encrypted vaults are never sent in plain form; that is not a failure worth an alert.
        if (!/Encrypted backups/.test(err.message)) this.store.addEvent('backup.upload_failed', `Copying a backup of ${server?.name || serverId} to the cloud failed: ${err.message}`, { serverId, backup: name });
        return;
      }
    } else {
      try {
        file = backups.resolve(serverId, name);
      } catch {
        this.status.delete(id);
        return;
      }
    }
    const label = server?.name || serverId;
    this.status.set(id, 'uploading');
    const started = Date.now();
    try {
      const s3 = this.client();
      await s3.putFile(this.prefixFor(serverId) + remoteName, file);
      this.status.delete(id);
      const secs = Math.round((Date.now() - started) / 1000);
      this.store.addEvent('backup.uploaded', `Backup of ${label} copied to the cloud (${secs}s)`, { serverId, backup: name });
      await this.prune(serverId).catch((err) => logger.warn(`Cloud backup clean-up failed: ${err.message}`));
    } catch (err) {
      this.status.set(id, `failed: ${err.message}`);
      this.store.addEvent('backup.upload_failed', `Copying a backup of ${label} to the cloud failed: ${err.message}`, { serverId, backup: name });
    } finally {
      if (temp) fs.rmSync(file, { force: true });
    }
  }

  async list(serverId) {
    const prefix = this.prefixFor(serverId);
    const objects = await this.client().list(prefix);
    return objects
      .filter((o) => o.key.endsWith('.tar.gz'))
      .map((o) => ({ name: o.key.slice(prefix.length), size: o.size, createdAt: o.modified }))
      .filter((o) => /^[A-Za-z0-9._-]+\.tar\.gz$/.test(o.name))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Keep only the newest `keep` copies of a server in the bucket (0 keeps all). */
  async prune(serverId) {
    const keep = this.settings.keep;
    if (!keep) return [];
    const old = (await this.list(serverId)).slice(keep);
    for (const o of old) await this.client().remove(this.prefixFor(serverId) + o.name);
    return old.map((o) => o.name);
  }

  /** Pull a cloud copy back onto the panel, where it can be restored like any backup. */
  async fetch(serverId, name) {
    if (!/^[A-Za-z0-9._-]+\.tar\.gz$/.test(String(name))) fail(400, 'Invalid backup name');
    const target = path.join(backups.dirFor(serverId), name);
    if (fs.existsSync(target)) return { ok: true, already: true };
    const partial = target + '.part';
    try {
      await this.client().download(this.prefixFor(serverId) + name, partial);
      fs.renameSync(partial, target);
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
    return { ok: true };
  }

  removeRemote(serverId, name) {
    if (!/^[A-Za-z0-9._-]+\.tar\.gz$/.test(String(name))) fail(400, 'Invalid backup name');
    return this.client().remove(this.prefixFor(serverId) + name);
  }

  statusFor(serverId) {
    const out = {};
    for (const [id, status] of this.status) if (id.startsWith(serverId + '/')) out[id.slice(serverId.length + 1)] = status;
    return out;
  }
}

let instance = null;
/** One per panel; the routes create it on first use. */
function cloudBackups(store, manager) {
  if (!instance) instance = new CloudBackups(store, manager);
  return instance;
}

module.exports = { cloudBackups, CloudBackups, S3, guessRegion, PROVIDERS };
