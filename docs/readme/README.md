# Asset del README

Il [README principale](../../README.md) usa **9 asset nuovi, ospitati nel repository**, più il logo già presente. Non dipende da badge esterni, CDN, immagini stock o URL che contengono token.

## Inventario

| File in `docs/assets/` | Origine / contenuto |
| --- | --- |
| `hero.svg` | Banner vettoriale originale; la mini-agenda è un’illustrazione, non una sessione reale. |
| `stack.svg` | Tecnologie e versioni dichiarate dal progetto. |
| `features.svg` | Capacità dell’interfaccia e della manutenzione. |
| `architecture.svg` | Schema semplificato, con confine fra core locale e provider esterni. |
| `booking-flow.svg` | Verifica, transazione locale/outbox e sincronizzazione asincrona. |
| `readiness.svg` | Snapshot datato di CI, audit, licenza e collaudo; **non è un badge live**. |
| `dashboard-overview.webp` | Frontend ricostruito: centro operativo con fixture sintetiche. |
| `dashboard-agenda.webp` | Frontend ricostruito: sei appuntamenti interamente sintetici. |
| `dashboard-editor.webp` | Frontend ricostruito: due trattamenti e totale di 100 minuti, buffer inclusi. |

Gli SVG sono generati con soli strumenti standard Python: testo accessibile con `title`/`desc`, nessuno script, nessun `foreignObject`, font incorporato o riferimento a immagini esterne. I font sono normali fallback del visualizzatore.

Le anteprime raster derivano da `dashboard/view.html` e dai veri script/CSS del frontend. Il renderer:

- aggiunge una fascia **ANTEPRIMA DOCUMENTALE · DATI SINTETICI · NESSUN PROVIDER REALE COLLEGATO**;
- sostituisce i placeholder di versione e CSRF con metadati documentali, non una sessione applicativa;
- usa `Cliente esempio NN`, email del dominio riservato `example.com`, date fisse e nessun contatto reale;
- rende esplicita l’analitica sintetica e usa `+` al posto del carattere full-width quando mancano i font corrispondenti;
- serve soltanto file statici autorizzati e risposte GET predefinite; rifiuta le scritture;
- blocca le richieste del frontend fuori dal server di fixture e chiude browser/server alla fine.

**Non avvia il backend PHP/Node, non legge `.env` o `secrets/`, non modifica la licenza e non introduce una modalità demo/bypass nell’applicazione.** Queste immagini non provano il funzionamento dei provider reali.

## Rigenerare gli SVG

Dalla radice del repository, con Python 3:

```sh
python3 docs/readme/generate-assets.py
```

Colori, composizione e testo sono in `generate-assets.py`. Per aggiornare numeri, versione o stato legale occorre prima verificarli e poi cambiare generatore e documentazione: non cambiare solo il badge.

## Rigenerare le anteprime

Il renderer fornito usa **Linux x64 e Node.js 22/24**, un browser headless isolato e dipendenze temporanee fuori dal manifest applicativo:

```sh
npm install --prefix .cache/readme-tools --no-save --ignore-scripts --no-audit --no-fund \
  @sparticuz/chromium@131.0.1 puppeteer-core@23.11.1
node docs/readme/capture-previews.mjs
```

Su un ambiente minimale che non ha `libnss3`, si possono estrarre le librerie già incluse nel pacchetto npm, senza installarle globalmente:

```sh
node --input-type=module -e "import fs from 'node:fs'; import zlib from 'node:zlib'; fs.writeFileSync('.cache/readme-tools/al2023.tar', zlib.brotliDecompressSync(fs.readFileSync('.cache/readme-tools/node_modules/@sparticuz/chromium/bin/al2023.tar.br')));"
mkdir -p .cache/readme-tools/runtime
tar -xf .cache/readme-tools/al2023.tar -C .cache/readme-tools/runtime
node docs/readme/capture-previews.mjs
```

Il renderer usa le librerie soltanto nel processo di cattura. I parametri del browser di documentazione **non sono una configurazione per il bot** e non attestano la sandbox sul PC Docker/WSL2 del salone.

La cattura verifica anche l’assenza di errori del frontend, il totale dell’editor, il numero di righe dell’agenda e il testo fuori dal canvas degli SVG. Le immagini PNG intermedie per il controllo visivo finiscono in `.cache/readme-qa/`, non in Git.

## Verificare collegamenti e asset

```sh
python3 docs/readme/check-assets.py
npm run check
npm test
```

Il controllo documentale verifica i riferimenti locali, gli anchor del README, la validità XML e l’assenza di contenuti attivi/remoti negli SVG, e le intestazioni WebP. Non sostituisce una revisione visiva o una verifica legale degli asset.

## Distribuzione e licenza

Gli asset documentali seguono **la licenza proprietaria del progetto**, con uso privato non commerciale gratuito e altri usi su accordo commerciale, **non una licenza open source**. Il pacchetto runtime usa una allowlist e non include `docs/`; gli strumenti di cattura e le dipendenze temporanee non sono dipendenze di produzione. Il logo riutilizzato resta in `assets/logo.svg`.

[Licenza e stato della distribuzione](../OPEN_SOURCE_READINESS.md) · [Licenza attuale](../../LICENSE.md)
