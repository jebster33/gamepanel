'use strict';

/**
 * Live game-server queries: player counts, MOTD/version and round-trip ping.
 *
 * Implemented natively:
 *   - minecraft  : Java Edition Server List Ping (TCP, modern protocol)
 *   - bedrock    : RakNet unconnected ping (UDP)
 *   - a2s        : Valve A2S_INFO with challenge handshake (Source/GoldSrc/Unity)
 *   - tcp / udp  : plain reachability probe, used as a universal fallback
 */

const net = require('net');
const dgram = require('dgram');

const DEFAULT_TIMEOUT = 4000;

function offline(reason) {
  return { online: false, players: null, maxPlayers: null, latency: null, version: null, motd: null, map: null, reason };
}

/* ------------------------------------------------------------- minecraft -- */

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  if (value < 0) v = (value >>> 0) + 0; // handshake uses -1 => 0xFFFFFFFF varint
  do {
    let temp = v & 0x7f;
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null;
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) return null;
  }
  return { value: result, size: pos - offset };
}

function mcString(str) {
  const body = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(body.length), body]);
}

function mcPacket(id, ...parts) {
  const body = Buffer.concat([writeVarInt(id), ...parts]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function flattenMotd(desc) {
  if (desc == null) return null;
  if (typeof desc === 'string') return desc;
  let out = '';
  if (desc.text) out += desc.text;
  if (Array.isArray(desc.extra)) for (const part of desc.extra) out += flattenMotd(part) || '';
  if (Array.isArray(desc)) for (const part of desc) out += flattenMotd(part) || '';
  return out.replace(/§./g, '').trim() || null;
}

function queryMinecraft(host, port, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port, timeout });
    let buffer = Buffer.alloc(0);
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.on('connect', () => {
      socket.write(
        Buffer.concat([
          mcPacket(0x00, writeVarInt(-1), mcString(host), (() => {
            const b = Buffer.alloc(2);
            b.writeUInt16BE(port);
            return b;
          })(), writeVarInt(1)),
          mcPacket(0x00),
        ])
      );
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const lenField = readVarInt(buffer, 0);
      if (!lenField) return;
      const total = lenField.size + lenField.value;
      if (buffer.length < total) return;

      const idField = readVarInt(buffer, lenField.size);
      if (!idField) return finish(offline('Malformed response'));
      const strField = readVarInt(buffer, lenField.size + idField.size);
      if (!strField) return finish(offline('Malformed response'));
      const start = lenField.size + idField.size + strField.size;
      const jsonRaw = buffer.subarray(start, start + strField.value).toString('utf8');

      try {
        const data = JSON.parse(jsonRaw);
        finish({
          online: true,
          players: data.players?.online ?? 0,
          maxPlayers: data.players?.max ?? null,
          playerList: (data.players?.sample || []).map((p) => p.name),
          latency: Date.now() - started,
          version: data.version?.name || null,
          motd: flattenMotd(data.description),
          map: null,
        });
      } catch {
        finish(offline('Unreadable status payload'));
      }
    });

    socket.on('timeout', () => finish(offline('Timed out')));
    socket.on('error', (err) => finish(offline(err.code || err.message)));
  });
}

/* --------------------------------------------------------------- bedrock -- */

const RAKNET_MAGIC = Buffer.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
]);

function queryBedrock(host, port, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const started = Date.now();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(offline('Timed out')), timeout);

    const packet = Buffer.concat([
      Buffer.from([0x01]),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64BE(BigInt(Date.now()));
        return b;
      })(),
      RAKNET_MAGIC,
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ]);

    socket.on('message', (msg) => {
      if (msg[0] !== 0x1c || msg.length < 35) return finish(offline('Unexpected reply'));
      const strLen = msg.readUInt16BE(33);
      const payload = msg.subarray(35, 35 + strLen).toString('utf8');
      const parts = payload.split(';');
      finish({
        online: true,
        motd: parts[1] || null,
        version: parts[3] || null,
        players: Number(parts[4] ?? 0),
        maxPlayers: Number(parts[5] ?? 0),
        map: parts[7] || null,
        playerList: [],
        latency: Date.now() - started,
      });
    });

    socket.on('error', (err) => finish(offline(err.code || err.message)));
    socket.send(packet, port, host, (err) => {
      if (err) finish(offline(err.code || err.message));
    });
  });
}

/* ------------------------------------------------------------------- a2s -- */

function readCString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0x00) end++;
  return { value: buf.subarray(offset, end).toString('utf8'), next: end + 1 };
}

function queryA2S(host, port, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const started = Date.now();
    let done = false;
    let challengeTries = 0;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(offline('Timed out')), timeout);

    const request = (challenge) => {
      const base = Buffer.concat([
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
        Buffer.from('Source Engine Query\0', 'ascii'),
      ]);
      const packet = challenge ? Buffer.concat([base, challenge]) : base;
      socket.send(packet, port, host, (err) => {
        if (err) finish(offline(err.code || err.message));
      });
    };

    socket.on('message', (msg) => {
      if (msg.length < 5) return;
      // Multi-packet responses are not used by A2S_INFO in practice.
      if (msg.readInt32LE(0) !== -1) return finish(offline('Split response unsupported'));
      const type = msg[4];

      if (type === 0x41) {
        // challenge — retry once with the token appended
        if (challengeTries++ > 2) return finish(offline('Challenge loop'));
        return request(msg.subarray(5, 9));
      }
      if (type !== 0x49) return finish(offline('Unexpected reply 0x' + type.toString(16)));

      try {
        let off = 6; // skip header + type + protocol byte
        const name = readCString(msg, off);
        const map = readCString(msg, name.next);
        const folder = readCString(msg, map.next);
        const game = readCString(msg, folder.next);
        off = game.next + 2; // skip appid (short)
        const players = msg[off];
        const maxPlayers = msg[off + 1];
        const bots = msg[off + 2];
        finish({
          online: true,
          players,
          maxPlayers,
          bots,
          motd: name.value,
          map: map.value,
          version: game.value,
          playerList: [],
          latency: Date.now() - started,
        });
      } catch {
        finish(offline('Malformed A2S payload'));
      }
    });

    socket.on('error', (err) => finish(offline(err.code || err.message)));
    request(null);
  });
}

/* ----------------------------------------------------------------- probe -- */

function probeTcp(host, port, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port, timeout });
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };
    socket.on('connect', () =>
      finish({ online: true, players: null, maxPlayers: null, latency: Date.now() - started, version: null, motd: null, map: null })
    );
    socket.on('timeout', () => finish(offline('Timed out')));
    socket.on('error', (err) => finish(offline(err.code || err.message)));
  });
}

/**
 * UDP has no handshake, so "reachable" only means the port did not answer with
 * ICMP unreachable. Good enough as a liveness hint for exotic games.
 */
function probeUdp(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ online: true, players: null, maxPlayers: null, latency: null, version: null, motd: null, map: null }),
      timeout
    );
    socket.on('error', (err) => finish(offline(err.code || err.message)));
    socket.send(Buffer.from([0x00]), port, host, (err) => {
      if (err) finish(offline(err.code || err.message));
    });
  });
}

const HANDLERS = {
  minecraft: queryMinecraft,
  bedrock: queryBedrock,
  a2s: queryA2S,
  source: queryA2S,
  tcp: probeTcp,
  udp: probeUdp,
};

/**
 * @param {{type:string, host?:string, port:number, timeout?:number}} opts
 */
async function query(opts) {
  const handler = HANDLERS[opts.type];
  if (!handler) return offline('Unsupported query type: ' + opts.type);
  if (!opts.port) return offline('No query port configured');
  try {
    return await handler(opts.host || '127.0.0.1', Number(opts.port), opts.timeout || DEFAULT_TIMEOUT);
  } catch (err) {
    return offline(err.message);
  }
}

module.exports = { query, queryMinecraft, queryBedrock, queryA2S, probeTcp, probeUdp, QUERY_TYPES: Object.keys(HANDLERS) };
