@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0strumenti\installa.ps1"
if errorlevel 1 (echo Installazione incompleta. & pause & exit /b 1)
echo Installazione completata.
pause
