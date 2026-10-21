'use strict';

/**
 * JVM flag presets for Minecraft servers, applied to the server's JAVA_ARGS
 * variable. The panel's start command already adds -Xms/-Xmx from the
 * server's memory setting, so the presets never repeat them; the ones that
 * depend on the heap size (Aikar's regions, ZGC's soft limit) are computed
 * from it.
 */

const { fail } = require('../core/util');
const { aikar } = require('./advice');

const UNSAFE = /[`$\\"'<>;&|%\r\n\x00-\x1f\x7f]/;

const mb = (n) => Math.max(256, Number(n) || 2048);

const PRESETS = [
  {
    id: 'aikar',
    name: "Aikar's flags",
    line: 'The classic tuned G1 garbage collector settings most Minecraft hosts use; smooth ticks on Java 11 to 21 with 4 GB or more.',
    minMb: 4096,
    flags: (m) => aikar(m),
  },
  {
    id: 'zgc',
    name: 'Java 21+ generational ZGC',
    line: 'Near-zero garbage collection pauses on Java 21 to 23; uses a little more memory and CPU, best for big heaps and many cores.',
    minMb: 4096,
    flags: (m) => `-XX:+UseZGC -XX:+ZGenerational -XX:SoftMaxHeapSize=${Math.floor(mb(m) * 0.85)}M -XX:+AlwaysPreTouch -XX:+DisableExplicitGC`,
  },
  {
    id: 'zgc24',
    name: 'ZGC for Java 24+',
    line: 'The same idea for Java 24 and newer, where ZGC is always generational and the old flag is gone.',
    minMb: 4096,
    flags: (m) => `-XX:+UseZGC -XX:SoftMaxHeapSize=${Math.floor(mb(m) * 0.85)}M -XX:+AlwaysPreTouch -XX:+DisableExplicitGC`,
  },
  {
    id: 'lowmem',
    name: 'Low memory',
    line: 'A single-threaded collector that keeps the process small: for 1 to 2 GB servers and tiny machines, at the cost of longer pauses.',
    minMb: 0,
    flags: () => '-XX:+UseSerialGC -XX:MinHeapFreeRatio=5 -XX:MaxHeapFreeRatio=10 -XX:+DisableExplicitGC -Xss512k',
  },
  {
    id: 'graal',
    name: 'GraalVM compiler',
    line: "Aikar's collector settings plus the Graal JIT compiler; only starts on GraalVM (or a JDK with JVMCI), so check your Java first.",
    minMb: 4096,
    flags: (m) => `${aikar(m)} -XX:+EnableJVMCI -XX:+UseJVMCICompiler -XX:+EagerJVMCI`,
  },
  {
    id: 'default',
    name: 'Java defaults',
    line: 'No extra flags: whatever the JVM picks on its own (G1 on most machines).',
    minMb: 0,
    flags: () => '',
  },
];

/** The flags a custom value may hold: plain options only, no shell characters, nothing that changes memory or what runs. */
function checkCustom(value) {
  const text = String(value ?? '').trim();
  if (text.length > 1500) fail(400, 'That is too long for JVM flags');
  if (UNSAFE.test(text)) fail(400, 'JVM flags cannot contain quotes, backslashes, ; & | < > $ % or line breaks');
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (!token.startsWith('-')) fail(400, `"${token.slice(0, 40)}" is not a JVM flag; flags start with a dash`);
    if (/^-(Xmx|Xms|jar$|cp$|classpath$|-class-path|-module-path|-add-modules=ALL)/i.test(token)) fail(400, `${token.slice(0, 20)} is set by the panel (use the Memory setting) or is not allowed here`);
  }
  return text.replace(/\s+/g, ' ');
}

function supported(manager, server) {
  const tpl = manager.template(server);
  return /^minecraft-(?!bedrock$)/.test(String(server.templateId || '')) && (tpl?.variables || []).some((v) => v.name === 'JAVA_ARGS');
}

function view(manager, server) {
  if (!supported(manager, server)) return { supported: false };
  const memory = mb(server.memory);
  const tpl = manager.template(server);
  const current = server.vars?.JAVA_ARGS ?? (tpl.variables.find((v) => v.name === 'JAVA_ARGS') || {}).default ?? '';
  const presets = PRESETS.map((p) => ({ id: p.id, name: p.name, line: p.line, flags: p.flags(memory), warn: memory < p.minMb ? `Meant for ${p.minMb / 1024} GB or more; this server has ${memory} MB.` : null }));
  const match = presets.find((p) => p.flags === String(current).trim());
  return { supported: true, memory, memoryFlags: `-Xms${memory}M -Xmx${memory}M`, current, preset: match?.id || (current ? 'custom' : 'default'), presets };
}

function apply(manager, server, { preset, custom } = {}, actor) {
  if (!supported(manager, server)) fail(400, 'This server does not use JVM flags');
  let flags;
  if (preset === 'custom') flags = checkCustom(custom);
  else {
    const p = PRESETS.find((x) => x.id === preset);
    if (!p) fail(400, 'Unknown preset');
    flags = p.flags(mb(server.memory));
  }
  manager.update(server.id, { vars: { JAVA_ARGS: flags } }, { actor, source: 'jvm-presets' });
  return view(manager, manager.require(server.id));
}

module.exports = { view, apply, checkCustom, PRESETS, supported };
