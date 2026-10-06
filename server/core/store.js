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
  constructor(file) {
    super();
    this.file = file;
    this.tmp = file + '.tmp';
    this.state = null;
    this._writeTimer = null;
    this._writing = false;
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = { ...structuredClone(DEFAULT_STATE), ...parsed };
      this.state.settings = { ...structuredClone(DEFAULT_STATE.settings), ...(parsed.settings || {}) };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error('Could not read state file, starting fresh:', err.message);
        try {
          fs.copyFileSync(this.file, this.file + '.corrupt.' + Date.now());
        } catch {
          /* nothing to preserve */
        }
      }
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
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // This file holds password hashes, RCON passwords and API keys — it must
      // not be readable by other accounts on the machine.
      fs.writeFileSync(this.tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(this.tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        /* best effort on non-POSIX */
      }
    } catch (err) {
      logger.error('Failed to persist state:', err.message);
    } finally {
      this._writing = false;
      if (this._dirty) setTimeout(() => this.saveNow(), 50).unref?.();
    }
  }

  /** Append to the audit/event log, keeping the most recent 500 entries. */
  addEvent(type, message, meta = {}) {
    const event = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), type, message, ...meta, at: Date.now() };
    this.state.events.unshift(event);
    if (this.state.events.length > 500) this.state.events.length = 500;
    this.save();
    // Notifications (Discord and friends) listen here.
    this.emit('event', event);
    return event;
  }
}

module.exports = { Store, DEFAULT_STATE };
