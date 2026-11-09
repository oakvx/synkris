# Asset del README — SYNKRIS

Il [README principale](../../README.md) mostra **sei SVG con identità viola/fucsia**
e **tre screenshot WebP con dati sintetici**, oltre al logo del prodotto.
I vecchi diagrammi verdi non sono più distribuiti: erano duplicati
dell'identità precedente e non comparivano nel README.

## Inventario attuale

| Asset in `docs/assets/` | Contenuto |
| --- | --- |
| `synkris-hero.svg` | Copertina concettuale, con wordmark vettoriale |
| `synkris-benefits.svg` | Funzioni operative e carattere con legatura tipografica reale |
| `synkris-journey.svg` | Percorso illustrativo della richiesta del cliente |
| `synkris-architecture.svg` | Componenti locali, calendario e servizi esterni |
| `synkris-stack.svg` | Stack applicativo dichiarato dal codice |
| `synkris-booking-flow.svg` | Transazioni e sincronizzazione con Google Calendar |
| `dashboard-overview.webp` | Dashboard e Centro operativo, fixture sintetiche |
| `dashboard-agenda.webp` | Agenda con appuntamenti fittizi |
| `dashboard-editor.webp` | Editor con trattamenti e durate di esempio |

Gli SVG sono **sorgenti versionati**. Non contengono script, font binari,
`foreignObject`, richieste a CDN né immagini esterne: i tracciati principali
rimangono identici su GitHub, mentre il testo secondario usa un font stack
di fallback. Per palette, tipografia e attribuzioni vedere
[brand-guide.md](brand-guide.md).

## Provenienza degli screenshot

Le anteprime raster provengono da `dashboard/view.html` e dagli script/CSS
effettivi del frontend. Il renderer:

- mostra la dicitura **ANTEPRIMA DOCUMENTALE · DATI SINTETICI · NESSUN PROVIDER REALE COLLEGATO**;
- usa nomi, recapiti e calendari fittizi, non credenziali o dati di salone;
- verifica che il frontend non generi errori e controlla i dati attesi;
- accetta soltanto richieste statiche e GET sintetiche, rifiutando scritture;
- chiude browser e server di fixture alla fine della cattura.

Non avvia il backend PHP/Node, non legge `.env`/`secrets/` e non introduce
bypass di licenza o modalità demo nel codice applicativo. Non sono prove
di funzionamento reale di WhatsApp o Google Calendar.

## Rigenerare le anteprime WebP

Il renderer utilizza Linux x64, Node.js 22/24, Chromium headless isolato
e dipendenze temporanee **non incluse nell'applicazione**:

```sh
npm install --prefix .cache/readme-tools --no-save --ignore-scripts --no-audit --no-fund \
  @sparticuz/chromium@131.0.1 puppeteer-core@23.11.1
node docs/readme/capture-previews.mjs
```

Su un sistema minimale privo di `libnss3`, possono servire le librerie
del pacchetto Chromium; vedere i requisiti di `@sparticuz/chromium`.
I parametri di cattura **non** sono una configurazione del bot sul PC
Windows. Le immagini di lavoro vengono salvate in `.cache/readme-qa/`,
che è ignorata da Git.

## Controlli automatici

```sh
python3 docs/readme/check-assets.py
npm run check
npm test
```

`check-assets.py` valida i riferimenti locali, gli anchor Markdown, gli SVG
(accessibilità, sintassi XML e assenza di contenuti attivi/remoti), gli
header WebP e la coerenza delle indicazioni su licenza, test e limiti
di collaudo.

I **badge dinamici** del README (CI, stelle, fork, ultimo commit)
utilizzano servizi esterni; il contatore visite di terze parti non è
una statistica ufficiale GitHub e non indica visitatori unici.

## Distribuzione

Il pacchetto installabile usa una allowlist e **non include `docs/`**
né gli script di cattura. Gli asset applicativi, fra cui `assets/logo.svg`,
restano separati dalle immagini di presentazione. La licenza del
progetto è proprietaria/source-available: leggere
[LICENSE.md](../../LICENSE.md) e
[stato della distribuzione](../OPEN_SOURCE_READINESS.md).
