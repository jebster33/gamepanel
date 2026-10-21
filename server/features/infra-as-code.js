'use strict';

/**
 * Servers as a file ("infrastructure as code"). Export what the panel has to
 * YAML, edit it, then preview a plan and apply it in one go:
 *
 *   version: 1
 *   prune: false            # true: servers missing from the file are removed
 *   servers:
 *     - name: Survival
 *       id: survival-ab12   # optional; matches an existing server before the name does
 *       template: minecraft-paper
 *       memory: 4096
 *       ports: { game: 25565 }
 *       vars: { MOTD: Welcome }
 *
 * Only fields that appear in the file are managed; leaving one out leaves the
 * server's value alone. Secret variables (passwords, tokens) are never
 * exported and are refused on apply: set those in the panel.
 */

const yaml = require('../core/yaml');
const secrets = require('../core/secrets');
const { fail, logger, SECRET_NAME } = require('../core/util');

const SCALARS = {
  memory: { type: 'int', min: 256, max: 4_194_304 },
  cpuLimit: { type: 'number', min: 0, max: 1024 },
  maxPlayers: { type: 'int', min: 0, max: 100_000 },
  backupRetention: { type: 'int', min: 0, max: 1000 },
  idleStopMinutes: { type: 'int', min: 0, max: 1440 },
  hangRestartMinutes: { type: 'int', min: 0, max: 60 },
  autoStart: { type: 'bool' },
  autoRestart: { type: 'bool' },
  updateOnStart: { type: 'bool' },
  autoUpdate: { type: 'bool' },
  name: { type: 'string', max: 60 },
  ip: { type: 'string', max: 64, pattern: /^[0-9a-fA-F.:]+$/ },
  startCommand: { type: 'string', max: 4000, nullable: true },
  notes: { type: 'string', max: 4000 },
};
// Fields create() takes straight from its input; the rest are set by an update right after.
const CREATE_FIELDS = new Set(['name', 'memory', 'cpuLimit', 'maxPlayers', 'autoStart', 'autoRestart', 'updateOnStart', 'startCommand', 'ip']);
const KNOWN = new Set(['id', 'template', 'ports', 'vars', ...Object.keys(SCALARS)]);
const MAX_SERVERS = 200;

/** True for a variable the file must never carry. */
function isSecretVar(template, name, value) {
  return secrets.secretNames(template).has(name) || SECRET_NAME.test(name) || secrets.isSealed(value);
}

/* ---------------------------------------------------------------- export -- */

function exportServers(manager) {
  const servers = manager.servers.map((s) => {
    const template = manager.template(s);
    const out = { name: s.name, id: s.id, template: s.templateId };
    for (const key of Object.keys(SCALARS)) {
      if (key === 'name') continue;
      const v = s[key];
      if (v === undefined || (key === 'notes' && !v) || (key === 'startCommand' && !v) || (key === 'ip' && (!v || v === '0.0.0.0'))) continue;
      out[key] = v;
    }
    out.ports = { ...(s.ports || {}) };
    const vars = {};
    for (const [name, value] of Object.entries(s.vars || {})) {
      if (isSecretVar(template, name, value)) continue;
      vars[name] = value;
    }
    out.vars = vars;
    return out;
  });
  return { version: 1, prune: false, servers };
}

function exportYaml(manager) {
  return yaml.emit(exportServers(manager), {
    header: 'GamePanel servers. Edit, then use Settings -> Servers as a file -> Preview, or `gamepanel apply <file>`.\nSecret variables (passwords, tokens) are left out on purpose: set them in the panel.\nFields you leave out are not changed. Set prune: true to remove servers that are not listed.',
  });
}

/* ----------------------------------------------------------------- parse -- */

function parseDocument(text) {
  let doc;
  try {
    doc = yaml.parse(text);
  } catch (err) {
    fail(400, `The file could not be read. ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail(400, 'The file must be a map with a "servers" list');
  if (doc.version !== undefined && Number(doc.version) !== 1) fail(400, 'Unsupported version: this panel reads version 1');
  if (!Array.isArray(doc.servers)) fail(400, 'The file needs a "servers:" list');
  if (doc.servers.length > MAX_SERVERS) fail(400, `At most ${MAX_SERVERS} servers per file`);
  return { prune: doc.prune === true, servers: doc.servers };
}

/* ---------------------------------------------------------------- checks -- */

function checkScalar(key, value, errors) {
  const rule = SCALARS[key];
  if (value === null && (rule.nullable || key === 'startCommand')) return null;
  switch (rule.type) {
    case 'bool':
      if (typeof value !== 'boolean') return errors.push(`${key} must be true or false`), undefined;
      return value;
    case 'int':
    case 'number': {
      const n = typeof value === 'number' ? value : NaN;
      if (!Number.isFinite(n) || (rule.type === 'int' && !Number.isInteger(n)) || n < rule.min || n > rule.max) return errors.push(`${key} must be a ${rule.type === 'int' ? 'whole ' : ''}number from ${rule.min} to ${rule.max}`), undefined;
      return n;
    }
    default: {
      if (typeof value !== 'string' && typeof value !== 'number') return errors.push(`${key} must be text`), undefined;
      const s = String(value);
      if (s.length > rule.max) return errors.push(`${key} is longer than ${rule.max} characters`), undefined;
      if (rule.pattern && s && !rule.pattern.test(s)) return errors.push(`${key} is not valid`), undefined;
      if (key === 'name' && !s.trim()) return errors.push('name cannot be empty'), undefined;
      return s;
    }
  }
}

function checkVars(template, vars, errors) {
  const out = {};
  if (vars === undefined || vars === null) return out;
  if (typeof vars !== 'object' || Array.isArray(vars)) return errors.push('vars must be a map of NAME: value'), out;
  const defs = new Map((template.variables || []).map((v) => [v.name, v]));
  for (const [name, raw] of Object.entries(vars)) {
    const def = defs.get(name);
    if (!def) {
      errors.push(`${name} is not a setting of ${template.name}`);
      continue;
    }
    if (isSecretVar(template, name, raw)) {
      errors.push(`${name} is a secret: set it in the panel, not in the file`);
      continue;
    }
    if (raw !== null && typeof raw === 'object') {
      errors.push(`${name} must be a single value`);
      continue;
    }
    let value = raw === null ? '' : raw;
    if (def.type === 'number') {
      const n = Number(value);
      if (value === '' || !Number.isFinite(n)) {
        errors.push(`${name} must be a number`);
        continue;
      }
      value = n;
    } else value = typeof value === 'boolean' ? String(value) : String(value);
    if (def.options?.length && !def.allowCustom) {
      const allowed = def.options.map((o) => String(typeof o === 'object' ? o.value : o));
      if (!allowed.includes(String(value))) {
        errors.push(`${name} must be one of: ${allowed.join(', ')}`);
        continue;
      }
    }
    if (String(value).length > 4000) {
      errors.push(`${name} is too long`);
      continue;
    }
    out[name] = value;
  }
  return out;
}

function checkPorts(template, ports, errors) {
  const out = {};
  if (ports === undefined || ports === null) return out;
  if (typeof ports !== 'object' || Array.isArray(ports)) return errors.push('ports must be a map of name: number'), out;
  const known = new Set((template.ports || []).map((p) => p.name));
  for (const [name, value] of Object.entries(ports)) {
    // The panel adds a few of its own (Geyser's "bedrock", the live map): allowed to be moved once they exist.
    if (!known.has(name) && !['bedrock', 'map'].includes(name)) {
      errors.push(`${name} is not a port of ${template.name} (${[...known].join(', ') || 'none'})`);
      continue;
    }
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      errors.push(`port ${name} must be a number from 1 to 65535`);
      continue;
    }
    out[name] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ plan -- */

const norm = (s) => String(s ?? '').trim().toLowerCase();
const same = (a, b) => (a === null || a === undefined || a === '' ? b === null || b === undefined || b === '' : String(a) === String(b));

/**
 * Compare the file with the servers that exist. Pure with respect to the
 * manager (it only reads): returns what apply() would do.
 */
function computePlan(manager, text, opts = {}) {
  const parsed = parseDocument(text);
  const wanted = parsed.servers;
  const prune = opts.prune === undefined ? parsed.prune : Boolean(opts.prune);
  const actions = [];
  const matched = new Set();
  const claimedPorts = new Map(); // port -> label, within this file
  const usedByOthers = (exceptId) => manager.usedPorts(exceptId);

  wanted.forEach((entry, index) => {
    const label = entry && typeof entry === 'object' && entry.name ? String(entry.name) : `server #${index + 1}`;
    const errors = [];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      actions.push({ action: 'error', name: label, errors: ['each server must be a map'] });
      return;
    }
    for (const key of Object.keys(entry)) if (!KNOWN.has(key)) errors.push(`unknown field "${key}"`);

    const byId = entry.id ? manager.servers.find((s) => s.id === String(entry.id)) : null;
    const byName = entry.name ? manager.servers.find((s) => norm(s.name) === norm(entry.name) && !matched.has(s.id)) : null;
    const existing = byId || byName || null;
    if (existing && matched.has(existing.id)) errors.push('this server is listed twice');
    if (existing) matched.add(existing.id);

    const templateId = entry.template !== undefined ? String(entry.template) : existing?.templateId;
    const template = templateId ? manager.templates.get(templateId) : null;
    if (!templateId) errors.push('template is required for a new server');
    else if (!template) errors.push(`unknown template "${templateId}"`);
    else if (existing && templateId !== existing.templateId) errors.push(`template cannot change from ${existing.templateId} to ${templateId}: create a new server instead`);
    if (!existing && !entry.name) errors.push('name is required for a new server');

    const patch = {};
    for (const key of Object.keys(SCALARS)) {
      if (entry[key] === undefined) continue;
      const v = checkScalar(key, entry[key], errors);
      if (v !== undefined) patch[key] = v;
    }
    let vars = {};
    let ports = {};
    if (template) {
      vars = checkVars(template, entry.vars, errors);
      ports = checkPorts(template, entry.ports, errors);
      const taken = usedByOthers(existing?.id || null);
      for (const [name, port] of Object.entries(ports)) {
        if (existing && existing.ports?.[name] === port) continue;
        if (taken.has(port)) errors.push(`port ${port} is already used by another server`);
        else if (claimedPorts.has(port)) errors.push(`port ${port} is also asked for by ${claimedPorts.get(port)}`);
      }
      for (const port of Object.values(ports)) claimedPorts.set(port, label);
    }

    if (errors.length) {
      actions.push({ action: 'error', name: label, id: existing?.id || null, errors });
      return;
    }

    if (!existing) {
      actions.push({ action: 'create', name: patch.name || label, template: templateId, input: { ...patch, templateId, ports, vars }, changes: [] });
      return;
    }
    const changes = [];
    for (const [key, to] of Object.entries(patch)) if (!same(existing[key], to)) changes.push({ field: key, from: existing[key] ?? null, to });
    for (const [name, to] of Object.entries(vars)) {
      const from = existing.vars?.[name];
      if (!same(from, to)) changes.push({ field: `vars.${name}`, from: from ?? null, to });
    }
    for (const [name, to] of Object.entries(ports)) if (!same(existing.ports?.[name], to)) changes.push({ field: `ports.${name}`, from: existing.ports?.[name] ?? null, to });
    actions.push({ action: changes.length ? 'update' : 'unchanged', name: existing.name, id: existing.id, changes, input: { ...patch, vars, ports } });
  });

  if (prune) {
    for (const s of manager.servers) if (!matched.has(s.id)) actions.push({ action: 'delete', name: s.name, id: s.id, changes: [] });
  }
  const counts = { create: 0, update: 0, unchanged: 0, delete: 0, error: 0 };
  for (const a of actions) counts[a.action]++;
  return { prune, actions, counts, ok: counts.error === 0 };
}

/** The plan without the apply-only input, for sending to the browser. */
function publicPlan(plan) {
  return { ...plan, actions: plan.actions.map(({ input, ...rest }) => rest) };
}

/* ----------------------------------------------------------------- apply -- */

async function apply(manager, text, actor, { confirmPrune = false, prune, install = (id) => manager.install(id) } = {}) {
  const plan = computePlan(manager, text, { prune });
  if (!plan.ok) fail(400, `Nothing was changed. Fix ${plan.counts.error} problem${plan.counts.error === 1 ? '' : 's'} first: ${plan.actions.filter((a) => a.action === 'error').map((a) => `${a.name}: ${a.errors.join('; ')}`).join(' | ')}`);
  if (plan.counts.delete && !confirmPrune) fail(400, `This would remove ${plan.counts.delete} server${plan.counts.delete === 1 ? '' : 's'} (prune: true). Confirm the removal to continue.`);
  const username = actor?.username || 'panel';
  const done = [];
  const restart = [];
  for (const a of plan.actions) {
    try {
      if (a.action === 'create') {
        const createInput = {};
        const later = {};
        for (const [k, v] of Object.entries(a.input)) (CREATE_FIELDS.has(k) || ['templateId', 'ports', 'vars'].includes(k) ? createInput : later)[k] = v;
        const server = manager.create(createInput, actor);
        if (Object.keys(later).length) manager.update(server.id, later, { trusted: true, actor: username, source: 'infra-as-code' });
        // Installs take minutes: start it and let the console stream.
        Promise.resolve(install(server.id)).catch((err) => logger.error('Install error:', err.message));
        done.push({ action: 'create', name: server.name, id: server.id });
      } else if (a.action === 'update') {
        manager.update(a.id, a.input, { trusted: true, actor: username, source: 'infra-as-code' });
        if (a.changes.some((c) => /^(vars|ports)\.|^memory$|^startCommand$/.test(c.field)) && manager.isActive(a.id)) restart.push(a.name);
        done.push({ action: 'update', name: a.name, id: a.id });
      } else if (a.action === 'delete') {
        // The folder stays on disk: a typo in a file must not cost anyone a world.
        await manager.remove(a.id, false);
        done.push({ action: 'delete', name: a.name, id: a.id });
      }
    } catch (err) {
      done.push({ action: a.action, name: a.name, id: a.id || null, error: err.message });
      logger.warn(`Servers file: ${a.action} ${a.name} failed: ${err.message}`);
      break; // later changes may depend on this one; stop and say where
    }
  }
  manager.store.addEvent('infra.applied', `${username} applied a servers file: ${plan.counts.create} created, ${plan.counts.update} updated${plan.counts.delete ? `, ${plan.counts.delete} removed` : ''}`);
  return { applied: done, restartNeeded: restart, counts: plan.counts, stoppedEarly: done.some((d) => d.error) };
}

module.exports = { exportServers, exportYaml, parseDocument, computePlan, publicPlan, apply, isSecretVar };
