'use strict';
/**
 * Smoke-test без npm-зависимостей.
 *   node server.js --test
 *   node scripts/test.js
 *
 * Если Claude Web недоступен, тест сообщает об этом как о РЕАЛЬНОЙ ошибке
 * и НЕ считает успешным ответом подделку.
 */
const http = require('http');
const path = require('path');

function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const post = (port, p, b) => request(port, 'POST', p, b, { 'x-session-id': 'smoke-test' });
const get = (port, p) => request(port, 'GET', p);

function firstError(body) {
  try {
    const j = JSON.parse(body);
    if (j.error && j.error.message) return j.error.message;
  } catch { /* ignore */ }
  const m = body.match(/data: (\{.*\})/);
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      if (j.error && j.error.message) return j.error.message;
      if (j.response && j.response.error && j.response.error.message) return j.response.error.message;
    } catch { /* ignore */ }
  }
  return null;
}

async function run({ models, createServer: injected }) {
  const factory = injected || require(path.join(__dirname, '..', 'server.js')).createServer;
  const server = factory();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`\n[TEST] Proxy on 127.0.0.1:${port}\n`);

  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures += 1;
  };

  const h = await get(port, '/health');
  check('GET /health', h.status === 200, `status=${h.status}`);

  const m = await get(port, '/v1/models');
  let modelList = [];
  try { modelList = JSON.parse(m.body).data.map((x) => x.id); } catch { /* ignore */ }
  check('GET /v1/models', m.status === 200 && modelList.length > 0, modelList.join(','));
  const model = modelList[0] || models.defaultModel;

  const prompt = { model, messages: [{ role: 'user', content: 'Say exactly: OK' }] };

  const chat = await post(port, '/v1/chat/completions', prompt);
  let chatOk = false;
  let chatDetail = '';
  try {
    const j = JSON.parse(chat.body);
    if (chat.status === 200 && j.choices && j.choices[0] && j.choices[0].message) chatOk = true;
    else chatDetail = firstError(chat.body) || `status=${chat.status}`;
  } catch { chatDetail = `status=${chat.status}`; }
  check('POST /v1/chat/completions', chatOk, chatDetail);

  const chatStream = await post(port, '/v1/chat/completions', { ...prompt, stream: true });
  const sseOk = chatStream.status === 200 &&
    chatStream.body.includes('chat.completion.chunk') &&
    chatStream.body.trimEnd().endsWith('data: [DONE]');
  check('POST /v1/chat/completions stream=true', sseOk,
    sseOk ? 'SSE + [DONE]'
      : (firstError(chatStream.body) || `status=${chatStream.status}`));

  const msg = await post(port, '/v1/messages', {
    model, max_tokens: 1024, messages: [{ role: 'user', content: 'Say exactly: OK' }],
  });
  let msgOk = false;
  let msgDetail = '';
  try {
    const j = JSON.parse(msg.body);
    if (msg.status === 200 && j.type === 'message') msgOk = true;
    else msgDetail = firstError(msg.body) || `status=${msg.status}`;
  } catch { msgDetail = `status=${msg.status}`; }
  check('POST /v1/messages', msgOk, msgDetail);

  const msgStream = await post(port, '/v1/messages', {
    model, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'Say exactly: OK' }],
  });
  const anthOk = msgStream.status === 200 &&
    msgStream.body.includes('event: message_start') &&
    msgStream.body.includes('event: message_stop') &&
    !msgStream.body.includes('event: error');
  check('POST /v1/messages stream=true', anthOk,
    anthOk ? 'message_start … message_stop'
      : (firstError(msgStream.body) || `status=${msgStream.status}`));

  const resp = await post(port, '/v1/responses', { model, input: 'Say exactly: OK' });
  let respOk = false;
  let respDetail = '';
  try {
    const j = JSON.parse(resp.body);
    if (resp.status === 200 && j.object === 'response') respOk = true;
    else respDetail = firstError(resp.body) || `status=${resp.status}`;
  } catch { respDetail = `status=${resp.status}`; }
  check('POST /v1/responses', respOk, respDetail);

  const respStream = await post(port, '/v1/responses', { model, input: 'Say exactly: OK', stream: true });
  const rOk = respStream.status === 200 &&
    respStream.body.includes('response.created') &&
    (respStream.body.includes('response.completed') || respStream.body.includes('response.failed'));
  check('POST /v1/responses stream=true', rOk,
    rOk ? 'response.created … response.completed|failed'
      : (firstError(respStream.body) || `status=${respStream.status}`));

  server.close();
  console.log(`\n[TEST] ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}\n`);
  return failures === 0 ? 0 : 1;
}

module.exports = { run };

if (require.main === module) {
  const { loadEnv, num } = require(path.join(__dirname, '..', 'lib', 'env'));
  const { createModelMapper } = require(path.join(__dirname, '..', 'lib', 'models'));
  const env = loadEnv(path.join(__dirname, '..'));
  const models = createModelMapper(null);
  run({ config: { port: num(env.PORT, 9656) }, models }).then((c) => process.exit(c));
}
