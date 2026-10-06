'use strict';

/**
 * What a non-administrator may change on a server.
 *
 * Server names and template variables are substituted into the start command
 * (run by a shell on the host), install scripts and config files. An
 * administrator can write those anyway, but a sub-user with the "settings"
 * permission must not be able to smuggle a second command in through them.
 */

const { fail } = require('../core/util');

// Characters that can end a shell word, start a new command or expand
// something, in bash and in cmd.exe.
const UNSAFE = /[`$\\"<>;&|%\r\n\x00-\x1f\x7f]/;
const UNSAFE_LIST = '` $ \\ " < > ; & | % or line breaks';

// Variables that hold a script, a command or a path to run are code, not settings.
const CODE_NAME = /(SCRIPT|COMMAND|CMD|BINARY|EXEC|ARGS|PATH|_DIR)$/;

/** True when {{NAME}} is where a shell expects a command, e.g. "{{LAUNCH}} -port 1". */
function inCommandPosition(template, name) {
  const at = new RegExp(`(^|[;&|(\\n]|\\bexec)\\s*["']?\\{\\{\\s*${name}\\s*\\}\\}`);
  const texts = [template.startCommand, ...(template.install || []).flatMap((s) => [s.run, s.script, s.command])];
  return texts.some((t) => typeof t === 'string' && at.test(t));
}

function checkText(label, value, max = 256) {
  const text = String(value ?? '');
  if (text.length > max) fail(400, `${label} is too long`);
  if (UNSAFE.test(text)) fail(400, `${label} cannot contain ${UNSAFE_LIST}`);
  return text;
}

/**
 * Validate a PATCH from a non-administrator. Throws a 403/400 on anything
 * that is not plainly a setting; returns the patch otherwise. Values that
 * equal what the server already has are let through untouched, so a form
 * that sends every field back still saves.
 */
function checkPatch(template, patch = {}, server = {}) {
  const same = (a, b) => String(a ?? '') === String(b ?? '');
  if (patch.startCommand !== undefined && !same(patch.startCommand, server.startCommand)) fail(403, 'Only administrators can change the start command');
  if (patch.ip !== undefined && !same(patch.ip, server.ip)) fail(403, 'Only administrators can change the address a server listens on');
  if (patch.name !== undefined && !same(String(patch.name).trim(), server.name)) checkText('The server name', patch.name, 60);
  if (patch.vars !== undefined) {
    if (!patch.vars || typeof patch.vars !== 'object' || Array.isArray(patch.vars)) fail(400, 'vars must be an object');
    const defs = new Map((template?.variables || []).map((v) => [v.name, v]));
    for (const [name, value] of Object.entries(patch.vars)) {
      if (Object.prototype.hasOwnProperty.call(server.vars || {}, name) && same(value, server.vars[name])) continue;
      const def = defs.get(name);
      if (!def) fail(403, `${name} is not a setting of this game`);
      const label = def.label || name;
      if (CODE_NAME.test(name) || inCommandPosition(template, name)) fail(403, `Only administrators can change ${label}`);
      if (value !== null && typeof value === 'object') fail(400, `${label} must be text`);
      const text = checkText(label, value);
      if (def.type === 'number' && text.trim() !== '' && !Number.isFinite(Number(text))) fail(400, `${label} must be a number`);
      if (def.options?.length && !def.allowCustom && text !== '') {
        const allowed = def.options.map((o) => String(typeof o === 'object' ? o.value : o));
        if (!allowed.includes(text)) fail(400, `${label} must be one of: ${allowed.join(', ')}`);
      }
    }
  }
  return patch;
}

module.exports = { checkPatch, checkText, inCommandPosition, UNSAFE };
