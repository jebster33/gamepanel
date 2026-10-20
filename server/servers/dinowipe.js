'use strict';

/**
 * ARK wild dino wipe: DestroyWildDinos over the console/RCON. Every wild
 * creature despawns and respawns fresh; tamed dinos are not touched. Handy
 * after a map has filled with stuck, overlevelled or lag-causing spawns.
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 */

const { fail } = require('../core/util');

const ARK = ['ark-survival-evolved', 'ark-survival-ascended'];

module.exports = {
  isArk(server) {
    return ARK.includes(server.templateId);
  },

  async wipeWildDinos(id, actor) {
    const server = this.require(id);
    if (!this.isArk(server)) fail(400, 'Only ARK servers have wild dinos to wipe');
    if (!this.isActive(id)) fail(409, 'Start the server first. Wild dinos only exist while it runs.');
    const out = await this.sendCommand(id, 'DestroyWildDinos');
    this.store.addEvent('server.dinowipe', `${actor?.username || 'A schedule'} wiped the wild dinos on ${server.name}`, { serverId: id });
    this.logActivity?.(id, { type: 'dinowipe', text: 'Wiped wild dinos', by: actor?.username });
    return { ok: true, response: out.response || '' };
  },
};
