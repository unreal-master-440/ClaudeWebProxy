'use strict';
/**
 * Запускает Chromium-based браузер с ОТДЕЛЬНЫМ профилем browser-profile/,
 * открывает https://claude.ai, ждёт ручного входа, снимает cookies через CDP
 * (page target из http://127.0.0.1:<CDP_PORT>/json) и сохраняет claude-auth.json.
 *
 * Режимы:
 *   node scripts/claude_auth.js            — только авторизация
 *   node scripts/claude_auth.js --capture  — плюс запись Network-событий по путям,
 *                                            содержащим chat_conversations, в captures/*.json
 *                                            (cookie и Authorization НЕ пишутся)
 *
 * Таймаут 5 минут. Закрывается ТОЛЬКО собственный процесс браузера.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const { loadEnv, num } = require(path.join(ROOT, 'lib', 'env'));

const env = loadEnv(ROOT);
const CDP_PORT = num(env.CDP_PORT, 9222);
const TIMEOUT_MS = num(env.AUTH_TIMEOUT_MS, 5 * 60 * 1000);
const PROFILE_DIR = path.join(ROOT, 'browser-profile');
const AUTH_FILE = path.isAbsolute(env.AUTH_FILE || '')
  ? env.AUTH_FILE
  : path.join(ROOT, env.AUTH_FILE || 'claude-auth.json');
const CAPTURE_DIR = path.join(ROOT, 'captures');
const CAPTURE = process.argv.includes('--capture');

/** ---------------- поиск браузера ---------------- */

function candidates() {
  const list = [];
  const pf = process.env['ProgramFiles'] || 'C:/Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';

  if (process.platform === 'win32') {
    for (const base of [pf, pf86, local && path.join(local, 'Programs')]) {
      if (!base) continue;
      list.push(
        path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(base, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
    if (local) {
      list.push(
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      list.push(
        path.join(base, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        path.join(base, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
        path.join(base, 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'),
        path.join(base, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      );
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium',
      'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (dir) list.push(path.join(dir, name));
      }
    }
  }
  return list;
}

function findBrowser() {
  if (env.CHROME_PATH && fs.existsSync(env.CHROME_PATH)) return env.CHROME_PATH;
  const all = candidates();
  if (env.BROWSER) {
    const wanted = env.BROWSER.toLowerCase();
    for (const c of all) {
      if (path.basename(c).toLowerCase().includes(wanted)) return c;
    }
  }
  for (const c of all) if (fs.existsSync(c)) return c;
  return null;
}

/** ---------------- HTTP к CDP ---------------- */

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('CDP timeout')));
    req.on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForPageTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(port, '/json');
      const list = Array.isArray(targets) ? targets : [];
      const pages = list.filter((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
      const claude = pages.find((t) => (t.url || '').includes('claude.ai'));
      if (claude) return claude;
      if (pages.length) return pages[0];
    } catch { /* браузер ещё поднимается */ }
    await sleep(500);
  }
  throw new Error('CDP page target not found within timeout.');
}

/** ---------------- минимальный CDP-клиент (без npm) ---------------- */

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const Impl = globalThis.WebSocket;
    if (typeof Impl !== 'function') {
      return reject(new Error(
        'This Node has no global WebSocket. Use Node 22+ (or Node 21 with --experimental-websocket).'));
    }
    const ws = new Impl(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = [];

    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP timeout: ${method}`));
              }
            }, 15000);
          });
        },
        on(fn) { listeners.push(fn); },
        close() { try { ws.close(); } catch { /* ignore */ } },
      });
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || 'CDP error'));
        else res(msg.result);
        return;
      }
      for (const fn of listeners) fn(msg);
    });

    ws.addEventListener('error', () => reject(new Error('CDP WebSocket error')));
  });
}

/** ---------------- main ---------------- */

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('[ERROR] Chromium-based browser not found. Set CHROME_PATH or BROWSER in .env');
    process.exit(1);
  }
  console.log(`[INFO] Browser: ${browser}`);
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://claude.ai',
  ];

  let child;
  try {
    child = spawn(browser, args, { stdio: 'ignore' });
  } catch (e) {
    console.error(`[ERROR] Cannot start browser: ${e.message}`);
    process.exit(1);
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let exitCode = 0;
  let cdp = null;

  try {
    console.log('[INFO] Waiting for CDP page target…');
    const page = await waitForPageTarget(CDP_PORT, deadline);
    console.log(`[INFO] Page target: ${page.url || '(blank)'}`);

    cdp = await cdpConnect(page.webSocketDebuggerUrl);

    let captureSink = null;
    if (CAPTURE) {
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
      const file = path.join(CAPTURE_DIR,
        `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      captureSink = { file, records: [] };
      const interesting = (url) => /chat_conversations/.test(url || '');

      await cdp.send('Network.enable');
      cdp.on((msg) => {
        const { method, params } = msg || {};
        if (method === 'Network.requestWillBeSent' && interesting(params.request.url)) {
          const headers = {};
          for (const [k, v] of Object.entries(params.request.headers || {})) {
            if (/cookie|authorization/i.test(k)) continue; // секреты не пишем
            headers[k] = v;
          }
          captureSink.records.push({
            at: new Date().toISOString(),
            kind: 'request',
            requestId: params.requestId,
            method: params.request.method,
            url: params.request.url,
            headers,
            postData: params.request.postData
              ? String(params.request.postData).slice(0, 20000)
              : null,
          });
        }
        if (method === 'Network.responseReceived' && interesting(params.response.url)) {
          const h = params.response.headers || {};
          captureSink.records.push({
            at: new Date().toISOString(),
            kind: 'response',
            requestId: params.requestId,
            status: params.response.status,
            contentType: h['content-type'] || h['Content-Type'] || null,
            url: params.response.url,
          });
        }
      });
      console.log(`[INFO] Capture mode ON → ${path.relative(ROOT, file)}`);
      console.log('       Отправьте одно сообщение в чате claude.ai, затем нажмите Ctrl+C.');
    } else {
      console.log('');
      console.log('  Войдите в аккаунт Claude в открытом окне браузера.');
      console.log('  Когда чат claude.ai загрузится — сессия сохранится автоматически.');
      console.log('');
    }

    let saved = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      let cookies;
      try {
        cookies = await cdp.send('Network.getCookies', { urls: ['https://claude.ai'] });
      } catch { continue; }

      const jar = {};
      for (const c of (cookies && cookies.cookies) || []) jar[c.name] = c.value;
      if (!jar.sessionKey) continue;

      let organizationId = null;
      try {
        const evalRes = await cdp.send('Runtime.evaluate', {
          expression: "fetch('/api/organizations').then(r=>r.json()).then(d=>JSON.stringify(d)).catch(()=>'null')",
          awaitPromise: true,
          returnByValue: true,
        });
        const raw = evalRes && evalRes.result && evalRes.result.value;
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed) && parsed[0] && parsed[0].uuid) organizationId = parsed[0].uuid;
      } catch { /* org можно получить позже из lastActiveOrg */ }

      const auth = {
        sessionKey: jar.sessionKey,
        lastActiveOrg: jar.lastActiveOrg || null,
        organizationId,
        cookies: {
          sessionKey: jar.sessionKey,
          ...(jar.lastActiveOrg ? { lastActiveOrg: jar.lastActiveOrg } : {}),
          ...(jar['anthropic-device-id'] ? { 'anthropic-device-id': jar['anthropic-device-id'] } : {}),
          ...(jar.activitySessionId ? { activitySessionId: jar.activitySessionId } : {}),
        },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        models: {
          'claude-sonnet': 'claude-sonnet-5-5',
          'claude-haiku': 'claude-haiku-5-5',
        },
        defaultModel: 'claude-sonnet',
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
      console.log(`[INFO] Session saved to ${path.basename(AUTH_FILE)} (не коммитьте этот файл!)`);
      saved = true;
      break;
    }

    if (CAPTURE && captureSink) {
      const capDeadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < capDeadline) await sleep(1000);
      fs.writeFileSync(captureSink.file, JSON.stringify(captureSink.records, null, 2));
      console.log(`[INFO] Capture written: ${path.relative(ROOT, captureSink.file)}`);
    }

    if (!saved && !CAPTURE) {
      console.error('[ERROR] Authentication not completed within timeout. No session saved.');
      exitCode = 1;
    }
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child && !child.killed) {
      console.log('[INFO] Closing browser (own process only).');
      try { child.kill(); } catch { /* ignore */ }
    }
    setTimeout(() => process.exit(exitCode), 500);
  }
}

if (require.main === module) main();

module.exports = { findBrowser, candidates, waitForPageTarget, cdpConnect };
