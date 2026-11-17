'use strict';
/**
 * Печатает готовый блок конфигурации для Codex CLI / OpenAI-совместимых клиентов.
 * Пишет в ~/.codex/config.toml только с флагом --write и только если блока ещё нет.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEnv, num } = require('../lib/env');

const ROOT = path.join(__dirname, '..');
const env = loadEnv(ROOT);
const port = num(env.PORT, 9656);
const baseUrl = `http://127.0.0.1:${port}/v1`;

const snippet = `# --- Codex CLI (~/.codex/config.toml) ---
model_provider = "claude-web-proxy"
model = "claude-sonnet"

[model_providers.claude-web-proxy]
name = "ClaudeWebProxy"
base_url = "${baseUrl}"
env_key = "CLAUDE_WEB_PROXY_KEY"
wire_api = "responses"

# --- Переменные окружения ---
# Windows CMD:        set CLAUDE_WEB_PROXY_KEY=local
# Windows PowerShell: $env:CLAUDE_WEB_PROXY_KEY="local"
# Linux / macOS:      export CLAUDE_WEB_PROXY_KEY=local
`;

console.log(snippet);

if (process.argv.includes('--write')) {
  const target = path.join(os.homedir(), '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (existing.includes('[model_providers.claude-web-proxy]')) {
    console.log(`[INFO] ${target} already contains claude-web-proxy; not modified.`);
  } else {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(target, sep + '\n' + snippet);
    console.log(`[INFO] Appended to ${target}`);
  }
}
