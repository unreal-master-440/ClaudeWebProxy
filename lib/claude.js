'use strict';
const https = require('https');
const http = require('http');
const tls = require('tls');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { ProxyError } = require('./errors');
const { createSseParser, assertNotProtocolChanged } = require('./stream');
const logger = require('./logger');

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * Транспорт claude.ai.
 *
 * ВАЖНО: всё, что помечено в PHASE 1 как LIKELY, живёт в DEFAULT_TOOLS,
 * DEFAULT_STYLE и buildPayload(). Если Anthropic поменяет поля, сервер ответит
 * 4xx → мы вернём честную ошибку (claude_error / protocol_changed),
 * а не выдуманный успешный ответ.
 */

const DEFAULT_TOOLS = [
  { name: 'web_search', type: 'web_search_v0' },
  { name: 'artifacts', type: 'artifacts_v0' },
  { name: 'repl', type: 'repl_v0' },
];

const DEFAULT_STYLE = {
  isDefault: true, key: 'Default', name: 'Normal',
  nameKey: 'normal_style_name', prompt: 'Normal\n',
  summary: 'Default responses from Claude',
  summaryKey: 'normal_style_summary', type: 'default',
};

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function loadAuth(authFile) {
  let raw;
  try {
    raw = fs.readFileSync(authFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new ProxyError('auth_error',
        `Auth file not found: ${path.basename(authFile)}. Run: node scripts/claude_auth.js`);
    }
    throw new ProxyError('auth_error', 'claude-auth.json is unreadable.');
  }
  let auth;
  try { auth = JSON.parse(raw); } catch {
    throw new ProxyError('auth_error', 'claude-auth.json is not valid JSON.');
  }
  const hasKey = auth.sessionKey || (auth.cookies && auth.cookies.sessionKey);
  if (!hasKey) {
    throw new ProxyError('auth_error',
      'claude-auth.json has no sessionKey. Run: node scripts/claude_auth.js');
  }
  return auth;
}

function cookieHeader(auth) {
  const merged = { ...(auth.cookies || {}) };
  if (auth.sessionKey) merged.sessionKey = auth.sessionKey;
  if (auth.lastActiveOrg && !merged.lastActiveOrg) merged.lastActiveOrg = auth.lastActiveOrg;
  return Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('; ');
}

function baseHeaders(auth, extra = {}) {
  if (auth && auth.browserSession) {
    // Внутри вкладки cookie и User-Agent подставляет сам браузер.
    return { ...extra };
  }
  return {
    'Accept-Language': 'en-US,en;q=0.9',
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-version': '1.0.0',
    Origin: 'https://claude.ai',
    Referer: 'https://claude.ai/new',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': auth.userAgent || DEFAULT_UA,
    Cookie: cookieHeader(auth),
    ...extra,
  };
}

function mapHttpError(status, text) {
  const snippet = String(text || '').slice(0, 400);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* не JSON */ }
  const errType = parsed && parsed.error && parsed.error.type;
  const errMsg = (parsed && parsed.error && parsed.error.message) || snippet;

  if (errType === 'permission_error' && /region/i.test(String(errMsg))) {
    return new ProxyError('auth_error',
      'claude.ai rejects this network region ("Claude isn\'t available in your region"). ' +
      'Claude Web is not reachable from the current IP; use a network exit in a supported country.');
  }
  if (status === 401) {
    return new ProxyError('auth_error', 'Claude session expired (401). Re-run: node scripts/claude_auth.js');
  }
  if (status === 403) {
    if (/invalid authorization|invalid session|not logged in/i.test(String(text || ''))) {
      return new ProxyError('auth_error',
        'Claude Web session is not authorized. Log in once in the browser window opened by ' +
        'scripts/claude_auth.js (USE_BROWSER_TRANSPORT=1), then retry.');
    }
    if (/<html/i.test(String(text || '')) || /just a moment|cf_chl|challenge-platform/i.test(String(text || ''))) {
      return new ProxyError('network_error',
        'Cloudflare is challenging this client (403 "Just a moment…"). Claude Web cannot be ' +
        'reached from Node directly. Start the proxy with USE_BROWSER_TRANSPORT=1 so requests ' +
        'go through the authenticated browser (lib/claude.js).');
    }
    return new ProxyError('auth_error',
      `claude.ai returned 403 (${errMsg}). Session invalid or region block.`);
  }
  if (status === 429) return new ProxyError('rate_limit', `Claude Web rate limit (429): ${errMsg}`);
  if (status >= 500) return new ProxyError('claude_error', `claude.ai error ${status}: ${errMsg}`);
  return new ProxyError('claude_error', `claude.ai rejected the request (${status}): ${errMsg}`);
}

/**
 * Прокси из окружения (HTTPS_PROXY / HTTP_PROXY / NO_PROXY).
 * Без него Node-клиент идёт напрямую мимо VPN, который настроен только как
 * системный прокси (так работает Hiddify/Clash в режиме System Proxy).
 */
function proxyFor(hostname) {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return null;
  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || '');
  for (const entry of noProxy.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (entry === '*' || hostname === entry || hostname.endsWith('.' + entry.replace(/^\./, ''))) {
      return null;
    }
  }
  try {
    const p = new URL(raw);
    return {
      host: p.hostname,
      port: Number(p.port) || (p.protocol === 'https:' ? 443 : 80),
      auth: p.username
        ? 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')
        : null,
    };
  } catch {
    return null;
  }
}

/** TLS-соединение к claude.ai через HTTP CONNECT-туннель прокси. */
function connectViaProxy(proxy, hostname, port, onSecure) {
  const connectReq = http.request({
    host: proxy.host,
    port: proxy.port,
    method: 'CONNECT',
    path: `${hostname}:${port}`,
    headers: {
      Host: `${hostname}:${port}`,
      ...(proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {}),
    },
  });
  connectReq.on('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      onSecure(new ProxyError('network_error',
        `Proxy refused CONNECT to ${hostname} (${res.statusCode}).`));
      return;
    }
    const tlsSocket = tls.connect({ socket, servername: hostname }, () => onSecure(tlsSocket));
    tlsSocket.on('error', (e) => {
      onSecure(new ProxyError('network_error', `TLS via proxy failed: ${e.message}`));
    });
  });
  connectReq.on('error', (e) => {
    onSecure(new ProxyError('network_error',
      `Cannot reach proxy ${proxy.host}:${proxy.port} (${e.code || e.message}).`));
  });
  connectReq.end();
}

function request({ baseUrl, method, urlPath, headers, body, timeoutMs, onChunk }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, baseUrl);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const port = Number(u.port) || 443;
    const proxy = proxyFor(u.hostname);

    const options = {
      protocol: u.protocol,
      hostname: u.hostname,
      port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
      },
    };

    const onResponse = (res) => {
      const status = res.statusCode || 0;
      const contentType = String(res.headers['content-type'] || '');

      if (status >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(mapHttpError(status, Buffer.concat(chunks).toString('utf8'))));
        return;
      }

      if (onChunk && contentType.includes('text/event-stream')) {
        res.setEncoding('utf8');
        res.on('data', (c) => onChunk(c));
        res.on('end', () => resolve({ status, headers: res.headers, streamed: true }));
        res.on('error', (e) => reject(new ProxyError('network_error', `Stream error: ${e.message}`)));
        return;
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
        resolve({ status, headers: res.headers, body: json, text, streamed: false });
      });
      res.on('error', (e) => reject(new ProxyError('network_error', `Response error: ${e.message}`)));
    };

    let req;
    if (proxy) {
      logger.debug('Using proxy for claude.ai', { proxy: `${proxy.host}:${proxy.port}` });
      connectViaProxy(proxy, u.hostname, port, (socket) => {
        if (socket instanceof ProxyError) return reject(socket);
        req = https.request({ ...options, createConnection: () => socket, agent: false }, onResponse);
        req.setTimeout(timeoutMs || 180000, () => {
          req.destroy(new ProxyError('timeout', 'Claude Web request timed out.'));
        });
        req.on('error', (e) => {
          if (e instanceof ProxyError) return reject(e);
          reject(new ProxyError('network_error', `Request via proxy failed: ${e.message}`));
        });
        if (payload) req.write(payload);
        req.end();
      });
      return;
    }

    req = https.request(options, onResponse);
    req.setTimeout(timeoutMs || 180000, () => {
      req.destroy(new ProxyError('timeout', 'Claude Web request timed out.'));
    });
    req.on('error', (e) => {
      if (e instanceof ProxyError) return reject(e);
      if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') {
        return reject(new ProxyError('network_error', `Cannot reach claude.ai (${e.code}).`));
      }
      return reject(new ProxyError('network_error', `Request failed: ${e.message}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Транспорт через авторизованный браузер (CDP).
 *
 * Нужен, когда Cloudflare отвечает Node-клиенту 403 "Just a moment…":
 * запросы выполняются внутри страницы claude.ai, у которой настоящий
 * браузерный TLS/JS-отпечаток и уже решённый челлендж.
 *
 * Требует браузер, запущенный scripts/claude_auth.js (он оставляет его
 * с --remote-debugging-port) либо любой Chrome с CDP на CDP_PORT.
 */
class BrowserTransport {
  constructor({ cdpPort, timeoutMs, profileDir, browserPath }) {
    this.cdpPort = cdpPort;
    this.timeoutMs = timeoutMs;
    this.profileDir = profileDir;
    this.browserPath = browserPath;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.lock = Promise.resolve();
    this.launched = null;
  }

  /** Уже запущен браузер с CDP на этом порту? */
  async isUp() {
    try {
      await this.getPageTarget();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Запускает свой браузер (отдельный профиль) и ждёт CDP.
   * Используется, когда сервер стартует в режиме USE_BROWSER_TRANSPORT=1:
   * пользователь один раз входит в аккаунт в этом окне.
   */
  async launch({ url = 'https://claude.ai' } = {}) {
    if (await this.isUp()) return { launched: false };
    if (!this.browserPath || !this.profileDir) {
      throw new ProxyError('network_error',
        `No CDP browser on 127.0.0.1:${this.cdpPort}. Run: node scripts/claude_auth.js`);
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.cdpPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      url,
    ];
    this.launched = spawn(this.browserPath, args, { stdio: 'ignore', detached: false });
    this.launched.on('error', () => { /* сообщим через таймаут */ });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await this.isUp()) return { launched: true };
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new ProxyError('timeout',
      `Browser started but CDP on 127.0.0.1:${this.cdpPort} did not answer in 30s.`);
  }

  async getPageTarget() {
    const targets = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: this.cdpPort, path: '/json', timeout: 4000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('CDP timeout')));
      req.on('error', reject);
    });
    const pages = (Array.isArray(targets) ? targets : [])
      .filter((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
    const page = pages.find((t) => (t.url || '').includes('claude.ai')) || pages[0];
    if (!page) {
      throw new ProxyError('network_error',
        `No CDP page target on 127.0.0.1:${this.cdpPort}. Start the browser with: node scripts/claude_auth.js`);
    }
    return page;
  }

  async connect() {
    if (this.ws) return this.ws;
    const Impl = globalThis.WebSocket;
    if (typeof Impl !== 'function') {
      throw new ProxyError('internal_error',
        'This Node has no global WebSocket. Use Node 22+ for USE_BROWSER_TRANSPORT=1.');
    }
    const page = await this.getPageTarget();
    const ws = new Impl(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new ProxyError('timeout', 'CDP connect timeout.')), 10000);
      ws.addEventListener('open', () => { clearTimeout(to); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(to); reject(new ProxyError('network_error', 'CDP WebSocket error.')); });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new ProxyError('internal_error', msg.error.message || 'CDP error'));
        else res(msg.result);
      }
    });
    this.ws = ws;
    return ws;
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { res: resolve, rej: reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) {
        this.pending.delete(id);
        reject(new ProxyError('network_error', `CDP send failed: ${e.message}`));
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new ProxyError('timeout', `CDP timeout: ${method}`));
        }
      }, this.timeoutMs || 60000);
    });
  }

  /** GET/POST внутри страницы claude.ai. Возвращает { status, text }. */
  async fetchInPage(method, urlPath, body) {
    await this.connect();
    // сериализуем вызовы: evaluate выполняются в одной вкладке
    const run = this.lock.then(async () => {
      const expression = `(async () => {
        const r = await fetch(${JSON.stringify(urlPath)}, {
          method: ${JSON.stringify(method)},
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
          credentials: 'include',
          ${body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(body))},`}
        });
        const text = await r.text();
        return JSON.stringify({ status: r.status, text });
      })()`;
      const res = await this.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (res && res.exceptionDetails) {
        throw new ProxyError('network_error',
          `Browser fetch failed: ${res.exceptionDetails.text || 'unknown'}`);
      }
      const raw = res && res.result && res.result.value;
      if (typeof raw !== 'string') {
        throw new ProxyError('protocol_changed',
          'Unexpected CDP evaluate result. Please inspect lib/claude.js (BrowserTransport).');
      }
      const parsed = JSON.parse(raw);
      return { status: parsed.status, text: parsed.text };
    });
    this.lock = run.catch(() => {});
    return run;
  }

  /** Все cookie вкладки claude.ai (только для внутренних запросов). */
  async readCookieHeader() {
    await this.connect();
    const res = await this.send('Network.getAllCookies');
    const cookies = (res && res.cookies) || [];
    return cookies
      .filter((c) => typeof c.domain === 'string' && c.domain.includes('claude.ai'))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  close() { if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; } }
}

class ClaudeWebClient {
  constructor(config) {
    this.config = config;
    this.auth = null;
    this.browser = config.useBrowserTransport
      ? new BrowserTransport({
        cdpPort: config.cdpPort || 9222,
        timeoutMs: config.requestTimeoutMs,
        profileDir: config.profileDir || null,
        browserPath: config.browserPath || null,
      })
      : null;
  }

  /** Режим браузера: поднять окно, где пользователь один раз входит в Claude. */
  async ensureBrowser() {
    if (!this.browser) return { launched: false, mode: 'node-https' };
    const r = await this.browser.launch({ url: `${this.config.baseUrl}/new` });
    if (r.launched) {
      logger.info('Browser window opened for Claude login', {
        url: `${this.config.baseUrl}/new`, cdpPort: this.browser.cdpPort,
      });
    }
    return { ...r, mode: 'browser-cdp' };
  }

  /**
   * Один HTTP-вызов к claude.ai: либо из Node, либо внутри авторизованной страницы.
   * Возвращает { status, headers, body, text, streamed }.
   */
  async call({ method, urlPath, body, headers, accept, timeoutMs }) {
    if (this.browser) {
      const res = await this.browser.fetchInPage(method, urlPath, body);
      if (res.status >= 400) throw mapHttpError(res.status, res.text);
      let json = null;
      try { json = res.text ? JSON.parse(res.text) : null; } catch { /* не JSON */ }
      return { status: res.status, headers: {}, body: json, text: res.text, streamed: false };
    }
    return request({
      baseUrl: this.config.baseUrl,
      method,
      urlPath,
      headers: { ...headers, ...(accept ? { Accept: accept } : {}) },
      body,
      timeoutMs: timeoutMs || this.config.requestTimeoutMs,
    });
  }

  ensureAuth() {
    if (this.auth) return this.auth;
    try {
      this.auth = loadAuth(this.config.authFile);
      logger.info('Claude auth loaded');
      return this.auth;
    } catch (e) {
      // Режим браузера: cookie и CSRF берутся из самой вкладки, файл не нужен.
      if (this.browser) {
        this.auth = { browserSession: true };
        logger.info('Browser transport: session taken from the logged-in browser tab');
        return this.auth;
      }
      throw e;
    }
  }

  /** CSRF-токен из cookie вкладки (нужен для POST в браузерном режиме). */
  async ensureCsrf() {
    if (!this.browser || this.auth.csrfToken) return;
    const res = await this.browser.fetchInPage('GET', '/api/organizations', undefined);
    const cookies = await this.browser.readCookieHeader();
    const m = /(?:^|;\s*)csrf[_-]?token=([^;]+)/i.exec(cookies || '');
    if (m) this.auth.csrfToken = decodeURIComponent(m[1]);
    if (res.status >= 400 && !this.auth.csrfToken) {
      throw mapHttpError(res.status, res.text);
    }
  }

  async getOrganizationId() {
    const auth = this.ensureAuth();
    if (auth.organizationId) return auth.organizationId;
    if (auth.lastActiveOrg) return auth.lastActiveOrg;

    const res = await this.call({
      method: 'GET',
      urlPath: '/api/organizations',
      headers: baseHeaders(auth),
      accept: 'application/json',
      timeoutMs: 30000,
    });
    if (!Array.isArray(res.body) || !res.body.length || !res.body[0].uuid) {
      throw new ProxyError('protocol_changed',
        'Unexpected /api/organizations response. Please inspect lib/claude.js.');
    }
    auth.organizationId = res.body[0].uuid;
    logger.info('Claude organization discovered');
    return auth.organizationId;
  }

  async createConversation(conversationId, model) {
    const auth = this.ensureAuth();
    const org = await this.getOrganizationId();
    const res = await this.call({
      method: 'POST',
      urlPath: `/api/organizations/${org}/chat_conversations`,
      headers: baseHeaders(auth),
      accept: 'application/json',
      body: {
        name: '',
        uuid: conversationId,
        include_conversation_preferences: true,
        is_temporary: false,
        model,
      },
      timeoutMs: 60000,
    });
    if (res.status !== 200 && res.status !== 201 && res.status !== 409) {
      throw new ProxyError('claude_error', `Could not create conversation (${res.status}).`);
    }
    logger.info('Claude conversation created');
  }

  buildPayload({ prompt, model, parentMessageUuid, isNewConversation, timezone, thinkingMode }) {
    const auth = this.ensureAuth();
    const payload = {
      attachments: [],
      files: [],
      locale: 'en-US',
      model,
      // Допустимые значения (проверено ответом сервера): extended | standard | auto | off
      ...(thinkingMode ? { thinking_mode: thinkingMode } : {}),
      personalized_styles: [DEFAULT_STYLE],
      prompt,
      rendering_mode: 'messages',
      sync_sources: [],
      timezone: timezone || auth.timezone || 'UTC',
      tools: DEFAULT_TOOLS,
      turn_message_uuids: {
        human_message_uuid: crypto.randomUUID(),
        assistant_message_uuid: crypto.randomUUID(),
      },
    };
    if (isNewConversation) {
      payload.create_conversation_params = {
        name: '',
        model,
        include_conversation_preferences: true,
        is_temporary: false,
        enabled_imagine: true,
      };
    } else {
      payload.parent_message_uuid = parentMessageUuid || ZERO_UUID;
    }
    return payload;
  }

  /**
   * Отправляет prompt, стримит события через onEvent:
   * {kind:'text'|'thinking'|'message_id'|'stop'|'limit'|'done'}
   * Возвращает { text, thinking, messageId }.
   */
  async send({ prompt, model, conversationId, parentMessageUuid, isNewConversation, thinkingMode, onEvent }) {
    const auth = this.ensureAuth();
    const org = await this.getOrganizationId();
    const payload = this.buildPayload({ prompt, model, parentMessageUuid, isNewConversation, thinkingMode });

    let text = '';
    let thinking = '';
    let messageId = parentMessageUuid || ZERO_UUID;

    const parser = createSseParser((evt) => {
      if (evt.kind === 'text') { text += evt.text; onEvent(evt); }
      else if (evt.kind === 'thinking') { thinking += evt.text; onEvent(evt); }
      else if (evt.kind === 'message_id') { messageId = evt.id; onEvent(evt); }
      else onEvent(evt);
    });

    const url = `/api/organizations/${org}/chat_conversations/${conversationId}/completion`;
    logger.info('Claude stream started', { conversation: conversationId.slice(0, 8) });

    let res;
    if (this.browser) {
      // Внутри страницы fetch отдаёт полный текст: стримим уже разобранные события.
      res = await this.call({
        method: 'POST',
        urlPath: url,
        headers: baseHeaders(auth),
        accept: 'text/event-stream',
        body: payload,
      });
      parser.push(res.text || '');
    } else {
      res = await request({
        baseUrl: this.config.baseUrl,
        method: 'POST',
        urlPath: url,
        headers: baseHeaders(auth, { Accept: 'text/event-stream' }),
        body: payload,
        timeoutMs: this.config.requestTimeoutMs,
        onChunk: (chunk) => parser.push(chunk),
      });
    }

    if (!this.browser && !res.streamed) {
      logger.warn('claude.ai did not answer with text/event-stream', {
        contentType: res.headers && res.headers['content-type'],
      });
      throw new ProxyError('protocol_changed',
        'Claude Web answered with a non-SSE body. Please inspect lib/claude.js / lib/stream.js.');
    }

    const stats = parser.flush();
    assertNotProtocolChanged(stats);

    logger.info('Claude stream completed', { chars: text.length, thinkingChars: thinking.length });
    return { text, thinking, messageId };
  }
}

module.exports = {
  ClaudeWebClient, BrowserTransport, proxyFor, loadAuth, baseHeaders, cookieHeader,
  DEFAULT_TOOLS, DEFAULT_STYLE, ZERO_UUID, request, mapHttpError,
};
