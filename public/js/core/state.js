/* ----------------------------------------------------------------- state */

export const state = {
  user: null,
  servers: [],
  templates: [],
  categories: [],
  host: null,
  overview: null,
  route: { name: 'dashboard', params: {} },
  consoles: new Map(),
  hostHistory: { cpu: [], mem: [], net: [] },
  serverHistory: new Map(),
  ws: null,
  wsSubs: new Set(),
  consoleSeq: new Map(),
};
