@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0strumenti\esporta-backup.ps1"
if errorlevel 1 (echo Operazione NON completata. Contatta il tecnico. & pause & exit /b 1)
pause
exit /b 0
