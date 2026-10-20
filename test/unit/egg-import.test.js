'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { convert } = require('../../server/games/egg-import');
const { check } = require('../../server/games/template-builder');

const egg = {
  name: 'Minecraft Paper',
  author: 'someone@example.com',
  description: 'Paper',
  features: ['eula', 'java_version'],
  docker_images: { 'Java 21': 'ghcr.io/pterodactyl/yolks:java_21', 'Java 17': 'ghcr.io/pterodactyl/yolks:java_17' },
  startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} --port ${SERVER_PORT} --world {{WORLD}}',
  config: {
    files: JSON.stringify({
      'server.properties': { parser: 'properties', find: { 'server-ip': '0.0.0.0', 'server-port': '{{server.build.default.port}}', motd: '{{server.build.env.MOTD}}' } },
      'config.yml': { parser: 'yaml', find: { a: 'b' } },
    }),
    startup: JSON.stringify({ done: ')! For help, type ' }),
    stop: 'stop',
  },
  scripts: { installation: { container: 'ghcr.io/pterodactyl/installers:alpine', entrypoint: 'ash', script: 'cd /mnt/server\ncurl -o ${SERVER_JARFILE} https://example.com/${MC_VERSION}.jar\necho $PORT' } },
  variables: [
    { name: 'Jar', env_variable: 'SERVER_JARFILE', default_value: 'server.jar', rules: 'required|string' },
    { name: 'Version', env_variable: 'MC_VERSION', default_value: 'latest', rules: 'required|in:latest,1.20,1.21' },
    { name: 'Motd', env_variable: 'MOTD', default_value: 'hi', rules: 'string' },
    { name: 'World', env_variable: 'WORLD', default_value: 'world', rules: 'string' },
    { name: 'Port', env_variable: 'PORT', default_value: '1', rules: 'numeric' },
  ],
};

test('egg converts into a template the builder accepts', () => {
  const { template, notes, unsupported } = convert(egg);
  assert.equal(template.id, 'egg-minecraft-paper');
  assert.equal(template.imported, true);
  assert.equal(template.adminOnly, true);
  assert.equal(template.image, 'ghcr.io/pterodactyl/yolks:java_21');
  assert.equal(template.startCommand, 'java -Xms128M -Xmx{{MEMORY_MB}}M -jar {{SERVER_JARFILE}} --port {{PORT}} --world {{WORLD}}');
  assert.deepEqual(template.variables.find((v) => v.name === 'MC_VERSION').options, ['latest', '1.20', '1.21']);
  assert.ok(template.variables.some((v) => v.name === 'EGG_PORT'));
  assert.equal(template.patchProperties.length, 1);
  assert.equal(template.patchProperties[0].set['server-port'], '{{PORT}}');
  assert.equal(template.patchProperties[0].set.motd, '{{MOTD}}');
  assert.equal(template.stopCommand, 'stop');
  assert.ok(template.logPatterns.ready.includes('For help'));
  assert.ok(template.install[0].run.includes('"$GP_SERVER_DIR"'));
  assert.ok(template.install[0].run.includes('${EGG_PORT}'));
  assert.ok(unsupported.some((u) => /yaml/.test(u)));
  assert.ok(unsupported.some((u) => /eula/.test(u)));
  assert.ok(notes.some((n) => /Docker images/.test(n)));
  const checked = check(template, null);
  assert.deepEqual(checked.errors, []);
});

test('not an egg is refused', () => {
  assert.throws(() => convert({ foo: 1 }), /egg/);
});
