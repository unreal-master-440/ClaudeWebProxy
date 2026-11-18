'use strict';
const { ProxyError } = require('./errors');

/**
 * Слой mapping: CLIENT_MODEL → CLAUDE_WEB_MODEL.
 * Единственное место в проекте, где эти два пространства имён встречаются.
 *
 * Набор моделей НЕ захардкожен: доступность зависит от аккаунта и тарифа,
 * поэтому список берётся из claude-auth.json (.models) с fallback ниже.
 */

const FALLBACK = {
  'claude-sonnet': 'claude-sonnet-5-5',
  'claude-haiku': 'claude-haiku-5-5',
};

/**
 * Каталог моделей Claude Web.
 *
 * Проверено живыми запросами к claude.ai (2026-11-17):
 *   claude-sonnet-5-5   → 200, ответ "OK"
 *   claude-haiku-5-5    → 200, ответ "OK"
 * Варианты с датой (claude-sonnet-5-5-20260101) сервер отвергает: 403.
 */
const CATALOG = [
  {
    id: 'claude-sonnet',
    web: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    family: 'sonnet',
    description: 'Основная модель: баланс скорости и качества',
    available: true,
  },
  {
    id: 'claude-haiku',
    web: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    family: 'haiku',
    description: 'Самая быстрая модель, для простых задач',
    available: true,
  },
];

/**
 * Уровни мышления (поле thinking_mode в теле запроса к claude.ai).
 * Полный список допустимых значений получен из ответа сервера на заведомо
 * неверное значение: "Input should be 'extended', 'standard', 'auto' or 'off'".
 *
 * Проверено: 'extended' меняет ответ (развёрнутое рассуждение), 200 OK.
 * Важно: сам блок thinking (thinking_delta) в стриме для этого аккаунта
 * не приходит — меняется только стиль ответа. Это отражено в README.
 */
const THINKING_LEVELS = [
  { id: 'off', label: 'Выключено', description: 'Без рассуждений — быстрее всего' },
  { id: 'standard', label: 'Обычное', description: 'Стандартный режим Claude' },
  { id: 'auto', label: 'Авто', description: 'Claude сам решает, думать ли' },
  { id: 'extended', label: 'Расширенное', description: 'Развёрнутые рассуждения, медленнее' },
];

const DEFAULT_THINKING = 'standard';

function createModelMapper(auth) {
  const overrides = (auth && auth.models) || {};
  const disabled = new Set((auth && auth.unavailableModels) || []);
  const map = {};
  for (const m of CATALOG) {
    if (overrides[m.id]) {
      map[m.id] = overrides[m.id];
    } else if (m.available && !disabled.has(m.id)) {
      map[m.id] = m.web;
    }
  }
  // Пользовательские модели из claude-auth.json, которых нет в каталоге
  for (const [k, v] of Object.entries(overrides)) {
    if (!map[k] && !disabled.has(k)) map[k] = v;
  }
  const defaultModel = (auth && auth.defaultModel) || 'claude-sonnet';

  function list() {
    return Object.keys(map);
  }

  /** Каталог для GUI: все модели, включая недоступные в тарифе. */
  function describe() {
    const known = new Map(CATALOG.map((m) => [m.id, m]));
    const rows = [];
    for (const m of CATALOG) {
      const usable = Boolean(map[m.id]);
      rows.push({
        id: m.id,
        label: m.label,
        family: m.family,
        description: m.description,
        webModel: map[m.id] || m.web,
        available: usable,
        reason: usable ? null : (disabled.has(m.id) ? 'отключена в claude-auth.json' : 'недоступна в текущем плане Claude'),
      });
    }
    for (const [k, v] of Object.entries(map)) {
      if (!known.has(k)) {
        rows.push({ id: k, label: k, family: 'custom', description: 'из claude-auth.json', webModel: v, available: true, reason: null });
      }
    }
    return rows;
  }

  function resolve(clientModel) {
    const wanted = (clientModel || defaultModel || '').trim();
    if (!wanted) throw new ProxyError('invalid_request', 'Model is required.');

    if (map[wanted]) return map[wanted];
    for (const internal of Object.values(map)) {
      if (internal === wanted) return internal;
    }
    const known = CATALOG.find((m) => m.id === wanted || m.web === wanted);
    if (known) {
      throw new ProxyError(
        'unsupported_model',
        `Model "${wanted}" (${known.label}) is not available in your Claude plan. ` +
        `Available: ${list().join(', ')}.`,
      );
    }
    throw new ProxyError(
      'unsupported_model',
      `Model "${wanted}" is not configured. Available: ${list().join(', ')}. ` +
      'Edit "models" in claude-auth.json (or run scripts/claude_auth.js again).',
    );
  }

  function resolveThinking(level) {
    const wanted = String(level || DEFAULT_THINKING).trim().toLowerCase();
    if (wanted === 'default' || wanted === '') return DEFAULT_THINKING;
    const found = THINKING_LEVELS.find((t) => t.id === wanted);
    if (!found) {
      throw new ProxyError(
        'invalid_request',
        `Unknown thinking level "${level}". Use one of: ${THINKING_LEVELS.map((t) => t.id).join(', ')}.`,
      );
    }
    return found.id;
  }

  return { list, describe, resolve, resolveThinking, defaultModel, thinkingLevels: THINKING_LEVELS };
}

module.exports = { createModelMapper, FALLBACK, CATALOG, THINKING_LEVELS, DEFAULT_THINKING };
