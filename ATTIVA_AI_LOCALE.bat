@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0strumenti\attiva-ai.ps1"
if errorlevel 1 (echo Attivazione AI non completata.)
pause
