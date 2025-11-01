  @echo off
    setlocal EnableExtensions

    cd /d "%~dp0"

    echo [1/5] Pulizia leftovers...
    taskkill /IM whatsapp-ai.exe /F 2>nul
    del /q "dist\whatsapp-ai.exe" "dist\whatsapp-ai-patch.exe" 2>nul

    echo [2/5] Bundle CJS senza wa-automate/puppeteer...
    npx esbuild index.js --bundle --platform=node --format=cjs --target=node22 --outfile="dist\app.cjs" --sourcemap=inline --log-level=info --external:@open-wa/wa-automate --external:puppeteer --external:puppeteer-core --external:puppeteer/package.json --external:unix-dgram
    if errorlevel 1  echo [ERR] esbuild fallito 

    echo [3/5] Installa moduli esterni accanto all'EXE skip Chromium)...
    set PUPPETEER_SKIP_DOWNLOAD=1
    call npm i --no-save --prefix dist @open-wa/wa-automate puppeteer
    if errorlevel 1  echo [ERR] npm install fallito 

    echo [4/5] Genero SEA blob...
    if not exist "dist\sea" mkdir "dist\sea"
    >"dist\sea\sea-config.json" echo { "main": "dist/app.cjs", "output": "dist/sea/sea.blob" }
    node --experimental-sea-config "dist\sea\sea-config.json"
    if errorlevel 1  echo [ERR] SEA blob non creato 
    if not exist "dist\sea\sea.blob"  echo [ERR] manca dist\sea\sea.blob 

    echo [5/5] Inietto blob e creo EXE...
    for /f "delims=" %%N in 'node -p "process.execPath"') do copy "%%N" "dist\whatsapp-ai-patch.exe" /y >nul
    npx postject "dist\whatsapp-ai-patch.exe" NODE_SEA_BLOB "dist\sea\sea.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
    if errorlevel 1  echo [ERR] postject fallito 
    move /y "dist\whatsapp-ai-patch.exe" "dist\whatsapp-ai.exe" >nul

    echo.
    echo [OK] Pronto. Per avviare:
    echo   set PUPPETEER_SKIP_DOWNLOAD=1
    echo   set "PUPPETEER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
    echo   dist\whatsapp-ai.exe
    echo.
    exit /b 0
