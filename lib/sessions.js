'use strict';

/**
 * Сессии только в памяти. Запись:
 * { clientSessionId, conversationId, lastMessageId, model, createdAt, updatedAt }
 * Ничего не пишется на диск. TTL сбрасывается при каждом обращении.
 */
class SessionStore {
  constructor({ ttlMs = 30 * 60 * 1000, maxSessions = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.map = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(ttlMs, 60000));
    if (this.timer.unref) this.timer.unref();
  }

  sweep() {
    const now = Date.now();
    for (const [key, s] of this.map) {
      if (now - s.updatedAt > this.ttlMs) this.map.delete(key);
    }
  }

  get(clientSessionId) {
    const s = this.map.get(clientSessionId);
    if (!s) return null;
    if (Date.now() - s.updatedAt > this.ttlMs) {
      this.map.delete(clientSessionId);
      return null;
    }
    return s;
  }

  touch(clientSessionId, patch) {
    const now = Date.now();
    let s = this.map.get(clientSessionId);
    if (!s) {
      if (this.map.size >= this.maxSessions) {
        const oldest = [...this.map.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
        if (oldest) this.map.delete(oldest[0]);
      }
      s = {
        clientSessionId,
        conversationId: null,
        lastMessageId: null,
        model: null,
        createdAt: now,
        updatedAt: now,
      };
      this.map.set(clientSessionId, s);
    }
    Object.assign(s, patch || {}, { updatedAt: now });
    return s;
  }

  close() { clearInterval(this.timer); }
}

module.exports = { SessionStore };
