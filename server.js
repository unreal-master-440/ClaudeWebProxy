'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const { loadEnv, bool, num } = require('./lib/env');
const logger = require('./lib/logger');
const { ProxyError, toOpenAI, toAnthropic, logError } = require('./lib/errors');
const { createModelMapper } = require('./lib/models');
const { SessionStore } = require('./lib/sessions');
const { ClaudeWebClient, loadAuth } = require('./lib/claude');
const P = require('./lib/protocols');

const ROOT = __dirname;
const env = loadEnv(ROOT);

const config = {
  host: env.HOST || '127.0.0.1',
  port: num(env.PORT, 9656),
  authFile: path.isAbsolute(env.AUTH_FILE || '')
    ? env.AUTH_FILE
    : path.join(ROOT, env.AUTH_FILE || 'claude-auth.json'),
  baseUrl: env.CLAUDE_BASE_URL || 'https://claude.ai',
  requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 180000),
  useBrowserTransport: bool(env.USE_BROWSER_TRANSPORT, false),
  cdpPort: num(env.CDP_PORT, 9222),
  profileDir: path.join(ROOT, 'browser-profile'),
  browserPath: findBrowserPath(),
  sessionTtlMs: num(env.SESSION_TTL_MS, 30 * 60 * 1000),
};

if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
  logger.warn('HOST is not 127.0.0.1 — the proxy should stay local only.');
}

const sessions = new SessionStore({ ttlMs: config.sessionTtlMs });
const claude = new ClaudeWebClient(config);

let models = createModelMapper(null);
try {
  models = createModelMapper(loadAuth(config.authFile));
} catch (e) {
  logger.warn(`Auth not loaded yet: ${e.message}`);
}

/** ---------------- HTTP helpers ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendSseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function sseWrite(res, eventName, data) {
  if (res.writableEnded) return;
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new ProxyError('invalid_request', 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch {
        reject(new ProxyError('invalid_request', 'Body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sessionKeyFor(body, req) {
  const explicit = req.headers['x-session-id'] || body.session_id || body.conversation_id || body.user;
  if (explicit) return String(explicit);
  const first = body.messages && body.messages[0];
  const seed = first ? JSON.stringify(first).slice(0, 64) : 'anon';
  return `default:${seed}`;
}

/** ---------------- core: один turn через claude.ai ---------------- */

async function runTurn({ prompt, clientModel, clientSessionId, thinkingLevel, wire }) {
  const internalModel = models.resolve(clientModel);
  const thinkingMode = models.resolveThinking(thinkingLevel);
  const session = sessions.get(clientSessionId);
  const conversationId = session && session.conversationId
    ? session.conversationId
    : crypto.randomUUID();
  const isNew = !(session && session.conversationId);
  const parent = session ? session.lastMessageId : null;

  if (isNew) {
    await claude.createConversation(conversationId, internalModel);
  }
  sessions.touch(clientSessionId, { conversationId, model: internalModel });

  const result = await claude.send({
    prompt,
    model: internalModel,
    conversationId,
    parentMessageUuid: parent,
    isNewConversation: isNew,
    thinkingMode,
    onEvent: (evt) => {
      if (!wire.stream) return;
      if (evt.kind === 'text') wire.onText(evt.text);
      else if (evt.kind === 'thinking') wire.onThinking(evt.text);
    },
  });

  sessions.touch(clientSessionId, { lastMessageId: result.messageId });
  return { ...result, internalModel, prompt };
}

/** ---------------- GUI ---------------- */

const UI_DIR = path.join(ROOT, 'public');

async function serveUi(res) {
  let html;
  try {
    html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  } catch {
    sendJson(res, 500, { error: { message: 'public/index.html not found', type: 'internal_error' } });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

async function handleUiStatus(req, res) {
  const modelsInfo = models.describe();
  const browser = claude.browser ? await claude.browser.isUp().catch(() => false) : false;
  sendJson(res, 200, {
    ok: true,
    transport: config.useBrowserTransport ? 'cdp-browser' : 'node-https',
    browserConnected: browser,
    proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null,
    models: modelsInfo,
    thinkingLevels: models.thinkingLevels,
    defaultModel: models.defaultModel,
    defaultThinking: 'standard',
  });
}

async function handleUiChat(req, res, body) {
  const message = String(body.message || '').trim();
  if (!message) {
    sendJson(res, 400, { error: { message: 'message is required', type: 'invalid_request' } });
    return;
  }
  const history = Array.isArray(body.history) ? body.history : [];
  const prompt = history.length
    ? history.map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`).join('\n\n') +
      `\n\nHuman: ${message}`
    : message;

  const key = 'ui:' + (body.sessionId || 'default');
  const clientModel = body.model || models.defaultModel;
  const thinkingLevel = body.thinking || 'standard';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    write('start', { model: clientModel, thinking: thinkingLevel });
    const r = await runTurn({
      prompt,
      clientModel,
      clientSessionId: key,
      thinkingLevel,
      wire: {
        stream: true,
        onText: (t) => write('delta', { text: t }),
        onThinking: (t) => write('thinking', { text: t }),
      },
    });
    write('done', { text: r.text, messageId: r.messageId, model: r.internalModel });
  } catch (e) {
    logError(e, 'ui-chat');
    write('error', {
      type: (e && e.type) || 'internal_error',
      message: (e && e.message) || 'Unknown error',
    });
  }
  res.end();
}

/** ---------------- routes ---------------- */

async function handleHealth(req, res) {
  let auth;
  try {
    const a = loadAuth(config.authFile);
    auth = { ok: true, organization: Boolean(a.organizationId || a.lastActiveOrg) };
  } catch (e) {
    auth = config.useBrowserTransport
      ? { ok: true, mode: 'browser-session', note: 'session taken from the browser tab' }
      : { ok: false, error: e.message };
  }
  sendJson(res, 200, {
    status: 'ok',
    proxy: 'ClaudeWebProxy',
    version: require('./package.json').version,
    auth,
    models: models.list(),
    transport: config.useBrowserTransport ? 'cdp-browser' : 'node-https',
    proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null,
  });
}

async function handleModels(req, res) {
  const created = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: 'list',
    data: models.list().map((id) => ({ id, object: 'model', created, owned_by: 'claude-web' })),
  });
}

async function handleOpenAI(req, res, body) {
  const { system, turns, model } = P.flattenOpenAI(body);
  const prompt = P.composePrompt({ system, turns });
  const clientModel = model || models.defaultModel;
  const id = P.newId('chatcmpl-');
  const key = sessionKeyFor(body, req);

  if (!body.stream) {
    const r = await runTurn({ prompt, clientModel, clientSessionId: key, wire: { stream: false } });
    return sendJson(res, 200, P.openAIResponse(id, clientModel, r.text, prompt));
  }

  sendSseHead(res);
  const wire = {
    stream: true,
    onText: (t) => sseWrite(res, null, P.openAIDeltaChunk(id, clientModel, { content: t })),
    onThinking: () => {},
  };
  try {
    await runTurn({ prompt, clientModel, clientSessionId: key, wire });
    sseWrite(res, null, P.openAIDeltaChunk(id, clientModel, {}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    logError(e, 'openai-stream');
    // Настоящая ошибка, а не фальшивый успешный ответ.
    sseWrite(res, null, toOpenAI(e));
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

async function handleAnthropic(req, res, body) {
  const { system, turns, model } = P.flattenAnthropic(body);
  const prompt = P.composePrompt({ system, turns });
  const clientModel = model || models.defaultModel;
  const id = P.newId('msg_');
  const key = sessionKeyFor(body, req);

  if (!body.stream) {
    const r = await runTurn({ prompt, clientModel, clientSessionId: key, wire: { stream: false } });
    return sendJson(res, 200, P.anthropicMessage(id, clientModel, r.text, prompt));
  }

  sendSseHead(res);
  const ev = P.anthropicEvents(id, clientModel, prompt);
  const wire = {
    stream: true,
    onText: (t) => sseWrite(res, 'content_block_delta', ev.textDelta(t)),
    onThinking: () => {},
  };
  try {
    sseWrite(res, 'message_start', ev.messageStart());
    sseWrite(res, 'content_block_start', ev.blockStart());
    const r = await runTurn({ prompt, clientModel, clientSessionId: key, wire });
    sseWrite(res, 'content_block_stop', ev.blockStop());
    sseWrite(res, 'message_delta', ev.messageDelta(r.text));
    sseWrite(res, 'message_stop', ev.messageStop());
    res.end();
  } catch (e) {
    logError(e, 'anthropic-stream');
    sseWrite(res, 'error', toAnthropic(e));
    res.end();
  }
}

async function handleResponses(req, res, body) {
  const { system, turns, model } = P.flattenResponses(body);
  const prompt = P.composePrompt({ system, turns });
  const clientModel = model || models.defaultModel;
  const key = sessionKeyFor(body, req);
  const respId = P.newId('resp_');
  const msgId = P.newId('msg_');

  if (!body.stream) {
    const r = await runTurn({ prompt, clientModel, clientSessionId: key, wire: { stream: false } });
    return sendJson(res, 200, {
      id: respId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: clientModel,
      status: 'completed',
      output: [{
        type: 'message', id: msgId, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: r.text, annotations: [] }],
      }],
      usage: {
        input_tokens: P.estimateTokens(prompt),
        output_tokens: P.estimateTokens(r.text),
        total_tokens: P.estimateTokens(prompt) + P.estimateTokens(r.text),
      },
    });
  }

  sendSseHead(res);
  const wire = {
    stream: true,
    onText: (t) => sseWrite(res, 'response.output_text.delta', {
      type: 'response.output_text.delta', item_id: msgId, output_index: 0,
      content_index: 0, delta: t,
    }),
    onThinking: () => {},
  };
  try {
    sseWrite(res, 'response.created', {
      type: 'response.created',
      response: { id: respId, object: 'response', status: 'in_progress', model: clientModel, output: [] },
    });
    sseWrite(res, 'response.output_item.added', {
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] },
    });
    const r = await runTurn({ prompt, clientModel, clientSessionId: key, wire });
    sseWrite(res, 'response.output_text.done', {
      type: 'response.output_text.done', item_id: msgId, output_index: 0,
      content_index: 0, text: r.text,
    });
    sseWrite(res, 'response.completed', {
      type: 'response.completed',
      response: {
        id: respId, object: 'response', status: 'completed', model: clientModel,
        output: [{
          type: 'message', id: msgId, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: r.text, annotations: [] }],
        }],
        usage: {
          input_tokens: P.estimateTokens(prompt),
          output_tokens: P.estimateTokens(r.text),
          total_tokens: P.estimateTokens(prompt) + P.estimateTokens(r.text),
        },
      },
    });
    res.end();
  } catch (e) {
    logError(e, 'responses-stream');
    sseWrite(res, 'response.failed', {
      type: 'response.failed',
      response: { id: respId, object: 'response', status: 'failed', error: toOpenAI(e).error },
    });
    res.end();
  }
}

/** ---------------- server ---------------- */

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (req.method === 'GET' && url.pathname === '/health') return await handleHealth(req, res);
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        return await handleModels(req, res);
      }

      // --- GUI ---
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui')) {
        return await serveUi(res);
      }
      if (req.method === 'GET' && url.pathname === '/api/ui/status') {
        return await handleUiStatus(req, res);
      }
      if (req.method === 'POST' && url.pathname === '/api/ui/chat') {
        const body = await readBody(req);
        return await handleUiChat(req, res, body);
      }

      const isOpenAI = req.method === 'POST' && url.pathname === '/v1/chat/completions';
      const isAnthropic = req.method === 'POST' && url.pathname === '/v1/messages';
      const isResponses = req.method === 'POST' && url.pathname === '/v1/responses';

      if (!isOpenAI && !isAnthropic && !isResponses) {
        return sendJson(res, 404, {
          error: { message: `Unknown route: ${route}`, type: 'invalid_request', code: 'not_found' },
        });
      }

      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, 400, isAnthropic ? toAnthropic(e) : toOpenAI(e));
      }

      logger.info(`Request ${route}`, { model: body && body.model, stream: Boolean(body && body.stream) });

      if (isOpenAI) await handleOpenAI(req, res, body);
      else if (isAnthropic) await handleAnthropic(req, res, body);
      else await handleResponses(req, res, body);
    } catch (e) {
      logError(e, route);
      const isAnthropic = url.pathname === '/v1/messages';
      const payload = isAnthropic ? toAnthropic(e) : toOpenAI(e);
      if (res.headersSent) {
        sseWrite(res, isAnthropic ? 'error' : null, payload);
        res.end();
      } else {
        sendJson(res, e instanceof ProxyError ? e.httpStatus : 500, payload);
      }
    }
  });
}

function findBrowserPath() {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  try {
    return require('./scripts/claude_auth').findBrowser();
  } catch {
    return null;
  }
}

function start() {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    logger.info('ClaudeWebProxy started');
    logger.info(`Listening on http://${config.host}:${config.port}`);
    logger.info('Endpoints: GET /health, GET /v1/models, POST /v1/chat/completions, ' +
      'POST /v1/messages, POST /v1/responses');
    if (config.useBrowserTransport) {
      // Как в GeminiWebProxy: сразу открываем окно браузера, где нужно войти в Claude.
      claude.ensureBrowser()
        .then((r) => {
          if (r.launched) {
            logger.info('Log in to Claude in the opened browser window; requests will use that page.');
          } else {
            logger.info('Browser already running with CDP; using its claude.ai tab.');
          }
        })
        .catch((e) => logger.error(`Browser transport unavailable: ${e.message}`));
    }
  });
  return server;
}

if (require.main === module) {
  logger.setLevel(env.LOG_LEVEL || 'info');
  if (process.argv.includes('--test')) {
    setImmediate(() => {
      require('./scripts/test').run({ models })
        .then((code) => {
          sessions.close();
          process.exit(code);
        });
    });
  } else {
    const server = start();
    const shutdown = () => {
      logger.info('Shutting down');
      sessions.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

module.exports = { createServer, start, config, models, sessions, claude };
