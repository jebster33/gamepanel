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

// How to post a message in game chat, for restart countdowns. {msg} is
// replaced; quotes are stripped from the message first.
const BROADCAST = {
  minecraft: 'say {msg}',
  'minecraft-bedrock': 'say {msg}',
  cs2: 'say "{msg}"',
  garrysmod: 'say "{msg}"',
  left4dead2: 'say "{msg}"',
  tf2: 'say "{msg}"',
  rust: 'say "{msg}"',
  terraria: 'say {msg}',
  unturned: 'say "{msg}"',
  'seven-days-to-die': 'say "{msg}"',
  squad: 'AdminBroadcast {msg}',
  factorio: '{msg}',
  'project-zomboid': 'servermsg "{msg}"',
  'ark-survival-evolved': 'serverchat {msg}',
  'ark-survival-ascended': 'serverchat {msg}',
  palworld: 'Broadcast {msg}',
};

function broadcastCommand(template) {
  if (!template) return null;
  if (template.players?.broadcast) return template.players.broadcast;
  if (BROADCAST[template.id]) return BROADCAST[template.id];
  if (template.query?.type === 'minecraft') return BROADCAST.minecraft;
  return null;
}

/**
 * Put text into a broadcast command ("say {msg}"). Quotes, line breaks and
 * ; are dropped (Source consoles split commands on ;), and a function
 * replacer keeps $' and $& in the text from being expanded.
 */
function fillBroadcast(command, text) {
  const clean = String(text).replace(/["\r\n;]/g, ' ').replace(/\s+/g, ' ').trim();
  return command.replace('{msg}', () => clean);
}

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

module.exports = { playerCommands, broadcastCommand, fillBroadcast, setPlayers, playerDetails };
