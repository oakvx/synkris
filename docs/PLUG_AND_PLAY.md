# Percorso plug-and-play: implementazione e limiti

Snapshot tecnico dell'**8 novembre 2026**. Questa è ancora una RC ricostruita, non una stabile. La guida utilizzabile anche dallo ZIP è [Primi passi Windows](../deploy/PRIMI_PASSI.md).

## Cosa è cambiato

| Area | Comportamento e confine |
| --- | --- |
| Setup | Wizard PowerShell per nome, team, trattamenti, abilitazioni e orari. Validatore Node canonico prima delle modifiche DB; niente template dimostrativi accettati come configurazione reale. Il nome salone viene inizializzato una sola volta. |
| File privati | Importazione bounded/create-only, UTF-8 senza BOM e permessi locali. Riprendere non cambia i file esistenti. Correzione esplicita prima del primo import, solo a servizi fermi, con backup, verifica pertinente e rollback del file rifiutato. Non è rinnovo/rotazione in produzione. |
| Ambiente | Genera solo i segreti mancanti/dimostrativi; rifiuta di cambiare alla cieca la password di un volume DB esistente. Non trasforma uso privato in un bypass firma/HWID. |
| Docker | Rifiuta daemon remoto e motore Windows; sonda Compose, attende Desktop, limita i processi diagnostici. Rifiuta container del medesimo progetto associati a un'altra cartella. Lo stesso guard si applica anche a update, restore, export, riconciliazione e AI tramite la libreria comune. |
| Doctor | Immagine runtime già disponibile, senza build/pull, rete, DB, browser o provider. Mount read-only e verificatore licenza originale in processo isolato di produzione. `productionReady` è sempre falso. |
| Launcher | Riusa i BAT esistenti. Menu per installazione, avvio, diagnostica, password, report e autostart. Avvio quotidiano senza build/pull; la sospensione dopo restore prevale. |
| Password | WinForms locale mascherato, rivelazione/copia solo su clic, nessuna stampa o rotazione. Clipboard ripulita solo se contiene ancora il valore copiato dalla finestra; cronologia/cloud Windows non cancellati. |
| Autostart | Opt-in separato per utente dopo login; collegamento Startup, niente servizio/task/registry/password Windows. Link modificati o appartenenti ad altre cartelle non sostituiti. |
| Dashboard | Sei controlli: database, attivazione, catalogo, WhatsApp, sync Calendar e backup. Query read-only con timeout; progress e CTA allowlisted, dati testuali, errori che eliminano vecchi verdi. Mai una certificazione di produzione. |
| Backup | Dump in staging, controllo strutturale e SHA256 prima del nome finale, conservazione dei precedenti su errore e retention 14 giorni. Il rilevamento “recente” è solo metadata; non prova integrità completa, restore o copia cifrata. |
| Assistenza | JSON locale di metadati/stati enumerati, senza log grezzi, clienti, QR, token, HWID o payload credenziali. Raccolta runtime autenticata dentro il container bot esistente, mai inviando automaticamente il token alla porta host. Nessun upload. |
| Compatibilità | Nuovi helper sotto percorsi già ammessi; nessun ampliamento dell'updater a `.env`, `runtime/`, `secrets/` o configurazione privata. Preservati reconciliation, dedupe, invii incerti senza retry e nuova associazione QR dopo OpenWA. |

## Evidenza effettiva

La [CI del milestone `9ff8000`](https://github.com/oakvx/synkris/actions/runs/42527797589) è **completed/success: 6 job**. Non estendere automaticamente questo risultato ai commit successivi: controllare la CI del ref realmente distribuito.

- **239 test Node**, zero fallimenti e zero skip; eseguiti localmente e su Node 22/24 in CI.
- `npm run check`: inventario/allowlist e sintassi verificati. Nessun file privato segnalato nell'albero corrente; non è un audit completo della cronologia.
- **7 casi aggiuntivi** del produttore backup con strumenti PostgreSQL sintetici: pubblicazione, errori e conservazione dei precedenti.
- **PostgreSQL 16 reale + PHP 8.3 nativo**: integrazione transazioni/outbox, checklist aggregata, proxy con login/token/CSRF/origin/GET-only.
- **Roundtrip reale PostgreSQL 16**: pg_dump, pg_restore --list, checksum e restore transazionale su un nuovo DB CI sintetico cancellabile. Confrontati conteggi di clienti, appuntamenti, professionisti, servizi e outbox. Nessun account/provider reale.
- **Doctor Docker Compose effettivo**: immagine runtime, network none/read-only, verifica firma valida e rifiuto firma errata; nessun servizio dipendente, marker import o volume DB creato.
- **PowerShell 5.1 e 7 su runner Windows**: parser di tutti gli script, ZIP, wizard, import, ambiente, preflight, avvio, ownership e report. Test COM dei collegamenti solo in una directory TEMP, mai nella Startup reale. La correzione iniziale verifica backup e rollback; nel ramo sono presenti casi aggiuntivi per annullamento, servizi attivi, checker assente e file bloccato, da verificare nella CI del ref corrente.
- **Finestra credenziali:** controlli del sorgente, non automazione interattiva WinForms.
- **Anteprime:** frontend effettivo con sole fixture sintetiche e nessuna sessione/credenziale. Non dimostrano provider attivi.
- Audit produzione rieseguito: **19 rilievi, 8 moderati, 11 elevati, zero critici**; SBOM 335 componenti. Nessuna dipendenza cambiata con un fix forzato.

I report locali in `artifacts/`, pacchetti e strumenti temporanei non sono committati. Non è stata aperta una nuova PR, pubblicata una release/tag/npm o modificata la visibilità del repository per questo lavoro.

## Cosa rimane manuale e da collaudare

1. Installare Docker Desktop/WSL2 e verificare l'effettivo isolamento/sandbox Chromium sul PC destinatario; nessun bypass silenzioso.
2. Ottenere file firmato/HWID dal titolare, anche per privato gratuito; Google service account, condivisione dei calendari e associazione WhatsApp restano azioni autorizzate dell'operatore.
3. Provare interattivamente finestra/clipboard, logout/login e autostart reali, porte e permessi sul PC. I test CI non equivalgono a Windows Desktop/Docker Desktop/WSL2 del salone.
4. Eseguire test reali Calendar/WhatsApp, concorrenza, disconnessioni e invii incerti; SMTP soltanto se richiesto e con opt-in.
5. Provare aggiornamento, rollback codice, restore su macchina di prova, riconciliazione Google e USB BitLocker; non riavviare automaticamente vecchi job.
6. Valutare/correggere vulnerabilità e completare le verifiche legali/di distribuzione. Il modello resta proprietario/source-available e non sono stati fissati prezzi o royalties.

La [checklist operativa](../COLLAUDO.md) resta **da firmare sul PC reale**, non precompilata dai test. I risultati storici della migrazione sono separati nel [report di ricostruzione](history/REPORT_RICOSTRUZIONE_RC6.md) e nella [readiness](OPEN_SOURCE_READINESS.md).
