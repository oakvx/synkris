@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0strumenti\aggiorna.ps1"
if errorlevel 1 (echo Aggiornamento incompleto. Chiamare il tecnico.)
pause
