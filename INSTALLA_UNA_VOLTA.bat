@echo off
cd /d "%~dp0"
if not exist "%~dp0strumenti\installa.ps1" (echo Prima estrai TUTTO lo ZIP in una cartella locale. Non avviare i file dentro lo ZIP. & pause & exit /b 1)
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0strumenti\installa.ps1" -Menu
if errorlevel 1 (echo Operazione NON completata. Contatta il tecnico. & pause & exit /b 1)
pause
exit /b 0
