'use strict';
const logger = require('./logger');

const TYPES = {
  auth_error: { http: 401, openaiCode: 'authentication_error', anthropicType: 'authentication_error' },
  network_error: { http: 502, openaiCode: 'network_error', anthropicType: 'api_error' },
  claude_error: { http: 502, openaiCode: 'upstream_error', anthropicType: 'api_error' },
  invalid_request: { http: 400, openaiCode: 'invalid_request_error', anthropicType: 'invalid_request_error' },
  unsupported_model: { http: 400, openaiCode: 'model_not_found', anthropicType: 'invalid_request_error' },
  rate_limit: { http: 429, openaiCode: 'rate_limit_exceeded', anthropicType: 'rate_limit_error' },
  timeout: { http: 504, openaiCode: 'timeout', anthropicType: 'api_error' },
  internal_error: { http: 500, openaiCode: 'internal_error', anthropicType: 'api_error' },
  protocol_changed: { http: 502, openaiCode: 'protocol_changed', anthropicType: 'api_error' },
};

class ProxyError extends Error {
  constructor(type, message, extra = {}) {
    super(message);
    this.name = 'ProxyError';
    this.type = TYPES[type] ? type : 'internal_error';
    this.extra = extra;
  }
  get httpStatus() { return TYPES[this.type].http; }
}

function sanitizeError(err) {
  if (!err) return { type: 'internal_error', message: 'Unknown error' };
  const message = typeof err.message === 'string' ? err.message : String(err);
  return {
    type: err instanceof ProxyError ? err.type : 'internal_error',
    message: message.replace(/sk-ant-[A-Za-z0-9_\-]+/g, 'sk-ant-***').slice(0, 600),
    ...(err instanceof ProxyError && err.extra && err.extra.code ? { code: err.extra.code } : {}),
  };
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/cookie|authorization|csrf|session|device-id|activity/i.test(k)) out[k] = '***';
    else out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function toOpenAI(err) {
  const s = sanitizeError(err);
  const meta = TYPES[s.type] || TYPES.internal_error;
  return { error: { message: s.message, type: s.type, code: meta.openaiCode } };
}

function toAnthropic(err) {
  const s = sanitizeError(err);
  const meta = TYPES[s.type] || TYPES.internal_error;
  return { type: 'error', error: { type: meta.anthropicType, message: s.message } };
}

function logError(err, where) {
  const s = sanitizeError(err);
  logger.error(`Claude request failed (${where || 'proxy'}): ${s.message}`, { type: s.type });
}

module.exports = {
  TYPES, ProxyError, sanitizeError, sanitizeHeaders, toOpenAI, toAnthropic, logError,
};
