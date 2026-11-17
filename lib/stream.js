'use strict';
const { ProxyError } = require('./errors');
const logger = require('./logger');

/**
 * Разбор SSE от claude.ai.
 *
 * Наблюдаемые события (по сторонним реверс-проектам 2026, статус LIKELY —
 * см. отчёт PHASE 1): message_start, content_block_start,
 * content_block_delta {delta.type: text_delta|thinking_delta}, content_block_stop,
 * message_delta, message_stop, message_limit.
 *
 * Любой НЕИЗВЕСТНЫЙ тип не интерпретируется молча: он копится в unknownTypes.
 * Если за весь стрим не пришло ни одного известного события → protocol_changed.
 */

const KNOWN = new Set([
  'message_start', 'content_block_start', 'content_block_delta',
  'content_block_stop', 'message_delta', 'message_stop', 'message_limit',
]);

function createSseParser(onEvent) {
  let buffer = '';
  let seenKnown = 0;
  const unknownTypes = new Set();

  function handleFrame(frame) {
    if (!frame.trim()) return;
    let dataLine = null;
    for (const raw of frame.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('data:')) dataLine = line.slice(5).trim();
    }
    if (!dataLine) return;
    if (dataLine === '[DONE]') {
      onEvent({ kind: 'done' });
      return;
    }
    let obj;
    try { obj = JSON.parse(dataLine); } catch { return; }
    if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') {
      unknownTypes.add('<no-type>');
      return;
    }
    if (!KNOWN.has(obj.type)) {
      unknownTypes.add(obj.type);
      logger.debug('Unknown Claude SSE event type', { type: obj.type });
      return;
    }
    seenKnown += 1;

    switch (obj.type) {
      case 'message_start': {
        const id = obj.message && obj.message.uuid;
        if (id) onEvent({ kind: 'message_id', id });
        break;
      }
      case 'content_block_start': {
        const block = obj.content_block || {};
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          onEvent({ kind: 'thinking', text: block.thinking });
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          onEvent({ kind: 'text', text: block.text });
        }
        break;
      }
      case 'content_block_delta': {
        const d = obj.delta || {};
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          onEvent({ kind: 'text', text: d.text });
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          onEvent({ kind: 'thinking', text: d.thinking });
        }
        break;
      }
      case 'message_stop': {
        onEvent({ kind: 'stop', message: obj.message || null });
        break;
      }
      case 'message_limit': {
        onEvent({ kind: 'limit', raw: obj.message_limit || null });
        break;
      }
      default:
        break;
    }
  }

  return {
    push(chunk) {
      buffer += chunk;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const f of frames) handleFrame(f);
    },
    flush() {
      if (buffer.trim()) handleFrame(buffer);
      buffer = '';
      return { seenKnown, unknownTypes: [...unknownTypes] };
    },
    get stats() { return { seenKnown, unknownTypes: [...unknownTypes] }; },
  };
}

function assertNotProtocolChanged(stats) {
  if (stats.seenKnown === 0 && stats.unknownTypes.length > 0) {
    throw new ProxyError(
      'protocol_changed',
      'Claude Web protocol appears to have changed. Please inspect lib/claude.js / lib/stream.js. ' +
      `Unknown event types: ${stats.unknownTypes.slice(0, 8).join(', ')}`,
    );
  }
}

module.exports = { createSseParser, assertNotProtocolChanged, KNOWN };
