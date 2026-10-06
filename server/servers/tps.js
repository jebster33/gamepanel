'use strict';

/**
 * Ticks per second for Paper and Purpur, asked over RCON (so nothing shows
 * up in the console) every 30 seconds while the server runs. 20 is perfect;
 * below about 15 players feel lag.
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 */

const { rconCommand } = require('../games/rcon');

const SUPPORTED = ['minecraft-paper', 'minecraft-purpur'];
const EVERY_MS = 30_000;

/** "§6TPS from last 1m, 5m, 15m: §a20.0, §a*20.0, §a19.97" -> 20 */
function parseTps(text) {
  const clean = String(text || '').replace(/§./g, '');
  const m = clean.match(/TPS from last[^:]*:\s*\*?([\d.]+)/i);
  return m ? Math.min(20, Number(m[1])) : null;
}

module.exports = {
  pollTps(now = Date.now()) {
    for (const server of this.servers) {
      const rt = this.rt(server.id);
      if (!SUPPORTED.includes(server.templateId) || rt.status !== 'running') {
        rt.tps = null;
        continue;
      }
      if (rt.tpsBusy || (rt.tpsAt && now - rt.tpsAt < EVERY_MS)) continue;
      const port = server.ports?.rcon;
      const password = server.vars?.RCON_PASSWORD;
      if (!port || !password) continue;
      rt.tpsAt = now;
      rt.tpsBusy = true;
      rconCommand({ port, password, command: 'tps', timeout: 3000 })
        .then((out) => {
          rt.tps = parseTps(out);
        })
        .catch(() => {
          rt.tps = null;
        })
        .finally(() => {
          rt.tpsBusy = false;
        });
    }
  },
};

module.exports.parseTps = parseTps;
