@echo off
cd /d "%~dp0"
if not exist "%~dp0strumenti\avvia.ps1" (echo Prima estrai TUTTO lo ZIP in una cartella locale. & pause & exit /b 1)
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0strumenti\avvia.ps1"
if errorlevel 1 (echo Avvio NON completato. Usa INSTALLA_UNA_VOLTA per configurazione e diagnostica. & pause & exit /b 1)
exit /b 0
