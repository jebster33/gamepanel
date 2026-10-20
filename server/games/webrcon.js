'use strict';

/**
 * Rust's WebRCON (rcon.web 1, what the panel's Rust template starts with): a
 * WebSocket at ws://host:port/password that takes {Identifier, Message, Name}
 * and answers with the same Identifier. Uses the WebSocket built into Node 22.
 * rconAny() tries it first and falls back to classic Source RCON (rcon.web 0).
 */

const { rconCommand } = require('./rcon');

let nextId = 1000;

function webRcon({ host = '127.0.0.1', port, password, command, timeout = 6000 }) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error('RCON port is not configured'));
    if (typeof WebSocket !== 'function') return reject(new Error('This Node has no WebSocket client'));
    const id = nextId++;
    let ws;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('WebRCON took too long')), timeout);
    try {
      ws = new WebSocket(`ws://${host}:${port}/${encodeURIComponent(String(password ?? ''))}`);
    } catch (err) {
      clearTimeout(timer);
      return reject(err);
    }
    ws.addEventListener('open', () => ws.send(JSON.stringify({ Identifier: id, Message: command, Name: 'gamepanel' })));
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.Identifier === id) finish(null, String(msg.Message ?? ''));
      } catch {
        /* console chatter that is not JSON */
      }
    });
    ws.addEventListener('error', () => finish(new Error('WebRCON connection failed')));
    ws.addEventListener('close', () => finish(new Error('WebRCON closed before answering')));
  });
}

/** WebRCON first, then classic RCON on the same port. */
async function rconAny(opts) {
  try {
    return await webRcon(opts);
  } catch (webErr) {
    try {
      return await rconCommand(opts);
    } catch {
      throw webErr;
    }
  }
}

module.exports = { webRcon, rconAny };
