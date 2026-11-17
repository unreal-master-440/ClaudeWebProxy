'use strict';
const fs = require('fs');
const path = require('path');

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function loadEnv(rootDir) {
  const file = path.join(rootDir, '.env');
  let fileVars = {};
  try {
    fileVars = parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const merged = { ...fileVars };
  for (const [k, v] of Object.entries(process.env)) {
    if (merged[k] === undefined) merged[k] = v;
  }
  // Прокси должен быть виден и коду, который читает process.env напрямую
  // (lib/claude.js, https.request). Пустая строка в .env не должна затирать
  // значение, уже заданное в окружении системы.
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    const value = merged[key];
    if (value && !process.env[key]) process.env[key] = value;
  }
  return merged;
}

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

module.exports = { parseEnv, loadEnv, bool, num };
