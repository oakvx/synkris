@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "ROOT_DIR=%CD%"

set "LOCAL_DATABASE_URL=postgresql://whatsapp_ai:change-me@127.0.0.1:5433/whatsapp_ai?schema=public"
set "LOCAL_API_URL=http://localhost:4000"
set "LOCAL_FRONTEND_URL=http://localhost:5173"
set "LOCAL_APP_BASE_URL=http://localhost:5173/#/login"
set "LOCAL_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:8091,http://127.0.0.1:8091"

echo.
echo ==========================================
echo   Synkris - Avvio ambiente locale
echo ==========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERRORE] Node.js non e' disponibile nel PATH.
  echo Installa Node.js 18.18+ e riprova.
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERRORE] npm non e' disponibile nel PATH.
  echo Installa Node.js 18.18+ e riprova.
  exit /b 1
)

if not exist ".env" (
  echo [INFO] File .env non trovato. Creo una copia da .env.example...
  copy /Y ".env.example" ".env" >nul
)

if not exist "node_modules" (
  echo [INFO] node_modules non trovato. Installo le dipendenze...
  set "PUPPETEER_SKIP_DOWNLOAD=1"
  call npm install
  if errorlevel 1 (
    echo [ERRORE] npm install ha fallito.
    exit /b 1
  )
) else (
  echo [OK] Dipendenze npm gia' presenti.
)

call :ensure_docker
if errorlevel 1 exit /b 1

echo [1/4] Avvio PostgreSQL via Docker Compose...
docker compose up -d postgres
if errorlevel 1 (
  echo [ERRORE] Impossibile avviare postgres con Docker Compose.
  exit /b 1
)

echo [2/4] Configuro l'ambiente locale per Prisma e i servizi Node...
set "DATABASE_URL=%LOCAL_DATABASE_URL%"
set "API_PORT=4000"
set "BOT_WORKER_PORT=4001"
set "BOT_WORKER_BASE_URL=http://localhost:4001"
set "VITE_API_BASE_URL=%LOCAL_API_URL%"
set "FRONTEND_BASE_PATH=/"
set "APP_BASE_URL=%LOCAL_APP_BASE_URL%"
set "ALLOWED_ORIGINS=%LOCAL_ALLOWED_ORIGINS%"
set "BOT_PROVIDER=open-wa"
set "BOT_HEADLESS=false"

echo [3/4] Genero Prisma Client...
call npm run db:generate
if errorlevel 1 (
  echo [ERRORE] npm run db:generate ha fallito.
  exit /b 1
)

echo [4/4] Applico le migrazioni esistenti...
call npm run db:migrate
if errorlevel 1 (
  echo [ERRORE] npm run db:migrate ha fallito.
  exit /b 1
)

echo [INFO] Apro una nuova finestra con frontend + API...
start "Synkris Portal Dev" cmd /k "cd /d ""%ROOT_DIR%"" && set DATABASE_URL=%LOCAL_DATABASE_URL%&& set API_PORT=4000&& set BOT_WORKER_PORT=4001&& set BOT_WORKER_BASE_URL=http://localhost:4001&& set VITE_API_BASE_URL=%LOCAL_API_URL%&& set FRONTEND_BASE_PATH=/&& set APP_BASE_URL=%LOCAL_APP_BASE_URL%&& set ALLOWED_ORIGINS=%LOCAL_ALLOWED_ORIGINS%&& set BOT_PROVIDER=open-wa&& set BOT_HEADLESS=false&& npm run dev:portal"
echo [INFO] Apro una seconda finestra con il bot worker stabile...
start "Synkris Bot Worker" cmd /k "cd /d ""%ROOT_DIR%"" && set DATABASE_URL=%LOCAL_DATABASE_URL%&& set API_PORT=4000&& set BOT_WORKER_PORT=4001&& set BOT_WORKER_BASE_URL=http://localhost:4001&& set APP_BASE_URL=%LOCAL_APP_BASE_URL%&& set ALLOWED_ORIGINS=%LOCAL_ALLOWED_ORIGINS%&& set BOT_PROVIDER=open-wa&& set BOT_HEADLESS=false&& set BOT_SESSION_DIR=%ROOT_DIR%\bot-sessions&& npm run build -w @whatsapp-ai/shared&& npm run build -w @whatsapp-ai/bot-worker&& node apps/bot-worker/dist/server.js"

echo.
echo Ambiente locale avviato.
echo.
echo URL principali:
echo - Frontend: %LOCAL_FRONTEND_URL%
echo - API:      %LOCAL_API_URL%
echo - Worker:   http://localhost:4001
echo - Postgres: 127.0.0.1:5433
echo.
echo La finestra "Synkris Portal Dev" contiene i log di frontend e API.
echo La finestra "Synkris Bot Worker" compila il worker e poi avvia node apps/bot-worker/dist/server.js.
echo Se vuoi fermare il database, usa: docker compose stop postgres
echo.
exit /b 0

:ensure_docker
docker info >nul 2>&1
if not errorlevel 1 (
  echo [OK] Docker Engine disponibile.
  exit /b 0
)

if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
  echo [INFO] Docker Engine non disponibile. Avvio Docker Desktop...
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  set /a DOCKER_WAIT_ATTEMPTS=0
) else (
  echo [ERRORE] Docker Desktop non trovato.
  echo Installa o avvia Docker Desktop e riprova.
  exit /b 1
)

:wait_for_docker
set /a DOCKER_WAIT_ATTEMPTS+=1
docker info >nul 2>&1
if not errorlevel 1 (
  echo [OK] Docker Engine disponibile.
  exit /b 0
)

if !DOCKER_WAIT_ATTEMPTS! GEQ 60 (
  echo [ERRORE] Docker non e' diventato disponibile in tempo utile.
  echo Verifica Docker Desktop e riprova.
  exit /b 1
)

echo [INFO] Attendo Docker... tentativo !DOCKER_WAIT_ATTEMPTS!/60
timeout /t 2 /nobreak >nul
goto :wait_for_docker
