'use strict';

/**
 * Metrics for Prometheus (and Grafana on top of it). Off until an
 * administrator creates a scrape token; the endpoint answers only to
 * `Authorization: Bearer <token>`. The panel keeps just a hash of the token.
 *
 * settings.prometheus = { enabled, hash, createdAt }
 */

const crypto = require('crypto');

const hashOf = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const settingsOf = (store) => (store.state.settings.prometheus ||= { enabled: false, hash: '', createdAt: 0 });

function enable(store) {
  const s = settingsOf(store);
  const token = crypto.randomBytes(24).toString('base64url');
  Object.assign(s, { enabled: true, hash: hashOf(token), createdAt: Date.now() });
  store.save();
  return token;
}

function disable(store) {
  Object.assign(settingsOf(store), { enabled: false, hash: '' });
  store.save();
}

const view = (store) => {
  const s = settingsOf(store);
  return { enabled: s.enabled, createdAt: s.createdAt };
};

function authorized(store, header) {
  const s = settingsOf(store);
  const token = String(header || '').replace(/^Bearer\s+/i, '');
  if (!s.enabled || !s.hash || !token) return false;
  const a = Buffer.from(hashOf(token));
  const b = Buffer.from(s.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const label = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

function render({ manager, hostMetrics, version }) {
  const out = [];
  const seen = new Set();
  const metric = (name, help, type, value, labels = {}) => {
    if (value == null || !Number.isFinite(Number(value))) return;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    }
    const l = Object.entries(labels).map(([k, v]) => `${k}="${label(v)}"`).join(',');
    out.push(`${name}${l ? `{${l}}` : ''} ${Number(value)}`);
  };
  const h = hostMetrics.last || {};
  metric('gamepanel_info', 'Panel version', 'gauge', 1, { version });
  metric('gamepanel_host_cpu_percent', 'Host CPU use, 0-100', 'gauge', h.cpu?.percent);
  metric('gamepanel_host_cpu_cores', 'Host CPU cores', 'gauge', h.cpu?.cores);
  metric('gamepanel_host_memory_total_bytes', 'Host memory', 'gauge', h.memory?.total);
  metric('gamepanel_host_memory_used_bytes', 'Host memory in use', 'gauge', h.memory?.used);
  metric('gamepanel_host_swap_used_bytes', 'Host swap in use', 'gauge', h.swap?.used);
  metric('gamepanel_host_disk_total_bytes', 'Disk size', 'gauge', h.disk?.total);
  metric('gamepanel_host_disk_free_bytes', 'Disk free', 'gauge', h.disk?.free);
  metric('gamepanel_host_load1', 'Load average (1 minute)', 'gauge', h.load?.[0]);
  metric('gamepanel_host_uptime_seconds', 'Host uptime', 'gauge', h.uptime);
  metric('gamepanel_host_network_receive_bytes_per_second', 'Host network in', 'gauge', h.network?.rxBytesPerSec);
  metric('gamepanel_host_network_transmit_bytes_per_second', 'Host network out', 'gauge', h.network?.txBytesPerSec);
  for (const server of manager.servers) {
    const p = manager.publicServer(server);
    const l = { server: server.name, id: server.id, game: p.templateName };
    metric('gamepanel_server_up', '1 when the server is running', 'gauge', p.status === 'running' ? 1 : 0, l);
    metric('gamepanel_server_cpu_percent', 'Server CPU, 100 = one core', 'gauge', p.cpu, l);
    metric('gamepanel_server_memory_bytes', 'Server memory in use', 'gauge', p.memory, l);
    metric('gamepanel_server_memory_limit_bytes', 'Server memory limit', 'gauge', p.memoryLimit, l);
    metric('gamepanel_server_players', 'Players online', 'gauge', p.status === 'running' ? p.players ?? p.playerList.length : 0, l);
    metric('gamepanel_server_players_max', 'Player slots', 'gauge', p.maxPlayers, l);
    metric('gamepanel_server_tps', 'Ticks per second (Minecraft Paper/Purpur)', 'gauge', p.tps, l);
    metric('gamepanel_server_ping_ms', 'Query ping', 'gauge', p.ping, l);
    metric('gamepanel_server_disk_bytes', 'Server folder size', 'gauge', p.diskBytes, l);
    metric('gamepanel_server_uptime_seconds', 'Time since the server started', 'gauge', p.uptime / 1000, l);
    metric('gamepanel_server_crashes_total', 'Crashes since the server was created', 'counter', p.crashCount || 0, l);
    metric('gamepanel_server_network_receive_bytes_per_second', 'Container network in', 'gauge', p.runtime === 'docker' ? p.networkRx : null, l);
    metric('gamepanel_server_network_transmit_bytes_per_second', 'Container network out', 'gauge', p.runtime === 'docker' ? p.networkTx : null, l);
  }
  return out.join('\n') + '\n';
}

/** A Grafana dashboard for the metrics above (Dashboards → Import). */
function grafanaDashboard() {
  const target = (expr, legend) => ({ expr, legendFormat: legend, refId: 'A' });
  const panel = (id, title, expr, legend, x, y, unit = 'short', w = 12) => ({
    id,
    type: 'timeseries',
    title,
    datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' },
    gridPos: { h: 8, w, x, y },
    fieldConfig: { defaults: { unit }, overrides: [] },
    targets: [target(expr, legend)],
  });
  return {
    title: 'GamePanel',
    uid: 'gamepanel-overview',
    schemaVersion: 39,
    version: 1,
    refresh: '30s',
    time: { from: 'now-6h', to: 'now' },
    tags: ['gamepanel'],
    __inputs: [{ name: 'DS_PROMETHEUS', label: 'Prometheus', type: 'datasource', pluginId: 'prometheus' }],
    panels: [
      panel(1, 'Players online', 'gamepanel_server_players', '{{server}}', 0, 0),
      panel(2, 'Servers up', 'gamepanel_server_up', '{{server}}', 12, 0),
      panel(3, 'Server CPU (100 = one core)', 'gamepanel_server_cpu_percent', '{{server}}', 0, 8, 'percent'),
      panel(4, 'Server memory', 'gamepanel_server_memory_bytes', '{{server}}', 12, 8, 'bytes'),
      panel(5, 'TPS', 'gamepanel_server_tps', '{{server}}', 0, 16),
      panel(6, 'Server disk', 'gamepanel_server_disk_bytes', '{{server}}', 12, 16, 'bytes'),
      panel(7, 'Host CPU', 'gamepanel_host_cpu_percent', 'cpu', 0, 24, 'percent'),
      panel(8, 'Host memory used', 'gamepanel_host_memory_used_bytes', 'used', 12, 24, 'bytes'),
      panel(9, 'Host disk free', 'gamepanel_host_disk_free_bytes', 'free', 0, 32, 'bytes'),
      panel(10, 'Crashes', 'increase(gamepanel_server_crashes_total[1h])', '{{server}}', 12, 32),
    ],
  };
}

function prometheusConfig(origin) {
  const u = new URL(origin);
  return `scrape_configs:\n  - job_name: gamepanel\n    scrape_interval: 30s\n    metrics_path: /api/public/metrics\n    scheme: ${u.protocol.replace(':', '')}\n    authorization:\n      type: Bearer\n      credentials: YOUR_TOKEN\n    static_configs:\n      - targets: ['${u.host}']\n`;
}

module.exports = { enable, disable, view, authorized, render, grafanaDashboard, prometheusConfig };
