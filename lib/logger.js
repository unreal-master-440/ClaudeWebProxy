'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SECRET_KEYS = /^(cookie|set-cookie|authorization|sessionkey|session_key|csrftoken|csrf|x-csrf-token|activitysessionid|anthropic-device-id)$/i;

let currentLevel = LEVELS.info;

function setLevel(name) {
  currentLevel = LEVELS[String(name || 'info').toLowerCase()] ?? LEVELS.info;
}

function redact(value, depth = 0) {
  if (depth > 4) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (/^sk-ant-/.test(value)) return 'sk-ant-***';
    if (value.length > 400) return value.slice(0, 400) + '…';
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '***' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return '[unserializable]'; }
}

function line(level, msg, extra) {
  if (LEVELS[level] < currentLevel) return;
  const tail = extra === undefined ? '' : ' ' + safeStringify(redact(extra));
  process.stderr.write(`[${level.toUpperCase()}] ${msg}${tail}\n`);
}

module.exports = {
  setLevel,
  redact,
  debug: (m, e) => line('debug', m, e),
  info: (m, e) => line('info', m, e),
  warn: (m, e) => line('warn', m, e),
  error: (m, e) => line('error', m, e),
};
