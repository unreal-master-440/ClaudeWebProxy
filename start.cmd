@echo off
chcp 866 >nul 2>&1
setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM ============================================================
REM  ClaudeWebProxy - запуск одним файлом
REM  Двойной клик по этому файлу или: start.cmd
REM
REM  Файл в кодировке CP866: так cmd на любой Windows показывает
REM  русский текст правильно. Не пересохраняйте start.cmd в UTF-8
REM  без обратного преобразования - буквы превратятся в кракозябры.
REM ============================================================

set "PORT=9656"
set "CDP=9222"
set "VPN_PORT=12334"

echo.
echo ============================================================
echo   ClaudeWebProxy
echo ============================================================
echo.

REM ---------- 1. Node ----------
echo [1/6] Node.js...
where node >nul 2>&1
if errorlevel 1 (
  echo       [ОШИБКА] Node.js не найден.
  echo       Установите Node 22+ с https://nodejs.org и запустите снова.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NV=%%v"
for /f "tokens=1 delims=." %%a in ("!NV:v=!") do set "MAJOR=%%a"
echo       Node !NV!
if !MAJOR! LSS 22 (
  echo       [ВНИМАНИЕ] Нужен Node 22+. На старом Node не работает режим браузера.
)

REM ---------- 2. .env ----------
echo.
echo [2/6] Файл настроек .env...
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo       создан из .env.example
  ) else (
    echo       [ОШИБКА] нет ни .env, ни .env.example
    pause
    exit /b 1
  )
) else (
  echo       на месте
)

REM ---------- 3. VPN ----------
echo.
echo [3/6] VPN-прокси на порту %VPN_PORT%...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %VPN_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo       [ВНИМАНИЕ] порт %VPN_PORT% не слушает.
  echo       Включите System Proxy в Hiddify, иначе Claude ответит region_unavailable.
  echo       Продолжаю запуск - ошибка будет видна в интерфейсе.
) else (
  for /f "delims=" %%c in ('curl.exe -s --max-time 10 -x http://127.0.0.1:%VPN_PORT% "http://ip-api.com/json/?fields=country" 2^>nul') do set "CTRY=%%c"
  echo       работает !CTRY!
)

REM ---------- 4. порты ----------
echo.
echo [4/6] Освобождение портов %PORT% и %CDP%...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select -First 1 OwningProcess | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }" >nul 2>&1
echo       порт %PORT% свободен

REM ---------- 5. запуск ----------
echo.
echo [5/6] Запуск сервера...
echo.
echo ============================================================
echo   Интерфейс:  http://127.0.0.1:%PORT%/
echo   API:        http://127.0.0.1:%PORT%/v1
echo.
echo   Откроется окно Chrome - если попросит, войдите в Claude.
echo   ЭТО ОКНО НЕ ЗАКРЫВАТЬ. Остановка: Ctrl+C
echo ============================================================
echo.

start "" /min cmd /c "timeout /t 7 /nobreak >nul & start http://127.0.0.1:%PORT%/"

node server.js

set "RC=%ERRORLEVEL%"
echo.
echo Сервер остановлен (код %RC%).
echo Профиль браузера сохранён в папке browser-profile - вход в Claude сохранится.
echo.
pause
endlocal
