WHATSAPP-AI BUILD KIT — Windows
===============================

Obiettivo: ottenere un .EXE unico con codice nascosto (bytecode V8) partendo da un progetto Node nella ROOT.
Due metodi inclusi:
  1) build-sfx.bat  -> EXE auto-estraente (7-Zip SFX) + bytenode [consigliato: parte sempre]
  2) build-pkg.bat  -> EXE monolitico con pkg + bytenode (assicurati di avere il target giusto)

Requisiti comuni
----------------
- Avvia *CMD* nella ROOT del tuo progetto (quella dove sta `index.js`).
- Node.js 18.x installato (consigliato 18.20.x).
- `npm` funzionante.
- Nel tuo progetto devono esserci le `node_modules` delle dipendenze che usi a runtime (es. puppeteer, @open-wa, ecc.).

Metodo 1 — SFX 7-Zip + bytenode (consigliato)
---------------------------------------------
1) Copia **questo kit** nella ROOT del TUO progetto (affianca i tuoi sorgenti: `index.js`, `package.json`, ecc.).
2) Assicurati di avere **7-Zip** installato e `7z.exe` nel PATH (o in "C:\Program Files\7-Zip").
3) In CMD (ROOT progetto), lancia:
       build-sfx.bat
   - Entry di default: `index.js`. Se diverso, passa il path: `build-sfx.bat src\main.js`
4) Output:
   - `whatsapp-ai.exe` nella ROOT (unico file).
   - Si auto-estrae in `%TEMP%\whatsapp-ai` e parte.
   - Il sorgente è nascosto in `app.jsc` (bytecode V8).

Note SFX:
- Vuoi che giri su PC *senza Node installato*? Metti un `node.exe` portabile nella cartella `app\` (stessa major di Node con cui compili `.jsc`, es. 18.x).
- Se usi Puppeteer/@open-wa, puoi includere `node_modules\puppeteer` (pesante) per evitare download a runtime.
- I file `.env`, `bookings.json`, `config.json`, `assets\` (se necessari) vanno copiati in `app\` (lo script lo fa automaticamente se esistono in root).

Metodo 2 — pkg + bytenode (monolitico)
--------------------------------------
1) In CMD (ROOT), lancia:
       build-pkg.bat
   - Entry di default: `index.js`. Se diverso: `build-pkg.bat src\main.js`
2) Lo script:
   - esegue esbuild con alias/stub dei moduli problematici
   - individua `node.exe` della cache pkg e *compila* `.jsc` con **quello** (evita mismatch V8)
   - crea `dist\whatsapp-ai.exe` monolitico
3) Se usa Puppeteer, aggiunge automaticamente `--assets node_modules\puppeteer\**\*` (EXE più grande).

Stub e alias
------------
- `electron`     -> stub (non serve su Windows / Node puro).
- `unix-dgram`   -> stub (usato da winston-syslog su Unix).
- `puppeteer/package.json` -> marcato `external` (serve a `require.resolve` a runtime).

Errori comuni
-------------
- "Could not resolve <entry>": sei fuori cartella o l'entry non esiste. Usa `index.js` o passa il path.
- "Invalid host defined options": `.jsc` compilato con Node diverso da quello runtime. Nel metodo pkg *non succede* perché usiamo il `node.exe` di pkg; nel metodo SFX, usa lo stesso Node per compilare e per eseguire (o includi `node.exe` portabile in `app\`).
- Puppeteer non trovato: o lo includi negli assets (metodo pkg) o lo copi in `app\node_modules\puppeteer` (metodo SFX), oppure scaricalo al primo avvio.

Comandi rapidi
--------------
- SFX: `build-sfx.bat`  -> crea `whatsapp-ai.exe` nella ROOT
- PKG: `build-pkg.bat`  -> crea `dist\whatsapp-ai.exe`

Buon build.
