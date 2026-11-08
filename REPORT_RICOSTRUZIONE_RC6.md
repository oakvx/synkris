# synk 1.2 RC6 — ricostruzione dei componenti persi

> Report storico della ricostruzione. I successivi miglioramenti di setup, menu e checklist sono descritti in [Primi passi Windows](deploy/PRIMI_PASSI.md); per gli esiti aggiornati consultare la CI del commit effettivo, non solo i conteggi di questa baseline.

## Aggiornamento successivo: migrazione WhatsApp

Questo è il **report storico della prima ricostruzione**, non la descrizione del
provider ora installato. La base `bdee2e5` ha poi superato tutti i 6 job CI con
92 test Node. Nell’aggiornamento successivo OpenWA è stato sostituito da
whatsapp-web.js 1.34.7 (Apache-2.0), con LocalAuth separato, nuova associazione QR
e qrcode 1.5.4 (MIT). L’override parse-url di OpenWA è stato rimosso.

La verifica locale della migrazione conta **139 test Node**; audit **19 rilievi
(11 elevati, 8 moderati, zero critici)** e SBOM 335 componenti. Controllare la CI
della relativa PR e completare i test con account/PC reali: questi numeri non
certificano una stabile. `RELEASE.md`, `COLLAUDO.md` e
`deploy/THIRD_PARTY_NOTICES.md` descrivono lo stato aggiornato anche nello ZIP.
Le vecchie sessioni non vengono convertite o cancellate e i verificatori
firma/HWID rimangono invariati. Le sezioni seguenti conservano le evidenze della
preparazione iniziale, inclusi i limiti dei runner allora non ancora eseguiti.

## Provenienza e limiti

Sono stati ricostruiti, non recuperati dagli originali, i percorsi assenti
`dashboard/`, `deploy/`, `assets/`, `strumenti/` e l’esempio di setup. Il codice
Node e lo schema esistenti sono il riferimento delle interfacce; i vecchi test
sono stati conservati. Non viene promessa parità con il layout o tutte le
funzioni della dashboard persa.

La versione è passata da `1.2.0-rc.5` a **`1.2.0-rc.6`** per identificare senza
ambiguità questa ricostruzione. Nessuna release remota o tag è stato pubblicato
nel corso della preparazione locale.

## Componenti

- Dashboard senza CDN o dipendenze browser esterne; nessun dato dimostrativo
  mascherato da reale, nessun salvataggio di appuntamenti in localStorage.
- Sessioni HTTP-only/SameSite, timeout e rigenerazione ID; token CSRF anche per
  login/logout e scritture proxy; limite tentativi per indirizzo, non per cookie.
- Verifica licenza Ed25519 con libsodium, stessi byte JSON firmati del verificatore
  Node, scadenza/HWID/firma controllati; nessun bypass produzione.
- API PDO parametrizzate, vincolo PG anti-sovrapposizione, versionamento ottimistico
  dell’editor, durate/abilitazioni/buffer lato server, verifica orari e Calendar.
- Calendar non raggiungibile/risposta incompleta o flag di manutenzione:
  salvataggi bloccati. Gli effetti remoti usano l’outbox transazionale esistente;
  lo stato in coda/attenzione resta distinto dal salvataggio locale. Non è una
  transazione ACID con Google e non azzera tutte le condizioni di gara.
- Strumenti Windows: backup tramite file binario (non pipe PowerShell), SHA256 e
  manifest ZIP, percorsi protetti, mutex manutenzione, restore sospeso e verifica
  BitLocker prima della copia USB.
- Pacchetti da allowlist, npm lockfile, controlli di repository e workflow di
  verifica; pubblicazione soltanto manuale e in bozza prerelease.

## Compatibilità e dipendenze aperte

L’import della dipendenza originale OpenWA 5.1.0 non era compatibile con il bot:
oltre a un errore di risoluzione transitiva, non espone `create`/`ev`, sostituiti
in v5 da `createClient`. È stata scelta la **4.76.0 esatta**, coerente con le API
usate dal codice esistente, invece di introdurre una migrazione del bot non
collaudata. I test controllano import/esportazioni, stato v4 `CONNECTED` e shutdown con
`kill`, senza aprire WhatsApp. Gli argomenti Chromium espliciti sostituiscono
i vecchi default OpenWA che disabilitavano sandbox/TLS; QR nei log e popup
sono disattivati. La compatibilità della sandbox sul PC Docker reale resta
da verificare, senza disabilitazioni automatiche.

Nodemailer è stato aggiornato alla 10.4.0; il parser `parse-url` usato dal
builder Postman OpenWA è stato fissato alla 8.1.0 con override mirato e test del
contratto (`resource`, `pathname`, `protocol`), eliminando i relativi avvisi
critici. Sono state applicate anche le correzioni compatibili senza `--force`.

Questo mantiene altre dipendenze legacy e avvisi npm audit. **Non è dichiarata una
baseline priva di vulnerabilità.** Vanno esaminati il report audit, la manutenzione
OpenWA/Puppeteer e Nodemailer e i relativi percorsi di esposizione prima di un
pilota con dati reali. SMTP è disattivato di default, ma questo non sostituisce
la correzione delle dipendenze. Una migrazione OpenWA v5 è un lavoro separato
che richiede verifica QR, sessione persistente, messaggi, riconnessioni ed eventi.

## Verifiche

Verifiche locali del **2026-11-08**:

- `npm ci --ignore-scripts`: installazione pulita dal lockfile riuscita (Node 22.22.3).
- `npm run check`: componenti richiesti, Docker COPY, audit file privati e sintassi
  JavaScript/CommonJS/browser verificati.
- `npm test`: **87/87**, compresi test originali e nuovi controlli UI, pacchetto,
  compatibilità OpenWA e gate dipendenze.
- `npm run test:db`: **5/5 su PostgreSQL 16.13 reale**, in un cluster effimero
  dedicato `synk_test`, compresa concorrenza su due connessioni e outbox.
- Sintassi di **13 file PHP** e **10 casi data/ora** verificati tramite PHP 8.5.12
  WebAssembly. **Non equivale a un test nativo PHP 8.3** e non ha pdo_pgsql/sodium.
- Sintassi YAML di Compose e dei workflow verificata; **8 file PowerShell**
  analizzati con tree-sitter, **non eseguiti sul runtime Windows**.
- ZIP verificato internamente con manifest/hash e con parser ZIP indipendente;
  per-file checksum, root piatta e assenza dei percorsi privati controllati.
- `npm run audit:release`: **57 rilievi produzione (9 bassi, 16 moderati,
  32 elevati, 0 critici)** al momento del controllo; il report JSON locale è in
  `artifacts/dependency-audit.json`. Zero critici non significa software sicuro.

**Non eseguiti localmente:** test HTTP/PDO nativi PHP 8.3 e firme libsodium,
helper PowerShell su Windows, build/smoke Docker. Sono predisposti nei job CI,
ma i workflow non sono stati eseguiti su un runner remoto in questa preparazione.
Il gate audit blocca report mancanti e rilievi critici; i rilievi elevati restano
un blocco da revisionare prima dell’uso con dati reali o di una promozione stabile.

Il pacchetto locale conserva `sourceDirty: true`: include la ricostruzione non
ancora committata. È un pacchetto di prova, non una release taggata/pubblicata.

## Collaudo esterno ancora richiesto

- Windows reale, Docker Desktop/WSL2, installazione e aggiornamento della copia di prova.
- Account WhatsApp dedicato, QR, riconnessione e compatibilità della sessione OpenWA.
- Calendari Google dedicati e simultaneità reale tra salvataggi/sync/outbox.
- SMTP solo con opt-in e credenziali del salone.
- Dump/restore, riconciliazione manuale, rollback dopo migrazioni e USB BitLocker.
- Revisione della nuova UX e delle autorizzazioni/licenze commerciali.

La checklist `COLLAUDO.md` resta non firmata e non viene compilata automaticamente.
