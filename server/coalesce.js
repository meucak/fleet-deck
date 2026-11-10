'use strict';

class CoalescingCache {
  constructor(defaultTtlMs = 8000) {
    this.defaultTtlMs = defaultTtlMs;
    this.entries = new Map();
    this.inFlight = new Map();
  }

  async getOrFetch(key, fetcher, options = {}) {
    const ttlMs = options.ttlMs !== undefined ? options.ttlMs : this.defaultTtlMs;
    const force = Boolean(options.force);

    // Always coalesce onto an active in-flight promise first, even if force=true,
    // so concurrent refresh storms never spawn duplicate SSH or socket requests.
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    if (!force && this.entries.has(key)) {
      const entry = this.entries.get(key);
      if (Date.now() - entry.updatedAt < ttlMs) {
        return entry.value;
      }
    }

    const promise = (async () => {
      try {
        const value = await fetcher();
        this.entries.set(key, {
          value,
          updatedAt: Date.now()
        });
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  invalidate(key) {
    if (key === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(key);
  }

  getStats() {
    return {
      keys: Array.from(this.entries.keys()),
      inFlightKeys: Array.from(this.inFlight.keys()),
      size: this.entries.size
    };
  }
}

module.exports = { CoalescingCache };
