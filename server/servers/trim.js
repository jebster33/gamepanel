'use strict';

/**
 * Minecraft world trimming: delete chunks nobody ever spent time in, so a
 * world full of fly-by terrain shrinks (and so do the backups). Every chunk
 * records InhabitedTime, the ticks a player has been nearby. Chunks under
 * the limit and outside the protected area around spawn are cut out of the
 * region files (and their entities and points of interest); the server
 * generates them again from the seed if anyone ever goes there.
 * Java Edition only. Mixed into ServerManager (see manager.js).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { fail } = require('../core/util');
const { containedPath } = require('../features/files');

const SECTOR = 4096;
const TRIM_RUNNING = 'A world trim is running on this server';

// --- the least NBT needed to read a number out of a chunk or level.dat -----

function skipPayload(buf, pos, type) {
  switch (type) {
    case 1: return pos + 1;
    case 2: return pos + 2;
    case 3: case 5: return pos + 4;
    case 4: case 6: return pos + 8;
    case 7: return pos + 4 + buf.readInt32BE(pos);
    case 8: return pos + 2 + buf.readUInt16BE(pos);
    case 11: return pos + 4 + buf.readInt32BE(pos) * 4;
    case 12: return pos + 4 + buf.readInt32BE(pos) * 8;
    case 9: {
      const inner = buf.readInt8(pos);
      const count = buf.readInt32BE(pos + 1);
      pos += 5;
      for (let i = 0; i < count; i++) pos = skipPayload(buf, pos, inner);
      return pos;
    }
    case 10: {
      for (;;) {
        const t = buf.readInt8(pos++);
        if (t === 0) return pos;
        pos += 2 + buf.readUInt16BE(pos);
        pos = skipPayload(buf, pos, t);
      }
    }
    default: throw new Error('bad NBT');
  }
}

/** Pick whole numbers by name from the root compound, or from compounds called `descend`. */
function scanNbt(buf, want, descend) {
  const found = {};
  const walk = (pos) => {
    for (;;) {
      const t = buf.readInt8(pos++);
      if (t === 0) return pos;
      const len = buf.readUInt16BE(pos);
      const name = buf.toString('utf8', pos + 2, pos + 2 + len);
      pos += 2 + len;
      if (t === 10 && descend.includes(name)) pos = walk(pos);
      else {
        if (want.includes(name) && (t === 3 || t === 4) && !(name in found)) found[name] = t === 3 ? buf.readInt32BE(pos) : Number(buf.readBigInt64BE(pos));
        pos = skipPayload(buf, pos, t);
      }
    }
  };
  if (buf.readInt8(0) !== 10) throw new Error('bad NBT');
  walk(3 + buf.readUInt16BE(1));
  return found;
}

/** InhabitedTime of the chunk stored at a region entry, or null when it cannot be read. */
function inhabitedOf(region, offset, sectors) {
  try {
    const start = offset * SECTOR;
    const length = region.readInt32BE(start);
    const kind = region.readUInt8(start + 4);
    if (length < 2 || start + 4 + length > region.length) return null;
    const data = region.subarray(start + 5, start + 4 + length);
    let nbt;
    if (kind === 1) nbt = zlib.gunzipSync(data);
    else if (kind === 2) nbt = zlib.inflateSync(data);
    else if (kind === 3) nbt = data;
    else return null; // LZ4 and external chunks: keep, we cannot tell
    const { InhabitedTime } = scanNbt(nbt, ['InhabitedTime'], ['Level']);
    return Number.isFinite(InhabitedTime) ? InhabitedTime : null;
  } catch {
    return null;
  }
}

const entries = (region) => {
  const out = [];
  for (let i = 0; i < 1024; i++) {
    const loc = region.readUInt32BE(i * 4);
    const offset = loc >>> 8;
    const sectors = loc & 0xff;
    if (offset >= 2 && sectors > 0) out.push({ i, offset, sectors });
  }
  return out;
};

/** Cut the dropped chunks out of one region file and pack the rest closer. */
async function rewriteRegion(file, drop, dryRun) {
  const region = await fsp.readFile(file);
  const before = region.length;
  if (!drop.size) return { before, after: before };
  const all = entries(region);
  const keep = all.filter((e) => !drop.has(e.i));
  if (!dryRun) {
    // Chunks too big for the region file live next to it as c.X.Z.mcc.
    const [, rx, rz] = path.basename(file).match(/^r\.(-?\d+)\.(-?\d+)\.mca$/) || [];
    for (const e of all.filter((x) => drop.has(x.i))) {
      if (rx === undefined || !(region.readUInt8(e.offset * SECTOR + 4) & 0x80)) continue;
      await fsp.rm(path.join(path.dirname(file), `c.${Number(rx) * 32 + (e.i % 32)}.${Number(rz) * 32 + Math.floor(e.i / 32)}.mcc`), { force: true });
    }
  }
  if (!keep.length) {
    if (!dryRun) await fsp.rm(file, { force: true });
    return { before, after: 0 };
  }
  const parts = [Buffer.alloc(SECTOR * 2)];
  let next = 2;
  for (const e of keep) {
    const body = Buffer.alloc(e.sectors * SECTOR);
    region.copy(body, 0, e.offset * SECTOR, Math.min(region.length, (e.offset + e.sectors) * SECTOR));
    parts[0].writeUInt32BE(((next << 8) | e.sectors) >>> 0, e.i * 4);
    parts[0].writeUInt32BE(region.readUInt32BE(SECTOR + e.i * 4), SECTOR + e.i * 4);
    parts.push(body);
    next += e.sectors;
  }
  const out = Buffer.concat(parts);
  if (!dryRun) {
    await fsp.writeFile(`${file}.trim`, out);
    await fsp.rename(`${file}.trim`, file);
  }
  return { before, after: out.length };
}

const exists = (p) => fs.existsSync(p);

/** The dimensions of a world that exist on disk, with their centre for the protected area. */
function dimensionsOf(server, world, base, spawn) {
  const dims = [
    { key: 'overworld', label: 'Overworld', dirs: [world], centre: spawn },
    { key: 'nether', label: 'Nether', dirs: [`${world}/DIM-1`, `${world}_nether/DIM-1`], centre: [Math.round(spawn[0] / 8), Math.round(spawn[1] / 8)] },
    { key: 'end', label: 'The End', dirs: [`${world}/DIM1`, `${world}_the_end/DIM1`], centre: [0, 0] },
  ];
  return dims
    .map((d) => ({ ...d, dir: d.dirs.map((x) => path.join(base, x)).find((x) => exists(path.join(x, 'region'))) }))
    .filter((d) => d.dir);
}

async function readSpawn(levelDat) {
  try {
    const { SpawnX, SpawnZ } = scanNbt(zlib.gunzipSync(await fsp.readFile(levelDat)), ['SpawnX', 'SpawnZ'], ['Data']);
    return [Number.isFinite(SpawnX) ? SpawnX : 0, Number.isFinite(SpawnZ) ? SpawnZ : 0];
  } catch {
    return [0, 0];
  }
}

module.exports = {
  trimInfo(id) {
    const server = this.require(id);
    const supported = String(server.templateId || '').startsWith('minecraft') && server.templateId !== 'minecraft-bedrock';
    return { supported, job: supported ? this.trimJobs?.get(id) || null : null };
  },

  /**
   * Start a trim in the background. `dryRun` only counts what would go.
   * options: { world, minSeconds, protectRadius, dimensions: ['overworld', …], backup, dryRun }
   */
  async trimWorld(id, options = {}, actor) {
    const server = this.require(id);
    if (!this.trimInfo(id).supported) fail(400, 'World trimming works on Minecraft Java servers');
    if (this.trimJobs?.get(id)?.state === 'running') fail(409, TRIM_RUNNING);
    if (this.isActive(id)) fail(409, 'Stop the server before trimming its world');
    const world = String(options.world || this.activeWorld(server));
    if (!/^[A-Za-z0-9 _.\-]{1,64}$/.test(world) || world.startsWith('.')) fail(400, 'That is not a world name');
    const base = containedPath(server.dir, '');
    if (!exists(path.join(base, world, 'level.dat'))) fail(404, 'No such world');
    const minSeconds = Math.max(0, Math.min(86_400, Number(options.minSeconds ?? 60)));
    const protect = Math.max(0, Math.min(30_000, Math.round(Number(options.protectRadius ?? 500))));
    if (!Number.isFinite(minSeconds) || !Number.isFinite(protect)) fail(400, 'Enter numbers for the limits');
    const wanted = Array.isArray(options.dimensions) && options.dimensions.length ? options.dimensions : ['overworld'];
    const dryRun = Boolean(options.dryRun);
    const backup = !dryRun && options.backup !== false;
    if (backup) this.checkDiskRoom('make a backup');

    this.trimJobs ||= new Map();
    const job = { state: 'running', phase: backup ? 'Backing up' : 'Reading', dryRun, world, regions: 0, regionsDone: 0, startedAt: Date.now() };
    this.trimJobs.set(id, job);
    const log = (text) => this.pushConsole(server, `World trim: ${text}`, 'system');

    (async () => {
      try {
        if (backup) {
          log('backing up first…');
          job.backup = (await require('../features/backups').create(server, 'before-world-trim')).name;
        }
        job.phase = 'Trimming';
        const spawn = await readSpawn(path.join(base, world, 'level.dat'));
        const dims = dimensionsOf(server, world, base, spawn).filter((d) => wanted.includes(d.key));
        const jobs = [];
        for (const d of dims) {
          for (const f of await fsp.readdir(path.join(d.dir, 'region')).catch(() => [])) {
            if (/^r\.-?\d+\.-?\d+\.mca$/.test(f)) jobs.push({ d, f });
          }
        }
        job.regions = jobs.length;
        const totals = { chunks: 0, removed: 0, before: 0, after: 0 };
        const limit = Math.round(minSeconds * 20);
        for (const { d, f } of jobs) {
          const [, rx, rz] = f.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/).map(Number);
          const file = path.join(d.dir, 'region', f);
          const region = await fsp.readFile(file);
          const drop = new Set();
          if (region.length >= SECTOR * 2) {
            const r = Math.ceil(protect / 16);
            const [cxm, czm] = [Math.floor(d.centre[0] / 16), Math.floor(d.centre[1] / 16)];
            for (const e of entries(region)) {
              totals.chunks++;
              const cx = rx * 32 + (e.i % 32);
              const cz = rz * 32 + Math.floor(e.i / 32);
              if (protect > 0 ? Math.abs(cx - cxm) <= r && Math.abs(cz - czm) <= r : false) continue;
              const t = inhabitedOf(region, e.offset, e.sectors);
              if (t !== null && t < limit) drop.add(e.i);
            }
          }
          const size = await rewriteRegion(file, drop, dryRun);
          for (const sub of ['entities', 'poi']) {
            const other = path.join(d.dir, sub, f);
            if (!exists(other)) continue;
            const mate = await rewriteRegion(other, size.after === 0 ? new Set(Array.from({ length: 1024 }, (_, i) => i)) : drop, dryRun).catch(() => ({ before: 0, after: 0 }));
            size.before += mate.before;
            size.after += mate.after;
          }
          totals.removed += drop.size;
          totals.before += size.before;
          totals.after += size.after;
          job.regionsDone++;
          Object.assign(job, { chunks: totals.chunks, removed: totals.removed, bytesBefore: totals.before, bytesAfter: totals.after });
          await new Promise((resolve) => setImmediate(resolve));
        }
        job.state = 'done';
        job.phase = dryRun ? 'Preview' : 'Done';
        job.finishedAt = Date.now();
        if (!dryRun) {
          const text = `${actor?.username || 'Someone'} trimmed ${world} on ${server.name}: ${totals.removed.toLocaleString('en-US')} unvisited chunks removed`;
          log(`removed ${totals.removed} of ${totals.chunks} chunks.`);
          this.store.addEvent('server.world_trim', text, { serverId: id });
          this.logActivity?.(id, { type: 'world', text: `Trimmed world ${world} (${totals.removed} chunks)`, by: actor?.username });
        }
      } catch (err) {
        job.state = 'error';
        job.error = err.message;
        log(`failed: ${err.message}`);
      }
    })();
    return { ok: true, job };
  },
};

module.exports.scanNbt = scanNbt;
module.exports.rewriteRegion = rewriteRegion;
module.exports.inhabitedOf = inhabitedOf;
module.exports.TRIM_RUNNING = TRIM_RUNNING;
