'use strict';
const crypto = require('crypto');
const { ProxyError } = require('./errors');

/** ---------------- разбор входящих запросов ---------------- */

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
        if (part && part.type === 'input_text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function flattenOpenAI(body) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    throw new ProxyError('invalid_request', '"messages" must be a non-empty array.');
  }
  const systems = [];
  const turns = [];
  for (const m of body.messages) {
    const text = textFromContent(m.content);
    if (m.role === 'system' || m.role === 'developer') systems.push(text);
    else if (m.role === 'user') turns.push({ role: 'user', text });
    else if (m.role === 'assistant') turns.push({ role: 'assistant', text });
  }
  if (!turns.length) throw new ProxyError('invalid_request', 'No user/assistant messages found.');
  return { system: systems.join('\n\n').trim(), turns, model: body.model };
}

function flattenAnthropic(body) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    throw new ProxyError('invalid_request', '"messages" must be a non-empty array.');
  }
  const system = typeof body.system === 'string' ? body.system : textFromContent(body.system);
  const turns = body.messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    text: textFromContent(m.content),
  }));
  return { system: (system || '').trim(), turns, model: body.model };
}

function flattenResponses(body) {
  if (!body) throw new ProxyError('invalid_request', 'Request body is required.');
  const parts = [];
  const pushInput = (input) => {
    if (typeof input === 'string') parts.push({ role: 'user', text: input });
    else if (Array.isArray(input)) {
      for (const item of input) {
        if (typeof item === 'string') parts.push({ role: 'user', text: item });
        else if (item && item.role) parts.push({ role: item.role, text: textFromContent(item.content) });
      }
    }
  };
  if (typeof body.input === 'string' || Array.isArray(body.input)) pushInput(body.input);
  else if (Array.isArray(body.messages)) pushInput(body.messages);
  else throw new ProxyError('invalid_request', '"input" is required.');

  const turns = parts.filter((p) => p.role === 'user' || p.role === 'assistant');
  if (!turns.length) throw new ProxyError('invalid_request', 'No input found.');
  const system = typeof body.instructions === 'string' ? body.instructions : '';
  return { system: system.trim(), turns, model: body.model };
}

/**
 * Web-эндпоинт claude.ai принимает один prompt за запрос, поэтому история
 * склеивается явно и детерминированно. Это осознанное ограничение, а не
 * имитация «настоящего» контекста Claude Web.
 */
function composePrompt({ system, turns }) {
  if (turns.length === 1 && turns[0].role === 'user') {
    return system ? `${system}\n\n${turns[0].text}` : turns[0].text;
  }
  const lines = [];
  if (system) lines.push(`System: ${system}`, '');
  for (const t of turns) {
    lines.push(t.role === 'user' ? 'User:' : 'Assistant:', t.text, '');
  }
  return lines.join('\n').trim();
}

function newId(prefix) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Оценка токенов. Web-эндпоинт не отдаёт usage — см. KNOWN LIMITATIONS. */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

/** ---------------- сборка ответов ---------------- */

function openAIDeltaChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function openAIResponse(id, model, text, promptText) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: estimateTokens(promptText),
      completion_tokens: estimateTokens(text),
      total_tokens: estimateTokens(promptText) + estimateTokens(text),
    },
  };
}

function anthropicMessage(id, model, text, promptText) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(promptText),
      output_tokens: estimateTokens(text),
    },
  };
}

function anthropicEvents(id, model, promptText) {
  return {
    messageStart: () => ({
      type: 'message_start',
      message: {
        id, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: estimateTokens(promptText), output_tokens: 0 },
      },
    }),
    blockStart: () => ({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    textDelta: (t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }),
    blockStop: () => ({ type: 'content_block_stop', index: 0 }),
    messageDelta: (outText) => ({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: estimateTokens(outText) },
    }),
    messageStop: () => ({ type: 'message_stop' }),
  };
}

module.exports = {
  textFromContent,
  flattenOpenAI, flattenAnthropic, flattenResponses,
  composePrompt, newId, estimateTokens,
  openAIDeltaChunk, openAIResponse, anthropicMessage, anthropicEvents,
};
