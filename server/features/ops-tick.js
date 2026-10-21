'use strict';

/**
 * The minute tick for the operations features (called by the scheduler):
 * cost sampling, memory pressure, disk quotas, DDNS, the trash cleanup and
 * status-page incidents. Each part is isolated so one failing never stops
 * the others.
 */

const { logger } = require('../core/util');

let hostMetrics = null;
let lastQuota = 0;
let lastTrash = 0;

/** The panel's host sampler, for the cost figures. */
const init = (h) => {
  hostMetrics = h;
};

function tick(manager, store, now) {
  const guard = (name, fn) => {
    try {
      const out = fn();
      if (out?.catch) out.catch((err) => logger.warn(`${name}: ${err.message}`));
    } catch (err) {
      logger.warn(`${name}: ${err.message}`);
    }
  };
  guard('Cost sampling', () => require('./costs').sample(manager, store, hostMetrics?.last?.cpu?.percent ?? 0, now));
  guard('Memory pressure', () => require('./pressure').tick(manager, store, now));
  guard('Status incidents', () => require('./incidents').tick(manager, store, now));
  guard('Dynamic DNS', () => require('./ddns').tick(manager, store, now));
  if (now - lastQuota > 5 * 60_000) {
    lastQuota = now;
    guard('Disk quotas', () => require('./disk-quota').tick(manager, store));
  }
  if (now - lastTrash > 6 * 3600_000) {
    lastTrash = now;
    guard('Trash cleanup', () => require('./trash').tick(manager));
  }
}

module.exports = { tick, init };
