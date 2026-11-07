@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0strumenti\riattiva-calendar.ps1"
pause
