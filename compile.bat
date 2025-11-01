@echo off
setlocal ENABLEEXTENSIONS ENABLEDELAYEDEXPANSION
title Build -> esbuild (CJS) -> pkg (EXE)

REM ===== CONFIG =====
set "PKG_TARGET=node18-win-x64"
set "OUT_BASENAME=whatsapp-ai"
set "ROOT=%~dp0"
cd /d "%ROOT%"
set "DIST=%ROOT%dist"
set "OUT_EXE=%DIST%\%OUT_BASENAME%.exe"

echo [prep] Pulizia dist...
if exist "%DIST%" rmdir /s /q "%DIST%"
mkdir "%DIST%" || (echo [ERR] impossibile creare dist & exit /b 1)

echo [entry] Individuazione entrypoint...
set "ENTRY="
for %%F in ("src\index.js" "src\index.mjs" "index.js" "index.mjs" "lib\index.js") do (
  if exist "%%~fF" (
    set "ENTRY=%%~fF"
    goto :found_entry
  )
)
:found_entry
if not defined ENTRY (
  echo [ERR] Nessun entrypoint trovato (src\index.js / index.js / ecc.).
  exit /b 1
)
echo [INFO] ENTRY=%ENTRY%

echo [bundle] esbuild -> dist\app.cjs ...
node "%ROOT%node_modules\esbuild\bin\esbuild" "%ENTRY%" ^
  --bundle --platform=node --format=cjs --target=node18 ^
  --outfile="%DIST%\app.cjs" ^
  --external:unix-dgram ^
  --external:puppeteer/package.json --external:puppeteer-core/package.json ^
  --log-level=info
if errorlevel 1 (
  echo [ERR] Bundle fallito
  exit /b 1
)

echo [loader] Creo dist\pkg-loader.cjs ...
> "%DIST%\pkg-loader.cjs" (
  echo // Minimal loader per pkg: risolve percorso accanto all'EXE e avvia app.cjs
  echo const path = require('path');
  echo const isPkg = !!process.pkg;
  echo const base = isPkg ? path.dirname(process.execPath) : __dirname;
  echo try { process.chdir(base); } catch {}
  echo console.log('^[[loader]^] launch', { entry: path.join(base,'app.cjs') });
  echo require(path.join(base,'app.cjs'));
)

echo [pkg] Impacchetto EXE ...
npx pkg -t %PKG_TARGET% -o "%OUT_EXE" "%DIST%\pkg-loader.cjs" ^
  --assets "%DIST%\app.cjs"
if errorlevel 1 (
  echo [ERR] pkg fallito
  exit /b 1
)

echo [OK] Creato: %OUT_EXE%
echo [HINT] Tieni JSON e license accanto all'EXE. Nessun JSON ^(config, messaggi, appuntamenti^) ^e' incluso dentro l'eseguibile.
exit /b 0
