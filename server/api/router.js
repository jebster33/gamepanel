'use strict';

/** A tiny pattern router: "/api/servers/:id/files" style paths, nothing more. */

const { HttpError } = require('../core/util');

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, ...options });
  }

  get(p, h, o) {
    this.add('GET', p, h, o);
  }

  post(p, h, o) {
    this.add('POST', p, h, o);
  }

  patch(p, h, o) {
    this.add('PATCH', p, h, o);
  }

  put(p, h, o) {
    this.add('PUT', p, h, o);
  }

  delete(p, h, o) {
    this.add('DELETE', p, h, o);
  }

  match(method, pathname) {
    const segs = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const part = route.parts[i];
        if (part.startsWith(':')) params[part.slice(1)] = decodeSegment(segs[i]);
        else if (part !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

/** A "%zz" in a path is the caller's mistake, not a server error. */
function decodeSegment(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new HttpError(400, 'Malformed URL');
  }
}

module.exports = { Router };
