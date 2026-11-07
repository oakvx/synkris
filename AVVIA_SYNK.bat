@echo off
cd /d "%~dp0"
where docker >nul 2>&1 || (echo Docker Desktop non installato. & pause & exit /b 1)
docker compose up -d
if errorlevel 1 (echo Avvio non riuscito. Contatta il tecnico. & pause & exit /b 1)
start "" "http://127.0.0.1:8080"
