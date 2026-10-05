'use strict';

/**
 * Who is online, for the Players tab: names, when they joined, score where
 * the game reports one, and the console commands that kick or ban them.
 */

// {name} is replaced with the player's name. Only games whose console takes a
// plain name are listed; the rest still show who is online.
const COMMANDS = {
  minecraft: { kick: 'kick {name}', ban: 'ban {name}' },
  'minecraft-bedrock': { kick: 'kick {name}' },
  cs2: { kick: 'kick "{name}"' },
  garrysmod: { kick: 'kick "{name}"' },
  left4dead2: { kick: 'kick "{name}"' },
  tf2: { kick: 'kick "{name}"' },
  rust: { kick: 'kick "{name}"', ban: 'ban "{name}"' },
  terraria: { kick: 'kick {name}', ban: 'ban {name}' },
  unturned: { kick: 'kick {name}', ban: 'ban {name}' },
  'seven-days-to-die': { kick: 'kick "{name}"' },
  squad: { kick: 'AdminKick "{name}"' },
  factorio: { kick: '/kick {name}', ban: '/ban {name}' },
  'project-zomboid': { kick: 'kickuser "{name}"', ban: 'banuser "{name}"' },
};

function playerCommands(template) {
  if (!template) return {};
  if (template.players?.commands) return template.players.commands;
  if (COMMANDS[template.id]) return COMMANDS[template.id];
  if (template.query?.type === 'minecraft') return COMMANDS.minecraft;
  return {};
}

/**
 * Replace the online list, keeping each player's join time across updates.
 * `list` is names, or { name, score, time } from a query that knows more.
 */
function setPlayers(rt, list) {
  const now = Date.now();
  const before = rt.playerInfo || new Map();
  const next = new Map();
  for (const entry of list) {
    const p = typeof entry === 'string' ? { name: entry } : entry;
    const name = String(p.name || '').trim();
    if (!name || next.has(name)) continue;
    const known = before.get(name);
    // A query that reports time connected beats our own first sighting.
    const since = p.time != null ? now - p.time * 1000 : known?.since ?? now;
    next.set(name, { name, since: known && p.time == null ? known.since : since, score: p.score ?? null });
  }
  rt.playerInfo = next;
  rt.playerList = [...next.keys()];
}

function playerDetails(rt) {
  return [...(rt.playerInfo?.values() || [])];
}

module.exports = { playerCommands, setPlayers, playerDetails };
