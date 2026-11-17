# Пошаговая инструкция: ClaudeWebProxy с нуля до рабочего запроса

Папка проекта: `C:\Users\artoy\projects\claude\ClaudeWebProxy`
Все команды ниже выполняются в этой папке.

---

## Шаг 0. Что должно быть готово

| Что | Как проверить | Что нужно |
|---|---|---|
| Node.js | `node -v` | 18+ (для авторизации — 22+) |
| Браузер | — | Chrome, Edge, Brave или Chromium |
| Аккаунт Claude | — | вход в claude.ai работает в обычном браузере |
| Сеть | `curl.exe -s -o NUL -w "%{http_code}" https://claude.ai/api/organizations` | не `403` с `region_unavailable` |

Проверка сети — **самый важный шаг**. Если команда вернула `403`, дальше идти нет смысла:
claude.ai блокирует страну, прокси физически не сможет работать.

```cmd
curl.exe -s https://claude.ai/api/organizations
```

- `403` + `"error_code":"region_unavailable"` → нужен сетевой выход в поддерживаемую страну (см. Шаг 4a).
- HTML с `<title>Just a moment...</title>` → Cloudflare-челлендж, см. Шаг 4a (`USE_BROWSER_TRANSPORT=1`).
- `401` / `[]` / JSON со списком → всё в порядке, идём дальше.

---

## Шаг 1. Перейти в папку

**Windows CMD:**

```cmd
cd /d C:\Users\artoy\projects\claude\ClaudeWebProxy
```

**Windows PowerShell:**

```powershell
cd C:\Users\artoy\projects\claude\ClaudeWebProxy
```

---

## Шаг 2. Проверить, что файлы на месте

```cmd
dir /b
```

Должно быть видно:

```text
.env
.env.example
.gitignore
README.md
auth.example.json
lib
package.json
scripts
server.js
```

Файла `.env` уже создан. Если его нет — `copy .env.example .env`.

---

## Шаг 3. Проверить синтаксис (30 секунд, ловит опечатки)

```cmd
node --check server.js
```

Ничего не вывело — хорошо. Если вывело `SyntaxError` — файл повреждён.

---

## Шаг 4. Авторизация в Claude

```cmd
node scripts/claude_auth.js
```

Что произойдёт:

1. Скрипт найдёт Chrome/Edge и напишет `[INFO] Browser: ...`
2. Откроется окно браузера с **отдельным профилем** `browser-profile/`
3. Откроется `https://claude.ai`

**Что делать вам:** войти в аккаунт Claude в этом окне. Когда откроется чат — ничего
нажимать не нужно, скрипт сам заметит cookie `sessionKey` и сохранит сессию.

**Что вы увидите:**

```text
[INFO] Waiting for CDP page target…
[INFO] Page target: https://claude.ai/...
[INFO] Session saved to claude-auth.json (не коммитьте этот файл!)
[INFO] Closing browser (own process only).
```

**Проверка результата:**

```cmd
dir claude-auth.json
```

Файл есть → авторизация удалась.

### Если на этом шаге что-то пошло не так

| Сообщение | Причина | Что делать |
|---|---|---|
| `Chromium-based browser not found` | браузер не найден | добавьте в `.env` строку `CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe` |
| `CDP page target not found within timeout` | браузер не поднялся или порт занят | закройте все Chrome, поменяйте в `.env` `CDP_PORT=9223`, повторите |
| `Authentication not completed within timeout` | 5 минут истекли без входа | запустите снова и войдите быстрее |
| `This Node has no global WebSocket` | Node старше 22 | поставьте Node 22+ |
| Окно открылось, но страница «App unavailable in region» | блокировка региона | см. Шаг 0, нужен другой сетевой выход |

Повторная авторизация: удалите `claude-auth.json` (и при смене аккаунта ещё `browser-profile/`)
и запустите скрипт снова.

---

## Шаг 4a. Режим браузера (решение против Cloudflare)

Cloudflare отвечает Node-клиенту `403 Just a moment…`, поэтому запросы выполняются
**внутри вкладки claude.ai**, где челлендж уже пройден. Как в GeminiWebProxy: при старте
сервер сам открывает окно браузера, вы один раз входите.

В `.env`:

```env
USE_BROWSER_TRANSPORT=1
CDP_PORT=9222
```

Затем `node server.js`. В логе появится:

```text
[INFO] Browser window opened for Claude login {"url":"https://claude.ai/new","cdpPort":9222}
[INFO] Log in to Claude in the opened browser window; requests will use that page.
```

Войдите в открывшемся окне. Файл `claude-auth.json` в этом режиме **не нужен** —
cookie и CSRF берутся из вкладки.

Проверка, что вкладка авторизована:

```cmd
node -e "const{BrowserTransport}=require('./lib/claude');const b=new BrowserTransport({cdpPort:9222,timeoutMs:30000});b.fetchInPage('GET','/api/organizations').then(r=>{console.log(r.status,r.text.slice(0,80));b.close()})"
```

- `200` со списком организаций → всё работает.
- `403 Invalid authorization` → вы ещё не вошли в окне.

Проверка через сам прокси:

```cmd
curl.exe -X POST http://127.0.0.1:9656/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"claude-sonnet\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

---

## Шаг 4b. Сетевой выход (нужен, если VPN включён как System Proxy)

Обычный `curl.exe` и Node **не используют** прокси браузера. Если VPN включён как
System Proxy (Hiddify, Clash, v2ray), Node пойдёт напрямую через провайдера и получит
`region_unavailable` или Cloudflare-челлендж.

**Проверка, что прокси поднят:**

```cmd
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 12334 -State Listen | Select LocalAddress,LocalPort"
```

**Проверка, что через него видно другую страну:**

```cmd
curl.exe -s -x http://127.0.0.1:12334 "http://ip-api.com/json/?fields=country,query"
```

Должна быть не `Belarus`. Затем в `.env`:

```env
HTTPS_PROXY=http://127.0.0.1:12334
NO_PROXY=127.0.0.1,localhost
```

Прокси читает эти значения сам (`proxyFor()` в `lib/claude.js`) и делает CONNECT-туннель.

**Если после прокси claude.ai отвечает HTML `<title>Just a moment...</title>`** — это
Cloudflare-челлендж, который Node не решает. Тогда:

```env
USE_BROWSER_TRANSPORT=1
CDP_PORT=9222
```

и запускайте браузер через `node scripts/claude_auth.js` — прокси будет выполнять
запросы внутри авторизованной вкладки (`BrowserTransport` в `lib/claude.js`).

---

## Шаг 5. Проверить содержимое сессии (без показа секретов)

```cmd
node -e "const a=require('./claude-auth.json');console.log('sessionKey:','sk-ant-***'+(a.sessionKey||'').slice(-4));console.log('org:',a.organizationId||a.lastActiveOrg||'нет');console.log('модели:',Object.keys(a.models).join(', '))"
```

Ожидаемо:

```text
sessionKey: sk-ant-***abcd
org: 1234abcd-....
модели: claude-sonnet, claude-opus, claude-haiku
```

Если `org: нет` — прокси получит её сам при первом запросе, это не ошибка.

**Если список моделей не совпадает с тем, что вам доступно** — откройте `claude-auth.json`
в блокноте и поправьте блок `models`, например:

```json
"models": {
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus": "claude-opus-4-6",
  "claude-haiku": "claude-haiku-4-5-20251001"
}
```

Ключ слева — то, что будете указывать в запросах. Значение справа — внутреннее имя модели
Claude Web. Прокси обещает только то, что здесь написано.

---

## Шаг 6. Запустить прокси

```cmd
node server.js
```

Ожидаемый вывод:

```text
[INFO] Claude auth loaded
[INFO] ClaudeWebProxy started
[INFO] Listening on http://127.0.0.1:9656
```

**Это окно не закрывать** — сервер работает, пока оно открыто.

---

## Шаг 7. Открыть второе окно терминала

```cmd
cd /d C:\Users\artoy\projects\claude\ClaudeWebProxy
```

Все команды дальше — здесь.

---

## Шаг 8. Проверить, что прокси живой

```cmd
curl.exe http://127.0.0.1:9656/health
```

Ожидаемо (одной строкой):

```json
{"status":"ok","proxy":"ClaudeWebProxy","version":"0.1.0","auth":{"ok":true,"organization":true},"models":["claude-sonnet","claude-opus","claude-haiku"],"transport":"node-https"}
```

Ключевое: `"auth":{"ok":true}`.

---

## Шаг 9. Проверить список моделей

```cmd
curl.exe http://127.0.0.1:9656/v1/models
```

---

## Шаг 10. Первый настоящий запрос (без стрима)

```cmd
curl.exe -X POST http://127.0.0.1:9656/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"claude-sonnet\",\"messages\":[{\"role\":\"user\",\"content\":\"Ответь одним словом: работает?\"}]}"
```

Ожидаемо: JSON с `"choices":[{"message":{"content":"..."}}]`.

В окне с сервером при этом появятся:

```text
[INFO] Request POST /v1/chat/completions {"model":"claude-sonnet","stream":false}
[INFO] Claude conversation created
[INFO] Claude stream started
[INFO] Claude stream completed {"chars":9,"thinkingChars":0}
```

---

## Шаг 11. Проверить стриминг

```cmd
curl.exe -N -X POST http://127.0.0.1:9656/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"claude-sonnet\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Напиши 3 слова\"}]}"
```

`-N` обязателен, иначе curl буферизует и вы не увидите поток.

Ожидаемо: чанки `chat.completion.chunk` по мере генерации, в конце
`"finish_reason":"stop"` и строка `data: [DONE]`.

---

## Шаг 12. Проверить Anthropic-протокол

```cmd
curl.exe -N -X POST http://127.0.0.1:9656/v1/messages -H "Content-Type: application/json" -d "{\"model\":\"claude-sonnet\",\"max_tokens\":1024,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Привет\"}]}"
```

Ожидаемая последовательность: `message_start` → `content_block_start` →
несколько `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`.

---

## Шаг 13. Проверить Responses API

```cmd
curl.exe -X POST http://127.0.0.1:9656/v1/responses -H "Content-Type: application/json" -d "{\"model\":\"claude-sonnet\",\"input\":\"Привет\"}"
```

Ожидаемо: `"object":"response"`, `"status":"completed"`.

---

## Шаг 14. Полный автотест одной командой

```cmd
node server.js --test
```

Ожидаемо в конце:

```text
[TEST] ALL PASSED
```

Если какие-то пункты `FAIL` — рядом печатается реальная причина (например
`claude.ai rejects this network region`). Это и есть нормальный режим диагностики:
прокси не выдумывает успешный ответ.

---

## Шаг 15. Подключить свой клиент

### Open WebUI (самый совместимый вариант)

Admin Panel → Settings → Connections → OpenAI API:

- Base URL: `http://127.0.0.1:9656/v1`
- API Key: `local`

Модели подтянутся сами.

### Codex CLI

```cmd
node scripts/setup_codex.js
```

Скопируйте напечатанный блок в `%USERPROFILE%\.codex\config.toml`, затем:

```cmd
set CLAUDE_WEB_PROXY_KEY=local
```

### Cline / Cursor / Aider

- Provider: OpenAI Compatible
- Base URL: `http://127.0.0.1:9656/v1`
- API Key: `local`
- Model: `claude-sonnet`

Ограничение, о котором надо знать заранее: у web-эндпоинта **нет tool calling**, поэтому
агентные сценарии (правка файлов, вызов инструментов) работать не будут — только чат.

---

## Шаг 16. Что делать, когда Claude Web изменился

Симптом в логе:

```text
[ERROR] Claude request failed: Claude Web protocol appears to have changed.
        Please inspect lib/claude.js / lib/stream.js.
```

Порядок:

1. Собрать актуальный формат запроса:

   ```cmd
   node scripts/claude_auth.js --capture
   ```

2. В открывшемся браузере отправить одно сообщение в чате Claude.
3. Вернуться в терминал, нажать `Ctrl+C`.
4. Появится файл `captures\capture-*.json` — в нём метод, URL и тело запроса
   (cookie и Authorization не пишутся).
5. По этому файлу правится `buildPayload()` в `lib/claude.js` либо парсер в `lib/stream.js`.

---

## Шаг 17. Остановка и безопасность

Остановить прокси: `Ctrl+C` в окне сервера.

Никогда не коммитить и никому не передавать:

```text
claude-auth.json
browser-profile\
captures\
.env
```

Все четыре уже в `.gitignore`. `claude-auth.json` даёт полный доступ к аккаунту —
обращайтесь с ним как с паролем.

---

## Быстрая шпаргалка

```text
cd /d C:\Users\artoy\projects\claude\ClaudeWebProxy
node scripts/claude_auth.js        :: 1. вход в аккаунт
node server.js                     :: 2. запуск (окно не закрывать)
node server.js --test              :: 3. проверка всех 7 маршрутов (в другом окне)
```
