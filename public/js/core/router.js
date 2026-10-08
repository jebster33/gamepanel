import { wsUnsubscribe } from './live.js';
import { state } from './state.js';
import { $, $$ } from './util.js';
import { renderAccount } from '../pages/account.js';
import { renderActivity } from '../pages/activity.js';
import { renderConnections } from '../pages/connections.js';
import { renderDashboard } from '../pages/dashboard.js';
import { renderNodes } from '../pages/nodes.js';
import { renderServerDetail } from '../pages/server/detail.js';
import { renderServers } from '../pages/servers.js';
import { renderSettings } from '../pages/settings.js';
import { renderTemplates } from '../pages/templates.js';
import { renderTemplateBuilder } from '../pages/template-builder.js';
import { renderAudit } from '../pages/audit.js';
import { renderBans } from '../pages/bans.js';
import { renderNetworks } from '../pages/networks.js';
import { renderUsers } from '../pages/users.js';
import { closeSidebar, renderSidebarServers } from '../ui/sidebar.js';
import { reducedMotion } from '../ui/fx.js';
import { skeleton } from '../ui/skeleton.js';

/* ---------------------------------------------------------------- router */

/**
 * One row per page: the hash it answers to, the names of its captured
 * parts, and the function that draws it into #view.
 */
const ROUTES = [
  { pattern: /^\/?(dashboard)?$/, name: 'dashboard', page: renderDashboard },
  { pattern: /^\/servers$/, name: 'servers', page: renderServers },
  { pattern: /^\/servers\/([^/]+)(?:\/([^/]+))?$/, name: 'server', keys: ['id', 'tab'], page: renderServerDetail },
  { pattern: /^\/(?:templates|deploy)$/, name: 'templates', page: renderTemplates },
  { pattern: /^\/templates\/(new|edit)(?:\/([^/]+))?$/, name: 'template-builder', keys: ['mode', 'id'], page: renderTemplateBuilder },
  { pattern: /^\/activity$/, name: 'activity', page: renderActivity },
  { pattern: /^\/audit$/, name: 'audit', page: renderAudit },
  { pattern: /^\/bans$/, name: 'bans', page: renderBans },
  { pattern: /^\/networks$/, name: 'networks', page: renderNetworks },
  { pattern: /^\/nodes$/, name: 'nodes', page: renderNodes },
  { pattern: /^\/account$/, name: 'account', page: renderAccount },
  { pattern: /^\/users$/, name: 'users', page: renderUsers },
  { pattern: /^\/connections$/, name: 'connections', page: renderConnections },
  { pattern: /^\/settings(?:\/([^/]+))?$/, name: 'settings', keys: ['section'], page: renderSettings },
];

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/dashboard';
  for (const route of ROUTES) {
    const match = hash.match(route.pattern);
    if (match) {
      const params = {};
      (route.keys || []).forEach((key, i) => {
        if (match[i + 1]) params[key] = decodeURIComponent(match[i + 1]);
      });
      return { name: route.name, params };
    }
  }
  return { name: 'dashboard', params: {} };
}

export function handleRoute() {
  // Signed out: the sign-in screen is showing, and pages need an account to draw.
  if (!state.user) return;
  const previous = state.route;
  state.route = parseRoute();

  if (previous.name === 'server' && previous.params.id !== state.route.params.id) {
    wsUnsubscribe(`console:${previous.params.id}`);
  }

  // A nav link is active when its page is the one showing ("Servers" stays lit on a server's page).
  $$('.nav-item').forEach((el) => {
    const page = el.dataset.page;
    el.classList.toggle('active', page === state.route.name || (page === 'servers' && state.route.name === 'server') || (page === 'templates' && state.route.name === 'template-builder'));
  });

  closeSidebar();
  renderSidebarServers();
  render();

  // A new page fades in; on the same server only the new tab's content does.
  if (reducedMotion) return;
  const sameServer = previous.name === 'server' && state.route.name === 'server' && previous.params.id === state.route.params.id;
  const target = sameServer ? $('#tab-content') : $('#view');
  target?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
}

/* ----------------------------------------------------------------- views */

export function render() {
  const view = $('#view');
  const route = ROUTES.find((r) => r.name === state.route.name);
  // Pages that fetch before drawing show the page's shape meanwhile, not the last page.
  if (route?.page.constructor.name === 'AsyncFunction') view.innerHTML = skeleton('page');
  if (route) route.page(view);
  else view.innerHTML = '<div class="empty"><h3>Page not found</h3></div>';
}

export function setCrumbs(html) {
  $('#crumbs').innerHTML = html;
}
