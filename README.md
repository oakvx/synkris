# synk — prerelease ricostruita

Gestione locale di appuntamenti per saloni: Node.js/OpenWA, dashboard PHP,
PostgreSQL e Google Calendar; Ollama locale facoltativo.

**Versione `1.2.0-rc.6`, solo collaudo.** I componenti dashboard, deploy, asset e
strumenti Windows mancanti sono stati riscritti a partire dalle interfacce e
dai test rimasti. Non è un recupero dei file originali né una certificazione
per l’uso con clienti reali.

- [Preparazione e pubblicazione della prerelease](RELEASE.md)
- [Cosa è stato ricostruito e limiti](REPORT_RICOSTRUZIONE_RC6.md)
- [Istruzioni per il tecnico e il salone](LEGGIMI.txt)
- [Collaudo obbligatorio](COLLAUDO.md)
- [Sicurezza](SECURITY.md) · [Licenza proprietaria](LICENSE.md)

## Sviluppo e controlli

Node.js 22 o 24. PHP 8.3 con `pdo_pgsql`, `curl` e `sodium` per i controlli PHP.
PowerShell 5.1/7 per i test degli strumenti Windows. Non servono credenziali
reali per i test automatici.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:php
npm run test:php
npm run audit:release
npm run release:package
```

Il pacchetto viene scritto in `artifacts/`, fuori da Git. Per prima installazione
Windows: estrai lo ZIP piatto, leggi `LEGGIMI.txt`, configura i dati reali SOLO sul
PC del salone, poi avvia `INSTALLA_UNA_VOLTA.bat`.

Il repository deve rimanere privato. Non committare `.env`, `setup/config.json`,
`runtime/`, credenziali o licenze. Il download di una release privata richiede
accesso al repository: non rende pubblica né liberamente redistribuibile l’app.
