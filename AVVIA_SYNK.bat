@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0strumenti\avvia.ps1"
if errorlevel 1 (echo Avvio NON completato. Usa INSTALLA_UNA_VOLTA per configurazione e diagnostica. & pause & exit /b 1)
exit /b 0
