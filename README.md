# ClaudeWebProxy

Локальный прокси и веб-интерфейс к **claude.ai** через вашу уже авторизованную сессию
браузера. Принимает запросы в формате **OpenAI Chat Completions**, **Anthropic Messages**
и **OpenAI Responses API**, а также даёт собственный чат с выбором модели и уровня
мышления.

Официальный API Anthropic (`api.anthropic.com`) **не используется**, API-ключ **не нужен**,
зависимостей npm **нет** — только стандартная библиотека Node.

```text
  ваш клиент (OpenAI/Anthropic)  ──┐
                                   ├──►  127.0.0.1:9656  ──►  вкладка claude.ai  ──►  Claude
  браузер: http://127.0.0.1:9656 ──┘
```

---

## ⚠️ Три предупреждения, которые нужно прочитать до запуска

> ### 1. Внутренние механизмы Claude Web нестабильны
> Прокси работает через внутренние endpoints веб-интерфейса, а не через публичный API.
> Anthropic может изменить endpoints, payloads, cookies или формат стрима в любой момент —
> после этого прокси перестанет работать, пока не будет обновлён `lib/claude.js`.
> Прокси **никогда не выдумывает успешный ответ**: при поломке формата вы получите
> ошибку `protocol_changed`, а не фальшивый текст.

> ### 2. `browser-profile/` и `claude-auth.json` — это пароль от аккаунта
> Профиль браузера содержит живую сессию Claude. Кто получил папку — получил ваш аккаунт.
> Никогда не коммитьте их, не отправляйте в мессенджеры и не выкладывайте в архивах.
> Оба уже в `.gitignore`.

> ### 3. Ответственность за соблюдение правил Anthropic — на вас
> Использование веб-интерфейса программным способом может нарушать Terms of Service
> Anthropic. Этот проект не является официальным клиентом, не связан с Anthropic и
> предоставляется «как есть», без гарантий. Прежде чем использовать его с реальным
> аккаунтом, ознакомьтесь с [условиями Anthropic](https://www.anthropic.com/legal/consumer-terms).

---

## Быстрый старт

**Нужно:** Node.js 22+ и Chromium-браузер (Chrome, Edge, Brave). Аккаунт Claude, который
открывается в браузере.

```cmd
git clone git@github.com:unreal-master-440/ClaudeWebProxy.git
cd ClaudeWebProxy
start.cmd
```

Всё. `start.cmd` сам создаст `.env`, проверит окружение, поднимет сервер, откроет окно
Chrome и страницу интерфейса.

Затем:

1. В открывшемся окне Chrome **войдите в Claude** (один раз — профиль запоминает вход).
2. Откройте **http://127.0.0.1:9656/** — это интерфейс.
3. Окно терминала не закрывайте: сервер работает, пока оно открыто.

### Запуск без батника

```cmd
node server.js
```

---

## Что вы получите

### Веб-интерфейс — `http://127.0.0.1:9656/`

- Выбор модели (доступные подсвечены, недоступные в вашем плане — серые с пометкой).
- Выбор уровня мышления: `Выключено / Обычное / Авто / Расширенное`.
- Потоковый вывод по мере генерации, счётчик времени ответа.
- Индикатор состояния: транспорт, прокси, число доступных моделей.
- Кнопка «Очистить» начинает новую беседу.

### HTTP API

| Метод | Путь | Формат |
|---|---|---|
| GET | `/health` | состояние, транспорт, прокси |
| GET | `/v1/models` | список моделей (OpenAI-формат) |
| POST | `/v1/chat/completions` | OpenAI Chat Completions, stream и не-stream |
| POST | `/v1/messages` | Anthropic Messages, stream и не-stream |
| POST | `/v1/responses` | OpenAI Responses API, stream и не-stream |
| GET | `/` | веб-интерфейс |
| GET | `/api/ui/status` | модели и уровни мышления для интерфейса |
| POST | `/api/ui/chat` | чат интерфейса (SSE) |

```cmd
curl.exe -X POST http://127.0.0.1:9656/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"claude-sonnet\",\"messages\":[{\"role\":\"user\",\"content\":\"Привет\"}]}"
```

---

## Модели и уровни мышления

Список моделей **не выдуман** — доступность проверена живыми запросами к claude.ai:

| ID для клиента | Модель Claude Web | Доступность |
|---|---|---|
| `claude-sonnet` | `claude-sonnet-4-6` | работает |
| `claude-haiku` | `claude-haiku-4-5-20251001` | работает |
| `claude-opus` | `claude-opus-4-6` | `403` — нужен платный тариф |

Модели, недоступные в вашем плане, показываются в интерфейсе серыми: вы видите разницу
между «нет в прокси» и «нет в подписке».

**Уровни мышления.** Допустимые значения поля `thinking_mode` получены из ответа самого
сервера на заведомо неверное значение: `Input should be 'extended', 'standard', 'auto' or 'off'`.

| Уровень | Что делает |
|---|---|
| `off` | без рассуждений, быстрее всего |
| `standard` | стандартный режим Claude |
| `auto` | Claude сам решает, думать ли |
| `extended` | развёрнутые рассуждения, медленнее |

Проверено: `extended` меняет ответ (более подробная цепочка рассуждений в самом тексте).
**Важно:** отдельный блок `thinking_delta` в стриме для этого аккаунта не приходит —
меняется стиль ответа, а не появляется скрытое «рассуждение». Интерфейс умеет показывать
такой блок, если он придёт.

В API уровень передаётся так:

```json
{
  "model": "claude-sonnet",
  "thinking": "extended",
  "messages": [{"role": "user", "content": "..."}]
}
```

Для OpenAI/Anthropic-совместимых клиентов поле необязательное, по умолчанию `standard`.

---

## Настройка `.env`

`start.cmd` создаёт файл из `.env.example`. Минимально нужны эти строки:

```env
HOST=127.0.0.1
PORT=9656
USE_BROWSER_TRANSPORT=1
CDP_PORT=9222
HTTPS_PROXY=
NO_PROXY=127.0.0.1,localhost
```

| Переменная | Смысл |
|---|---|
| `USE_BROWSER_TRANSPORT` | `1` — запросы идут из вкладки браузера (нужно для Cloudflare). `0` — напрямую из Node |
| `CDP_PORT` | порт отладки браузера |
| `HTTPS_PROXY` | прокси, если VPN работает как System Proxy (Hiddify, Clash, v2ray) |
| `CHROME_PATH` | путь к браузеру, если автоопределение не сработало |
| `BROWSER` | имя браузера (`chrome`, `edge`, `brave`) |
| `REQUEST_TIMEOUT_MS` | таймаут одного запроса к Claude |
| `SESSION_TTL_MS` | время жизни сессии диалога в памяти |

---

## Почему режим браузера

Cloudflare на claude.ai пропускает обычный браузер, но отвечает Node-клиенту
`403 Just a moment…` — разница в TLS/JS-отпечатке. Поэтому запросы выполняются **внутри
страницы** claude.ai через Chrome DevTools Protocol: у вкладки настоящий отпечаток браузера
и уже пройденный челлендж.

```text
USE_BROWSER_TRANSPORT=1  →  fetch() внутри вкладки claude.ai  →  работает
USE_BROWSER_TRANSPORT=0  →  https.request() из Node          →  403 Just a moment…
```

Обход Cloudflare (подмена отпечатка, решение капчи) **не реализуется** — это против правил
сервиса. Используется только штатная авторизованная вкладка.

### Прокси и VPN

Node и `curl` не используют прокси браузера. Если VPN включён как System Proxy,
пропишите его в `.env`:

```env
HTTPS_PROXY=http://127.0.0.1:12334
```

Прокси сделает `CONNECT`-туннель (`proxyFor()` в `lib/claude.js`). Проверка, что через
него видно не заблокированную страну:

```cmd
curl.exe -s -x http://127.0.0.1:12334 "http://ip-api.com/json/?fields=country"
```

---

## Структура проекта

```text
ClaudeWebProxy/
├── start.cmd               запуск одним файлом (Windows)
├── server.js               HTTP-сервер, маршруты, GUI-эндпоинты
├── public/
│   └── index.html          веб-интерфейс (один файл, без сборки)
├── lib/
│   ├── env.js              чтение .env, прокси в process.env
│   ├── logger.js           логи без секретов
│   ├── errors.js           типы ошибок, преобразование в формат OpenAI/Anthropic
│   ├── models.js           каталог моделей и уровней мышления
│   ├── protocols.js        разбор входящих запросов трёх форматов
│   ├── stream.js           SSE-парсер ответов Claude
│   ├── sessions.js         сессии в памяти, TTL
│   └── claude.js           транспорт к claude.ai (Node и браузер), payload
├── scripts/
│   ├── claude_auth.js      вход в аккаунт, сбор capture при поломке формата
│   ├── setup_codex.js      конфиг для Codex CLI
│   └── test.js             7 автотестов всех маршрутов
├── .env.example
├── auth.example.json
└── README.md
```

Слои разделены: `protocols.js` (форматы клиентов) → `models.js` (мэппинг моделей) →
`claude.js` (транспорт). При изменении протокола Claude правится один файл.

---

## Тесты

```cmd
node server.js --test
```

```text
  PASS  GET /health
  PASS  GET /v1/models
  PASS  POST /v1/chat/completions
  PASS  POST /v1/chat/completions stream=true — SSE + [DONE]
  PASS  POST /v1/messages
  PASS  POST /v1/messages stream=true — message_start … message_stop
  PASS  POST /v1/responses
  PASS  POST /v1/responses stream=true
[TEST] ALL PASSED
```

Тесты не имитируют успех: если Claude недоступен, вы увидите реальную причину
(`region_unavailable`, `Just a moment…`, `не авторизован`).

---

## Подключение клиентов

**Open WebUI:** Admin Panel → Settings → Connections → OpenAI API

```text
Base URL: http://127.0.0.1:9656/v1
API Key:  local
```

**Codex CLI:**

```cmd
node scripts/setup_codex.js
```

**Cline / Cursor / Aider:** provider `OpenAI Compatible`, Base URL
`http://127.0.0.1:9656/v1`, API Key `local`, Model `claude-sonnet`.

---

## Ошибки

| Тип | Значение |
|---|---|
| `auth_error` | нет авторизации в браузере или Claude отклонил сессию |
| `network_error` | нет связи, Cloudflare-челлендж, прокси недоступен |
| `claude_error` | Claude вернул ошибку по существу запроса |
| `invalid_request` | некорректный запрос клиента |
| `unsupported_model` | модель не настроена или недоступна в плане |
| `rate_limit` | превышен лимит |
| `timeout` | Claude не ответил за `REQUEST_TIMEOUT_MS` |
| `protocol_changed` | формат Claude Web изменился, нужен апдейт `lib/claude.js` |
| `internal_error` | прочее |

При `protocol_changed` соберите актуальный формат:

```cmd
node scripts/claude_auth.js --capture
```

Отправьте одно сообщение в открывшемся браузере, нажмите `Ctrl+C` — появится
`captures/capture-*.json` с методом, URL и телом запроса (cookie и токены не пишутся).

---

## Ограничения

- **Нет tool calling** — агентные сценарии (правка файлов, вызов инструментов) не работают.
- `max_tokens`, `temperature`, `top_p`, `stop` **игнорируются** — веб-эндпоинт их не принимает.
- `usage` **оценивается** как `длина / 4`, а не берётся у Claude.
- История диалога передаётся текстом в один prompt, а не как структурированные ходы.
- Сессии хранятся **в памяти**: перезапуск сервера начинает новые беседы.
- Один аккаунт Claude на один запущенный прокси.
- `thinking_delta` в стриме не приходит — уровень мышления меняет стиль ответа.

---

## Безопасность

Никогда не коммитится (уже в `.gitignore`):

```text
.env
claude-auth.json
browser-profile/
captures/
*.log
```

В логах нет `Cookie`, `Authorization`, `sessionKey`, CSRF-токенов и содержимого профиля —
`logger.js` и `errors.js` вычищают их из ошибок и заголовков.

Сервер слушает только `127.0.0.1` и не доступен из сети, если не изменить `HOST`.

---

## Лицензия

MIT — см. [LICENSE](LICENSE). Проект не связан с Anthropic. «Claude» — товарный знак
Anthropic, PBC; используется только для описания совместимости.
