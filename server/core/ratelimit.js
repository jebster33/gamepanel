'use strict';

/**
 * A small fixed-window rate limiter: at most `limit` hits per key per
 * window. Keeps a scraper or a stuck script from hammering the panel; normal
 * use (the dashboard polls a few times a minute) never gets near it.
 */
class RateLimiter {
  constructor({ limit, windowMs = 60_000, maxKeys = 10_000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map(); // key -> { start, count }
  }

  /** True if this hit is allowed. */
  take(key, now = Date.now()) {
    let entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (!entry && this.hits.size >= this.maxKeys) this.sweep(now);
      entry = { start: now, count: 0 };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  retryAfter(key, now = Date.now()) {
    const entry = this.hits.get(key);
    return entry ? Math.max(1, Math.ceil((entry.start + this.windowMs - now) / 1000)) : 1;
  }

  sweep(now) {
    for (const [key, entry] of this.hits) if (now - entry.start >= this.windowMs) this.hits.delete(key);
    // Still full: drop the oldest rather than grow without bound.
    while (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value);
  }
}

module.exports = { RateLimiter };
