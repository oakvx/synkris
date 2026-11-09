@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0strumenti\avvio.ps1" (echo Prima estrai TUTTO lo ZIP in una cartella locale. & pause & exit /b 1)
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0strumenti\avvio.ps1" -Run
if errorlevel 1 (echo Avvio NON completato. Usa INSTALLA_SYNK per configurazione e diagnostica. & pause & exit /b 1)
exit /b 0
