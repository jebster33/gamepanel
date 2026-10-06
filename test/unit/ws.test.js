'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WebSocketServer } = require('../../server/core/ws');

test('websocket handshake is accepted by a standard client', { skip: typeof WebSocket !== 'function' }, async () => {
  const wss = new WebSocketServer();
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const conn = wss.handleUpgrade(req, socket, head);
    conn?.send({ topic: 'hello' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const message = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.onmessage = (e) => {
        resolve(JSON.parse(e.data));
        ws.close();
      };
      ws.onerror = () => reject(new Error('handshake failed'));
    });
    assert.strictEqual(message.topic, 'hello');
  } finally {
    wss.close();
    server.closeAllConnections?.();
    server.close();
  }
});
