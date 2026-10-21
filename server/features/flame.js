'use strict';

/**
 * A flame graph of where a Java game server spends its time, without any
 * plugin. The panel asks the JVM for a thread dump (SIGQUIT) many times over
 * half a minute, takes the dumps out of the console so they do not flood it,
 * and merges the stacks of the busy threads into one tree.
 *
 * It works for every Java server (Minecraft, Mindustry, Project Zomboid…), on
 * Linux, in a container or as a process. Each dump pauses the JVM for a
 * moment, so it is a good idea to profile while the lag happens, not all day.
 * Idle threads (waiting, sleeping, parked, blocked in the network) are left
 * out: what remains is the work being done.
 */

const { execFile } = require('child_process');
const { fail, logger } = require('../core/util');
const { isLinux } = require('../core/platform');
const { docker } = require('../servers/runtimes/docker-api');

const MAX_SECONDS = 120;
const jobs = new Map(); // serverId -> job

// Frames that mean the thread is waiting, not working.
const IDLE_TOP = /^(java\.lang\.Object\.wait|java\.lang\.Thread\.(sleep|yield|onSpinWait)|jdk\.internal\.misc\.Unsafe\.park|sun\.misc\.Unsafe\.park|java\.util\.concurrent\.locks\.LockSupport\.park|sun\.nio\.ch\.(EPoll|EPollSelectorImpl|KQueue|WindowsSelectorImpl|SocketDispatcher|ServerSocketChannelImpl|NioSocketImpl|DatagramChannelImpl)\.|java\.net\.(PlainSocketImpl|SocketInputStream|PlainDatagramSocketImpl|ServerSocket|Socket)|sun\.nio\.ch\.IOUtil\.|java\.io\.FileInputStream\.read|java\.io\.RandomAccessFile\.read|jdk\.internal\.misc\.Blocker|java\.lang\.ref\.Reference\.waitForReferencePendingList|java\.lang\.ref\.ReferenceQueue\.remove|java\.util\.concurrent\.ForkJoinPool\.awaitWork|java\.util\.concurrent\.SynchronousQueue|io\.netty\.channel\.epoll\.Native\.epollWait|io\.netty\.channel\.nio\.NioEventLoop\.select|java\.lang\.Thread\.dumpThreads|java\.lang\.Process)/;

/** A filter for emitConsoleLines: swallows "Full thread dump … JNI global refs … Heap" blocks and hands the dump text on. */
function makeFilter(onDump) {
  let state = 'idle';
  let buffer = [];
  return (lines) => {
    const keep = [];
    for (const line of lines) {
      if (state === 'idle') {
        if (/^Full thread dump /.test(line)) {
          state = 'dump';
          buffer = [line];
        } else keep.push(line);
      } else if (state === 'dump') {
        buffer.push(line);
        if (/^JNI global/.test(line)) {
          onDump(buffer.join('\n'));
          buffer = [];
          state = 'tail';
        }
      } else if (/^\s*$/.test(line) || /^Heap\b|^\s+(garbage-first|PSYoungGen|ParOldGen|def new|tenured|Metaspace|class space|region size|eden|from|to|object space|Shenandoah|ZHeap|ZGC|total|used|capacity|committed|reserved|space|\[)|^\s*(NonHeap|Class space|Metaspace)|^ [A-Za-z ]+: \d/.test(line)) {
        // the heap summary the JVM prints after a dump
      } else {
        state = 'idle';
        if (/^Full thread dump /.test(line)) {
          state = 'dump';
          buffer = [line];
        } else keep.push(line);
      }
    }
    return keep;
  };
}

/** Threads of one dump: [{ name, state, frames: [top … bottom] }] */
function parseDump(text) {
  const threads = [];
  let current = null;
  for (const raw of String(text).split('\n')) {
    const head = raw.match(/^"(.*?)"(?:\s|$)/);
    if (head) {
      current = { name: head[1], state: '', frames: [] };
      threads.push(current);
    } else if (current) {
      const st = raw.match(/java\.lang\.Thread\.State:\s*(\w+)/);
      if (st) current.state = st[1];
      const at = raw.match(/^\s+at (.+)$/);
      if (at) current.frames.push(at[1].replace(/\(.*$/, '').replace(/^(?:[\w.$]+@[\w.\-]+\/)/, '')); // drop "module@version/"
    }
  }
  return threads.filter((t) => t.frames.length);
}

const groupName = (name) => name.replace(/\d+/g, '#').slice(0, 40);

/** Merge dumps into a tree: root → thread group → frames from the bottom up. */
function buildTree(dumps, { threadFilter = null } = {}) {
  const root = { name: 'all threads', value: 0, children: new Map() };
  const self = new Map();
  let samples = 0;
  for (const dump of dumps) {
    for (const t of dump) {
      if (t.state !== 'RUNNABLE' || IDLE_TOP.test(t.frames[0])) continue;
      if (threadFilter && !threadFilter.test(t.name)) continue;
      samples++;
      let node = root;
      node.value++;
      const path = [groupName(t.name), ...[...t.frames].reverse()];
      for (const name of path) {
        let child = node.children.get(name);
        if (!child) node.children.set(name, (child = { name, value: 0, children: new Map() }));
        child.value++;
        node = child;
      }
      self.set(t.frames[0], (self.get(t.frames[0]) || 0) + 1);
    }
  }
  const total = root.value || 1;
  const finish = (n, depth) => ({
    name: n.name,
    value: n.value,
    children: depth > 60 ? [] : [...n.children.values()].filter((c) => c.value / total >= 0.004).sort((a, b) => b.value - a.value).map((c) => finish(c, depth + 1)),
  });
  return { tree: finish(root, 0), samples, self };
}

/** Which plugin or mod a class belongs to, by package: the first three segments of non-JDK frames. */
const SKIP_PKG = /^(java|javax|jdk|sun|com\.sun|org\.apache|io\.netty|com\.google|it\.unimi|org\.slf4j|org\.objectweb|com\.mojang|net\.minecraft|net\.minecraftforge|net\.neoforged|net\.fabricmc|org\.bukkit|org\.spigotmc|io\.papermc|com\.destroystokyo|org\.spongepowered)\b/;

function hotPackages(dumps) {
  const counts = new Map();
  let total = 0;
  for (const dump of dumps) {
    for (const t of dump) {
      if (t.state !== 'RUNNABLE' || IDLE_TOP.test(t.frames[0])) continue;
      total++;
      const frame = t.frames.find((f) => !SKIP_PKG.test(f) && /\./.test(f));
      if (!frame) continue;
      const pkg = frame.split('.').slice(0, 3).join('.');
      counts.set(pkg, (counts.get(pkg) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([pkg, n]) => ({ pkg, share: total ? n / total : 0 }));
}

function sh(file, args) {
  return new Promise((resolve) => execFile(file, args, { timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout))));
}

/** The java process of a server running as a plain process: the process itself or its descendants. */
async function findJavaPid(rootPid) {
  const out = await sh('ps', ['-eo', 'pid=,ppid=,comm=']);
  const kids = new Map();
  const comm = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    comm.set(Number(m[1]), m[3]);
    (kids.get(Number(m[2])) || kids.set(Number(m[2]), []).get(Number(m[2]))).push(Number(m[1]));
  }
  const queue = [Number(rootPid)];
  while (queue.length) {
    const pid = queue.shift();
    if (/java/i.test(comm.get(pid) || '')) return pid;
    queue.push(...(kids.get(pid) || []));
  }
  return null;
}

const QUIT_IN_CONTAINER = 'for d in /proc/[0-9]*; do if [ "$(cat $d/comm 2>/dev/null)" = java ]; then kill -QUIT ${d#/proc/}; fi; done';

function isJava(manager, server) {
  const tpl = manager.template(server);
  return /\bjava\b|\.jar\b/i.test(`${server.startCommand || tpl?.startCommand || ''} ${tpl?.image || ''}`);
}

function start(manager, server, { seconds = 30 } = {}) {
  if (jobs.get(server.id)?.state === 'running') fail(409, 'A profile is already running on this server');
  if (!isLinux) fail(400, 'The flame graph needs a Linux host (it uses thread dumps)');
  if (!isJava(manager, server)) fail(400, 'This works for Java servers only');
  const rt = manager.rt(server.id);
  if (rt.status !== 'running') fail(409, 'Start the server first, then profile it while it is busy');
  const secs = Math.max(5, Math.min(MAX_SECONDS, Math.round(Number(seconds) || 30)));
  const job = { id: Date.now().toString(36), state: 'running', startedAt: Date.now(), seconds: secs, dumps: 0 };
  jobs.set(server.id, job);
  const dumps = [];
  rt.dumpFilter = makeFilter((text) => {
    dumps.push(parseDump(text));
    job.dumps = dumps.length;
  });
  (async () => {
    try {
      const container = rt.docker?.id;
      let pid = null;
      if (!container) {
        pid = await findJavaPid(rt.pid);
        if (!pid) throw new Error('Could not find the Java process');
      }
      const end = Date.now() + secs * 1000;
      while (Date.now() < end && manager.rt(server.id).status === 'running') {
        if (container) await docker.exec(container, ['sh', '-c', QUIT_IN_CONTAINER]);
        else process.kill(pid, 'SIGQUIT');
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, 1000));
      rt.dumpFilter = null;
      if (!dumps.length) throw new Error('The server did not print any thread dumps. Its Java may be started in a way that hides them.');
      const all = buildTree(dumps);
      const main = buildTree(dumps, { threadFilter: /^(Server thread|main|Tick|Game Thread|Server Thread)/i });
      job.result = {
        samples: dumps.length,
        busy: all.samples,
        all: all.tree,
        main: main.samples ? main.tree : null,
        top: [...all.self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([frame, n]) => ({ frame, share: n / (all.samples || 1) })),
        packages: hotPackages(dumps),
      };
      job.state = 'done';
      job.finishedAt = Date.now();
    } catch (err) {
      rt.dumpFilter = null;
      job.state = 'failed';
      job.error = err.message;
      logger.warn(`Flame graph on ${server.name}: ${err.message}`);
    }
  })();
  return status(server.id);
}

const status = (serverId) => {
  const job = jobs.get(serverId);
  if (!job) return { state: 'idle' };
  return { id: job.id, state: job.state, seconds: job.seconds, dumps: job.dumps, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error, result: job.result };
};

module.exports = { start, status, makeFilter, parseDump, buildTree, hotPackages, isJava };
