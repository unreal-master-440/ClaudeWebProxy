'use strict';
/**
 * Режим терминального агента.
 *
 * Зачем: веб-эндпоинт claude.ai не отдаёт блоки tool_use, поэтому Claude Code
 * не может исполнять Bash/Write/Read через этот прокси. Здесь протокол
 * вызовов строится в обычном тексте: модель пишет строку
 *
 *     CALL: <команда>
 *
 * прокси перехватывает её, выполняет команду на этом компьютере, возвращает
 * вывод модели следующим запросом — и так пока модель не напишет DONE.
 *
 * Проверено живыми запросами к claude.ai (3 раунда подряд): формат держится,
 * модель не заявляет, что выполнила команду сама, и завершает по DONE.
 *
 * ВНИМАНИЕ: режим полный — команды выполняются без белого списка,
 * без ограничения папки и без подтверждения. Модель на серверах Anthropic
 * получает возможность запускать что угодно на этой машине.
 * Включается только через AGENT_MODE=1 в .env.
 */
const { exec } = require('child_process');

// cmd.exe пишет в консольной кодировке (cp866 на русской Windows).
// Проверено на живом выводе: байты 8f 90 88 82 85 92 = «ПРИВЕТ» в cp866.
// Node не декодирует cp866 сам, но TextDecoder('ibm866') знает эту таблицу.
const CMD_EXE = (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe');
const cp866 = new TextDecoder('ibm866');

const DONE_MARKERS = /\bDONE\b/;

/** Сколько раундов максимум, чтобы не уйти в бесконечный цикл. */
const DEFAULT_MAX_STEPS = 12;

/** Сколько символов вывода возвращаем модели (иначе ответ вырастет до мегабайт). */
const DEFAULT_MAX_OUTPUT = 6000;

/** Таймаут одной команды, мс. */
const DEFAULT_CMD_TIMEOUT = 120000;

/**
 * Указания, которые прокси добавляет к промпту. У самого веб-эндпоинта нет
 * поля system (проверено: в payload его нет), поэтому инструкция идёт текстом
 * в начале сообщения — модель воспринимает её как часть задачи.
 */
const AGENT_PREAMBLE = [
  '=== TERMINAL AGENT MODE ===',
  'You are a terminal agent running on the user\'s Windows computer.',
  'You CANNOT run commands yourself. Anything you claim about command output is false unless you received it.',
  '',
  'To run a command, output exactly one line and nothing else:',
  'CALL: <command>',
  '',
  'The command runs in cmd.exe on the user machine and its output comes back in the next message.',
  'Rules:',
  '- One CALL per message. Never invent or guess the output.',
  '- Use Windows commands: dir, type, findstr, mkdir, node, python, echo.',
  '- The working directory is given to you. Do not assume Linux paths.',
  '- When the task is fully done, reply with a short summary and the word DONE.',
  '=== END TERMINAL AGENT MODE ===',
].join('\n');

/** Состояние по клиентской сессии: сколько раундов уже прошло. */
const state = new Map();

function reset(sessionId) {
  state.delete(sessionId);
}

function stepsUsed(sessionId) {
  const s = state.get(sessionId);
  return s ? s.steps : 0;
}

/**
 * Извлекает команду из ответа модели.
 * Возвращает { kind: 'call', command } | { kind: 'done' } | { kind: 'text' }.
 */
function parseReply(text) {
  const raw = String(text || '');
  // CALL: ищем в начале строки, допускаем отступы и ```-обёртку
  const m = /^[ \t>*|`-]*CALL:[ \t]*(.+)$/im.exec(raw);
  if (m) {
    const command = m[1].trim().replace(/^```|```$/g, '').trim();
    if (command) return { kind: 'call', command };
  }
  if (DONE_MARKERS.test(raw)) return { kind: 'done' };
  return { kind: 'text' };
}

/**
 * Выполняет команду на этой машине.
 * Возвращает { output, exitCode, truncated }.
 */
function runCommand(command, options) {
  const { cwd, timeoutMs, maxOutput } = options || {};
  const limit = maxOutput || DEFAULT_MAX_OUTPUT;
  const wait = timeoutMs || DEFAULT_CMD_TIMEOUT;

  return new Promise((resolve) => {
    // Важно: команда передаётся СТРОКОЙ с shell=cmd.exe.
    // Проверено на этой машине: при передаче массивом аргументов
    // (['/d','/c', cmd]) Node 24 экранирует кавычки так, что cmd получает
    // \" и падает на любом пути в кавычках («Синтаксическая ошибка в имени
    // файла»). Со строкой кавычки доходят правильно.
    const chunks = [];
    let finished = false;
    const done = (result) => {
      if (!finished) { finished = true; resolve(result); }
    };

    let child;
    try {
      child = exec(command, {
        shell: CMD_EXE,
        cwd: cwd || process.cwd(),
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: 16 * 1024 * 1024,
        timeout: wait,
      }, (err, stdout, stderr) => {
        const buf = Buffer.concat([stdout || Buffer.alloc(0), stderr || Buffer.alloc(0)]);
        let text = buf.toString('utf8');
        // Если utf8 дал «кракозябры» — это cp866 из консоли
        if (text.includes('\uFFFD')) text = cp866.decode(buf);
        const out = text.replace(/\r\n/g, '\n').trimEnd();
        const killed = Boolean(err && err.killed);
        const truncated = out.length > limit;
        done({
          output: killed
            ? `${out}\n…(команда прервана по таймауту ${wait} мс)`.trim()
            : (truncated ? `${out.slice(0, limit)}\n…(вывод обрезан, всего ${out.length} символов)` : out),
          exitCode: killed ? 124 : (err && typeof err.code === 'number' ? err.code : (err ? 1 : 0)),
          truncated,
        });
      });
      child.on('error', (e) => {
        done({ output: `Не удалось запустить cmd.exe: ${e.message}`, exitCode: 1, truncated: false });
      });
    } catch (e) {
      done({ output: `Ошибка запуска команды: ${e.message}`, exitCode: 1, truncated: false });
    }
  });
}

/**
 * Формирует сообщение с результатом команды для следующего раунда.
 */
function feedbackFor(command, result) {
  const body = result.output || '(команда ничего не вывела)';
  return [
    `Command: ${command}`,
    `Exit code: ${result.exitCode}`,
    'Output:',
    body,
    '',
    'Continue. Reply with one CALL: line, or finish with DONE.',
  ].join('\n');
}

/**
 * Обёртка вокруг одного turn: добавляет инструкцию и крутит раунды,
 * пока модель не скажет DONE или не кончится лимит.
 *
 * sendTurn(prompt) должен вернуть { text, ... } — один запрос к Claude.
 * onEvent(evt) сообщает о происходящем (используется для стрима в GUI/лог).
 */
async function run({ prompt, sessionId, sendTurn, cwd, maxSteps, onEvent }) {
  const limit = maxSteps || DEFAULT_MAX_STEPS;
  const log = typeof onEvent === 'function' ? onEvent : () => {};
  const s = state.get(sessionId) || { steps: 0 };
  state.set(sessionId, s);

  let current = `${AGENT_PREAMBLE}\n\nWorking directory: ${cwd || process.cwd()}\n\nUser task:\n${prompt}`;
  let last = null;

  while (s.steps < limit) {
    s.steps += 1;
    last = await sendTurn(current);
    const reply = parseReply(last.text);

    if (reply.kind === 'call') {
      log({ kind: 'agent_call', command: reply.command, step: s.steps });
      // cwd применяется как рабочая папка; относительные пути в команде
      // считаются от неё (проверено: type test.txt находит файл в cwd).
      const result = await runCommand(reply.command, { cwd });
      log({ kind: 'agent_result', exitCode: result.exitCode,
        output: result.output.slice(0, 400), step: s.steps });
      current = feedbackFor(reply.command, result);
      continue;
    }

    if (reply.kind === 'done') {
      log({ kind: 'agent_done', step: s.steps });
      return { ...last, agentSteps: s.steps, agentFinished: true };
    }

    // Ответ без CALL и без DONE: модель просто ответила — это конец работы.
    return { ...last, agentSteps: s.steps, agentFinished: false };
  }

  log({ kind: 'agent_limit', step: s.steps });
  return {
    ...(last || { text: '' }),
    text: `${last ? last.text : ''}\n\n[agent] Достигнут лимит ${limit} раундов. Задача не завершена.`,
    agentSteps: s.steps,
    agentFinished: false,
    agentLimitReached: true,
  };
}

module.exports = {
  AGENT_PREAMBLE, DEFAULT_MAX_STEPS, DEFAULT_MAX_OUTPUT, DEFAULT_CMD_TIMEOUT,
  parseReply, runCommand, feedbackFor, run, reset, stepsUsed,
};
