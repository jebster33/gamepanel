'use strict';

/**
 * Windows metrics without agents: one long-lived PowerShell process prints a
 * JSON snapshot of every process, the network adapters and the established
 * TCP connections on an interval. Starting PowerShell is slow, so it is
 * started once and kept, and restarted if it ever exits.
 */

const { spawn } = require('child_process');
const { logger } = require('../../core/util');

const SCRIPT = (intervalMs) => `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $procs = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize |
    ForEach-Object { ,@([int]$_.ProcessId, [int]$_.ParentProcessId, [int64](($_.KernelModeTime + $_.UserModeTime) / 10000), [int64]$_.WorkingSetSize) })
  $rx = 0; $tx = 0
  Get-NetAdapterStatistics | ForEach-Object { $rx += $_.ReceivedBytes; $tx += $_.SentBytes }
  $tcp = @(Get-NetTCPConnection -State Established | Group-Object LocalPort | ForEach-Object { ,@([int]$_.Name, [int]$_.Count) })
  $out = @{ p = $procs; rx = $rx; tx = $tx; t = $tcp } | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${Math.max(1000, Number(intervalMs) || 3000)}
}`;

class WindowsSampler {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.child = null;
    this.latest = null; // { at, procs: Map<pid,{ppid,cpuMs,ws}>, rx, tx, tcp: Map<port,count> }
    this.restarts = 0;
    this.stopped = false;
  }

  start() {
    if (this.child || this.stopped) return;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.child = child;
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('{')) this.parse(line);
      }
    });
    child.on('error', (err) => logger.debug(`metrics sampler: ${err.message}`));
    child.on('exit', () => {
      this.child = null;
      if (this.stopped || this.restarts++ > 20) return;
      setTimeout(() => this.start(), 5000).unref?.();
    });
    child.stdin.end(SCRIPT(this.intervalMs));
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }

  parse(line) {
    try {
      const raw = JSON.parse(line);
      const procs = new Map();
      for (const row of raw.p || []) {
        if (Array.isArray(row)) procs.set(row[0], { ppid: row[1], cpuMs: row[2], ws: row[3] });
      }
      const tcp = new Map();
      for (const row of raw.t || []) if (Array.isArray(row)) tcp.set(row[0], row[1]);
      this.latest = { at: Date.now(), procs, rx: Number(raw.rx) || 0, tx: Number(raw.tx) || 0, tcp };
    } catch (err) {
      logger.debug(`metrics sampler parse: ${err.message}`);
    }
  }

  /** CPU time and memory summed over a process and everything below it. */
  processTree(rootPid) {
    const snap = this.latest;
    if (!snap || !rootPid || !snap.procs.has(rootPid)) return null;
    const children = new Map();
    for (const [pid, info] of snap.procs) {
      if (!children.has(info.ppid)) children.set(info.ppid, []);
      children.get(info.ppid).push(pid);
    }
    let cpuMs = 0;
    let ws = 0;
    let count = 0;
    const seen = new Set();
    const stack = [rootPid];
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const info = snap.procs.get(pid);
      if (!info) continue;
      cpuMs += info.cpuMs;
      ws += info.ws;
      count++;
      for (const child of children.get(pid) || []) if (child !== pid) stack.push(child);
    }
    return { cpuMs, rss: ws, procs: count, at: snap.at };
  }

  connections(ports) {
    const snap = this.latest;
    if (!snap) return 0;
    let n = 0;
    for (const port of ports) n += snap.tcp.get(Number(port)) || 0;
    return n;
  }
}

module.exports = { WindowsSampler };
