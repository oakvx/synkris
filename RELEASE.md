# Preparare una prerelease di synk

## Stato e decisione

Questa procedura produce **`v1.2.0-rc.6`**, una nuova candidata di collaudo che
identifica chiaramente la ricostruzione dei file persi. Non promuove RC5 a
stabile. Nessuna pubblicazione automatica a ogni push, nessuna pubblicazione npm
(`private: true`) e nessuna immagine pubblica.

**Diritti d’uso:** la licenza è proprietaria/source-available. Solo l’uso strettamente
privato non commerciale di una persona fisica è gratuito; ogni altro uso, incluso
quello interno a un salone, richiede prima un accordo commerciale scritto a titolo
oneroso, salvo diversa autorizzazione scritta. Prezzi e royalties non sono fissati
in automatico. Vedi `LICENSE.md` e la revisione legale richiesta prima della
distribuzione commerciale. Il file firmato/HWID resta necessario anche per il
privato: l’attivazione privata è gratuita ma va richiesta al titolare, con rilascio
manuale; non esiste ancora un percorso self-service.

**Blocchi per una stabile:** completare `COLLAUDO.md`, valutare/correggere gli
avvisi delle dipendenze, verificare distribuzione e licenze di terzi e approvare
il comportamento dei componenti ricostruiti. Il workflow attuale accetta solo
versioni `-rc.N` e crea esclusivamente **bozze di prerelease non pubblicate**,
con avvio manuale oppure con snapshot programmata settimanale. I test con provider simulato non sono un test Google o
WhatsApp reale.

## 1. Verificare il codice

Prerequisiti: Node 22/24; PHP 8.3 con pdo_pgsql, curl, sodium; Docker per la build;
PowerShell 5.1 o 7 per i test Windows.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:php
npm run test:php
npm run audit:release
```

In PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/windows-scripts.test.ps1
```

I test di integrazione richiedono un database **dedicato e cancellabile** chiamato
`synk_test`. Non usare mai il database del salone. `TEST_DATABASE_URL` è separata
da `DATABASE_URL`; è obbligatorio autorizzare esplicitamente il reset:

```sh
# Credenziali sintetiche del solo database di test; non usare dati del salone.
TEST_DATABASE_URL=postgresql://synk_test:synk_test@127.0.0.1:5432/synk_test \
SYNK_TEST_DB_ALLOW_RESET=1 npm run test:integration
```

La suite resetta lo schema `public`, usa firme effimere e un gate Calendar
simulato. Verifica transazioni e comportamento HTTP, non la disponibilità dei
servizi esterni. La CI esegue inoltre un doctor Compose reale senza rete/startup
dipendenze e un roundtrip pg_dump/list/SHA256/pg_restore con PostgreSQL 16 su un
nuovo database sintetico cancellabile. I test autostart COM scrivono solo in TEMP,
mai nella cartella Esecuzione automatica reale. Non sono un collaudo Desktop/WSL2.

Controllare anche `npm audit --omit=dev` e `npm run audit:release`: il report viene conservato dalla CI,
ma **non è un via libera di sicurezza**. `npm run audit:release` blocca la CI
se il report manca o contiene vulnerabilità critiche; gli altri rilievi restano
visibili e richiedono revisione prima di qualsiasi uso reale. Non applicare downgrade/upgrade maggiori automatici a
whatsapp-web.js/Puppeteer senza collaudarne il contratto con il bot.

## 2. Generare e verificare lo ZIP

```sh
npm run release:package
node scripts/release/archive.mjs artifacts/synk-1.2.0-rc.6.zip
```

Output:

- `artifacts/synk-1.2.0-rc.6.zip` — ZIP piatto: `src/`, Dockerfile e BAT alla radice;
- `artifacts/synk-1.2.0-rc.6.zip.sha256` — integrità dell’intero archivio;
- `artifacts/RELEASE-MANIFEST.json` — anche dentro lo ZIP, versione/provenienza e
  SHA256 di ciascun file.

Il file **`PRIMO_AVVIO.txt`** è presente alla radice dello ZIP e contiene
la guida breve per l'installazione di prova. Lo ZIP include script Windows
ma **non è un eseguibile `.exe` indipendente**: richiede Docker Desktop,
WSL2 e gli elementi di attivazione indicati nella guida.

Il pacchetto è costruito da una allowlist e rifiuta symlink, percorsi non sicuri,
file privati nei percorsi del codice e componenti richiesti mancanti. Non include
`.git`, `.env`, `setup/config.json`, `runtime/`, `secrets/`, dipendenze installate,
test o dati cliente. Include solo `.env.example` e `setup/config.example.json`.
Il checksum **non è una firma di autenticità**: confrontarlo con il valore
proveniente dal canale ufficiale fidato.

Un archivio locale con `sourceDirty: true` contiene modifiche non committate:
serve per la prova locale, **non deve essere pubblicato con un tag sul vecchio
commit**. Revisionare e salvare le modifiche sul branch di lavoro prima di
preparare una bozza associata a un commit esatto.

## 3. Preparare la bozza sul repository

1. Revisionare i cambiamenti e portarli sul repository tramite il branch di
   lavoro e una PR; non includere gli output di `artifacts/`.
2. Attendere tutti i job di `CI` (Node, PHP/PostgreSQL, PowerShell e Docker).
3. Per il primo utilizzo, il workflow deve essere presente sul branch predefinito
   per comparire in **Actions → Prerelease → Run workflow**.
4. Selezionare il ref revisionato. Lasciare `create_draft` disattivato per
   ottenere solo gli artifact; attivarlo solo se si vuole creare la bozza.
5. Il workflow riesegue la CI, prepara il pacchetto da checkout pulito e, solo se
   richiesto, crea `v<versione package.json>` in stato **Draft + Prerelease** sul
   commit esatto con ZIP, checksum e manifest.
6. Esaminare manualmente note, artifact e audit. La bozza NON viene pubblicata
   automaticamente. **Il repository attuale è pubblico**: una bozza non è
   visibile ai visitatori, ma pubblicarla rende disponibili ZIP e allegati
   attraverso GitHub Releases. Non allegare licenze emesse, segreti, dati
   cliente o archivi runtime.

Non esiste un percorso automatico di pubblicazione stabile in questi workflow.
Per una successiva RC aggiornare versione/lockfile con
`npm version 1.2.0-rc.7 --no-git-tag-version --ignore-scripts`, poi changelog e
istruzioni, senza creare tag che puntino a modifiche non salvate.

## 3-bis. Snapshot settimanale automatica

Ogni **lunedì alle 06:17 UTC**, GitHub Actions esegue automaticamente
`.github/workflows/prerelease.yml` sul commit più recente del branch
predefinito **`master`**. L'orario effettivo può slittare a causa della coda di
GitHub. Per questo non esistono processi server o agenti permanenti.

- Esegue di nuovo **tutta la CI** (Node, PHP/PostgreSQL, Windows, Docker);
  un controllo fallito impedisce la creazione della bozza.
- Genera lo ZIP dalla revisione verificata, controlla il manifest con
  `sourceCommit = GITHUB_SHA`, `sourceDirty = false`, verifica l'archivio e
  il file SHA256. Il gate audit impedisce i rilievi **critici**, ma un audit con
  altre vulnerabilità **non significa** che il programma sia pronto.
- Crea sempre una **Draft + Prerelease**, anche se rispetto alla settimana
  precedente nessun file è cambiato.
- Il tag è univoco per ogni esecuzione:
  `v1.2.0-rc.6-snapshot.AAAAMMGG.RUN_ID.TENTATIVO`. La versione interna allo
  ZIP rimane quella di `package.json` finché non viene aggiornata da un commit.
- Gli allegati restano lo ZIP, `.zip.sha256` e `RELEASE-MANIFEST.json`.
  Il nome del tag non implica modifiche al codice né una nuova versione stabile.
- Ogni snapshot punta a **uno specifico commit**. Un tag esistente non viene
  mai sovrascritto. Le bozze si accumulano finché il maintainer non decide di
  esaminarle/gestirle.
- Nessuna snapshot viene pubblicata automaticamente: nel repository pubblico
  la visibilità dei download richiede ancora **Publish release** da parte del
  maintainer. Scegliere la pubblicazione solo dopo i collaudi e le revisioni.

Le esecuzioni manuali in **Actions → Prerelease** sono indipendenti: con
`create_draft=false` generano soltanto artifact; con `true` preparano la
bozza del tag canonico `v<versione>`. Lo schedule non modifica il sorgente,
non incrementa `package.json` e non attiva Google/WhatsApp.

**GitHub può disattivare i workflow schedulati dei repository pubblici dopo
60 giorni senza attività**; in quel caso occorre riabilitare il workflow.
La schedulazione è configurabile modificando la riga `cron` nel workflow.

## 4. Installazione e aggiornamento di prova

Estrarre tutto in una cartella Windows locale dedicata e fissa (evitare cartelle
condivise o sincronizzate). `INSTALLA_SYNK.bat` apre il menu: Invio avvia
il wizard per team, trattamenti e orari, importazione dei tre file privati e
configurazione CALENDAR_ID/APP_HWID. Non servono JSON manuali o Node/PHP sul PC.
Il doctor Docker è read-only, senza rete o dipendenze avviate e usa il verificatore
di produzione prima del bootstrap. Il bootstrap verifica realmente firma e HWID.
`deploy/PRIMI_PASSI.md` è incluso nello ZIP e nei percorsi già consentiti dall'updater.

Il menu include diagnostica, finestra password mascherata, report assistenza
locale status-only e autostart per utente opt-in dopo login. Il report non carica
nulla e non contiene log grezzi/segreti. La finestra non cancella cronologia
appunti/cloud Windows. Il recupero del file iniziale e la correzione dei file
privati sono consentiti solo prima del marker import; conservano backup privati.
La correzione verifica il file e ripristina l'originale se rifiutato, senza avviare
servizi. Dopo import, rinnovi/rotazioni richiedono una procedura tecnica.

Un progetto Docker già appartenente a un'altra cartella viene bloccato. L'avvio
quotidiano `AVVIA_SYNK` non esegue build o pull. Credenziali esistenti
e password database non sono rigenerate automaticamente. Dopo un restore la
sospensione Calendar continua a prevalere: un avvio non la rimuove.
Il provider è whatsapp-web.js 1.34.7 con LocalAuth. Chromium usa argomenti
espliciti, senza bypass TLS/CSP o sandbox impliciti. Se la sandbox non parte sullo specifico host Docker/WSL2, fermare il
collaudo e far valutare al tecnico l’isolamento del container/VM. Non aggiungere
privilegi ampi o disabilitare la sandbox automaticamente. L’eventuale
`CHROME_NO_SANDBOX=1` è un opt-in tecnico che riduce l’isolamento e va valutato
consapevolmente, mai un’impostazione implicita dell’installazione.

**Aggiornamento da OpenWA:** la nuova libreria non legge il vecchio formato.
Fermare la vecchia istanza, conservare backup e file preesistenti e associare un
nuovo QR da Conversazioni. Non avviare due bot sullo stesso account. Il profilo
LocalAuth è in `runtime/session/whatsapp-web.js/session-whatsapp-ai/` nel deploy
Compose; la cache è nella sottocartella `web-cache/`. `destroy()` conserva il
profilo: non usare `logout()` come arresto. I backup PostgreSQL non includono
questi file o i segreti. Un rollback del codice non garantisce che WhatsApp
accetti ancora la vecchia sessione.

Il nuovo `deploy/THIRD_PARTY_NOTICES.md` conserva Apache-2.0/MIT dei componenti
introdotti. Si trova sotto un percorso già ammesso dall’updater Windows: non
richiede di allargare la allowlist ai dati privati. La guida estesa è in
`docs/WHATSAPP_MIGRATION.md` nel repository (i documenti `docs/` non sono nello
ZIP runtime). Collaudare QR, riavvio, revoca, LID se disponibili e presa in carico.
Un invio dall’esito incerto non va ritentato automaticamente: verificare prima
WhatsApp. Il passaggio non cambia le verifiche di licenza firmata/HWID.

Le password casuali vengono generate solo per i valori mancanti/dimostrativi,
mai ruotando alla cieca una password di database esistente:
conservare la password dashboard nel gestore password del salone. Lo script non
rimpiazza una configurazione privata esistente. Docker Desktop deve essere
attivo, con motore Linux/WSL2 e avvio dopo il login Windows.

**Cambio launcher rispetto alle RC precedenti:** la nuova distribuzione espone
soltanto `INSTALLA_SYNK.bat` (setup e strumenti) e `AVVIA_SYNK.bat` (uso
quotidiano). Il motore PowerShell di avvio e' uno solo:
`strumenti/avvio.ps1`. Non ci sono piu' `INSTALLA_UNA_VOLTA.bat`,
`APRI_SYNK.bat` o `strumenti/avvia.ps1` nel nuovo ZIP.
Un collegamento di autostart creato dalla precedente versione e' riconosciuto
come `legacy`: dal menu l'opzione 6 permette di aggiornarlo con consenso e
l'opzione 7 di disabilitarlo. Collegamenti sconosciuti non sono modificati.

**Attenzione agli aggiornamenti in-place dalle RC precedenti:** il vecchio
updater ha una allowlist che non riconosce `INSTALLA_SYNK.bat` e puo'
rifiutare questo ZIP prima di effettuare modifiche. Inoltre la copia
incrementale non cancella i vecchi launcher di una installazione esistente.
Non eliminare cartelle, volumi o dati e non aggirare il controllo manifest:
una installazione gia' configurata richiede una **migrazione tecnica assistita**
con backup e verifica di runtime/credenziali, PostgreSQL, sessione WhatsApp e
collegamenti Windows. Il pacchetto con i due nuovi file e' destinato anzitutto
alle **nuove installazioni di collaudo**; per le precedenti serve un rilascio
di transizione o una procedura di migrazione testata.

Per aggiornare: avviare `AGGIORNA_SYNK_TECNICO.bat`, indicare ZIP e SHA256 ottenuto
dal canale ufficiale e confermare. Lo script convalida il manifest prima di
fermare i servizi, crea un backup PostgreSQL e una copia del codice, conserva
`.env`, `setup/config.json`, `runtime/`, `secrets/`, `.git` e volumi Docker.
Non supporta ZIP con una cartella contenitore. Mai `docker compose down -v`.

Se il deploy fallisce, viene tentato il rollback del **codice**. Se è già stato
tentato il bootstrap/migrazione DB, i servizi restano fermi e viene mantenuta
una sospensione: le migrazioni NON sono annullate e serve una verifica tecnica.
Il healthcheck non certifica la connessione WhatsApp: verificarla in dashboard.

## 5. Ripristino e riconciliazione Calendar

Provare prima solo su un PC di collaudo. Lo script:

1. acquisisce un mutex locale e scrive il flag persistente di sospensione;
2. ferma bot, dashboard e backup; crea un backup di sicurezza;
3. controlla il dump e tenta un restore PostgreSQL transazionale;
4. mette le vecchie operazioni outbox in `attention`, le saghe in
   `needs_attention` e azzera i cursori di sync, senza riprodurre i job vecchi;
5. lascia i servizi applicativi fermi e le prenotazioni sospese.

Dopo il restore confrontare manualmente ogni evento con Google, risolvere
orfani/mancanze/conflitti e annotare gli interventi. Se il DB è sano,
`AVVIA_SYNK.bat` permette la consultazione con il flag ancora presente: i worker
Calendar e le prenotazioni rimangono bloccati. Non eseguire SQL massivi che
rimettono indiscriminatamente in coda i job `attention`.

`RIATTIVA_CALENDAR_TECNICO.bat` richiede la conferma testuale
`CALENDAR VERIFICATO`, verifica l’avvio dei servizi e rimuove il flag solo alla
fine; le operazioni da verificare non vengono automaticamente risolte. Attendere
una nuova sync entrante e monitorare il Centro operativo. Un errore dopo il
tentativo di restore non comporta mai un riavvio automatico.

## 6. Backup su USB

`ESPORTA_BACKUP_CIFRATO_TECNICO.bat` richiede Windows con cmdlet BitLocker e
permessi sufficienti (può servire l’esecuzione come amministratore), un disco USB
identificabile, totalmente cifrato e con protezione attiva. Rifiuta la copia se
non può verificarlo. Confronta SHA256 della copia prima di completarla.
I backup locali e i download browser non sono autonomamente cifrati: proteggere
anche il PC con BitLocker e custodire separatamente la chiave di recupero.
