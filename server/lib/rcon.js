'use strict';

/**
 * Source RCON client (also spoken by Minecraft, Rust, ARK, CS2, 7 Days to Die…).
 * Used to push console commands to servers whose stdin is not interactive.
 */

const net = require('net');

const TYPE = {
  AUTH: 3,
  AUTH_RESPONSE: 2,
  EXECCOMMAND: 2,
  RESPONSE_VALUE: 0,
};

function encode(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeUInt16BE(0, 12 + payload.length);
  return buf;
}

/**
 * Connect, authenticate, run one command, disconnect.
 * Keeping it stateless avoids having to babysit long-lived RCON sockets.
 */
function rconCommand({ host = '127.0.0.1', port, password, command, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error('RCON port is not configured'));
    const socket = net.createConnection({ host, port, timeout });
    let buffer = Buffer.alloc(0);
    let authed = false;
    let output = '';
    let settleTimer = null;
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(settleTimer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    socket.on('connect', () => socket.write(encode(1, TYPE.AUTH, String(password ?? ''))));

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < size + 4) break;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, size + 2).toString('utf8');
        buffer = buffer.subarray(size + 4);

        if (!authed) {
          if (id === -1) return finish(new Error('RCON authentication failed — wrong password'));
          if (type === TYPE.AUTH_RESPONSE) {
            authed = true;
            socket.write(encode(2, TYPE.EXECCOMMAND, command));
          }
          continue;
        }
        if (type === TYPE.RESPONSE_VALUE) {
          output += body;
          // Responses can arrive in several packets; settle briefly before resolving.
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => finish(null, output), 250);
        }
      }
    });

    socket.on('timeout', () => finish(new Error('RCON connection timed out')));
    socket.on('error', (err) => finish(err));
    socket.on('close', () => {
      if (!done) finish(null, output);
    });
  });
}

module.exports = { rconCommand };
