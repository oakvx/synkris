@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0strumenti\ripristina.ps1"
if errorlevel 1 (echo Ripristino NON completato. Contatta il tecnico.)
pause
