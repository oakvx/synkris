@echo off
setlocal
cd /d "%~dp0" || exit /b 1
if not exist "%~dp0strumenti\installa.ps1" (
  echo Prima estrai TUTTO lo ZIP in una cartella locale. Non avviare il file dentro lo ZIP.
  pause
  exit /b 1
)
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0strumenti\installa.ps1" -Menu
if errorlevel 1 (
  echo Installazione o operazione NON completata. Usa la diagnostica oppure contatta il tecnico.
  pause
  exit /b 1
)
pause
exit /b 0
