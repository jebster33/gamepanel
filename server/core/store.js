'use strict';

/**
 * Tiny persistent JSON store. No database daemon, no native modules —
 * the whole panel state is one file that is written atomically.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { logger } = require('./util');

const DEFAULT_STATE = {
  version: 1,
  users: [],
  servers: [],
  events: [],
  // People who reach servers through the bridge client (features/bridge).
  bridge: { connections: [] },
  settings: {
    panelName: 'GamePanel',
    portRangeStart: 27000,
    portRangeEnd: 27999,
    autoRestart: true,
    maxCrashRestarts: 5,
    // Run each game server in its own container when Docker is available.
    containerize: true,
    // Resolve sign-in IPs to a city for the activity log (uses ipwho.is).
    geoLookup: true,
    // Panel-wide caps (0 = none): see servers/limits.js.
    limits: { memoryMb: 0, cpuCores: 0, diskGb: 0 },
    // Where to post alerts (crashes, installs, backups…).
    notifications: { discordWebhook: '', events: ['server.crashed', 'server.install_failed', 'backup.failed', 'panel.updated'] },
    // Bridge: reach servers through the panel's own port instead of opening theirs.
    bridge: { enabled: false, publicUrl: '' },
    integrations: {
      curseforgeKey: '',
      steamApiKey: '',
      factorio: { username: '', token: '' },
    },
  },
};

class Store extends EventEmitter {
  constructor(file, { tmpDir } = {}) {
    super();
    this.file = file;
    this.tmp = file && (tmpDir ? path.join(tmpDir, path.basename(file) + '.tmp') : file + '.tmp');
    // The previous good copy, kept for when the main file is cut short.
    this.backup = file && file + '.bak';
    this.state = null;
    this._writeTimer = null;
    this._writing = false;
    this._dirty = false;
    this.lastWriteError = null;
    this.load();
  }

  load() {
    // No file: an in-memory store (tests, one-off tools).
    if (!this.file) {
      this.state = structuredClone(DEFAULT_STATE);
      return this.state;
    }
    const read = (file) => {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a panel state object');
      return parsed;
    };
    let parsed = null;
    try {
      parsed = read(this.file);
    } catch (err) {
      // Permissions or a failing disk: the file may be fine, so never start over on top of it.
      if (['EACCES', 'EPERM', 'EIO', 'EISDIR'].includes(err.code)) throw new Error(`Cannot read ${this.file} (${err.code}). Fix its owner or permissions and start the panel again.`);
      if (err.code !== 'ENOENT') {
        logger.error('Could not read state file:', err.message);
        try {
          fs.copyFileSync(this.file, this.file + '.corrupt.' + Date.now());
        } catch {
          /* nothing to preserve */
        }
      }
      // A cut-short write (power loss, full disk) leaves the copy from the save before it.
      try {
        parsed = read(this.backup);
        logger.warn(`Restored the panel state from ${path.basename(this.backup)}; the last few seconds of changes may be missing.`);
      } catch (backupErr) {
        if (err.code !== 'ENOENT' || backupErr.code !== 'ENOENT') logger.error('No usable backup of the state file either; starting fresh.');
      }
    }
    if (parsed) {
      this.state = { ...structuredClone(DEFAULT_STATE), ...parsed };
      this.state.settings = { ...structuredClone(DEFAULT_STATE.settings), ...(parsed.settings || {}) };
      // Lists other code walks must be lists, even in a hand-edited file.
      for (const key of ['users', 'servers', 'events']) if (!Array.isArray(this.state[key])) this.state[key] = [];
    } else {
      this.state = structuredClone(DEFAULT_STATE);
      this.saveNow();
    }
    return this.state;
  }

  /** Queue a debounced write. Safe to call on every mutation. */
  save() {
    this._dirty = true;
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.saveNow();
    }, 150);
    if (this._writeTimer.unref) this._writeTimer.unref();
  }

  saveNow() {
    if (this._writing) {
      this._dirty = true;
      return;
    }
    this._writing = true;
    this._dirty = false;
    try {
      if (!this.file) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.mkdirSync(path.dirname(this.tmp), { recursive: true });
      // This file holds password hashes, RCON passwords and API keys — it must
      // not be readable by other accounts on the machine.
      // Flushed to disk before the rename, so a crash or power cut leaves the old file or the new one, never half of one.
      const fd = fs.openSync(this.tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(this.state, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.copyFileSync(this.file, this.backup);
        fs.chmodSync(this.backup, 0o600);
      } catch {
        /* first save, or best effort */
      }
      fs.renameSync(this.tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        /* best effort on non-POSIX */
      }
      this.lastWriteError = null;
    } catch (err) {
      // A full or read-only disk: kept so /api/health can say so instead of only the log.
      if (!this.lastWriteError) logger.error('Failed to persist state:', err.message);
      this.lastWriteError = { message: err.message, at: Date.now() };
    } finally {
      this._writing = false;
      if (this._dirty) setTimeout(() => this.saveNow(), 50).unref?.();
    }
  }

  /** Append to the audit/event log, keeping the most recent 500 entries. */
  addEvent(type, message, meta = {}) {
    const event = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), type, message: typeof message === 'string' ? message.slice(0, 500) : message, ...meta, at: Date.now() };
    this.state.events.unshift(event);
    if (this.state.events.length > 500) this.state.events.length = 500;
    this.save();
    // Notifications (Discord and friends) listen here.
    this.emit('event', event);
    return event;
  }
}

module.exports = { Store, DEFAULT_STATE };
