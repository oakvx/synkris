# Preparare una prerelease di synk

## Stato e decisione

Questa procedura produce **`v1.2.0-rc.6`**, una nuova candidata di collaudo che
identifica chiaramente la ricostruzione dei file persi. Non promuove RC5 a
stabile. Nessuna pubblicazione automatica a ogni push, nessuna pubblicazione npm
(`private: true`) e nessuna immagine pubblica.

**Blocchi per una stabile:** completare `COLLAUDO.md`, valutare/correggere gli
avvisi delle dipendenze, verificare distribuzione e licenze di terzi e approvare
il comportamento dei componenti ricostruiti. Il workflow attuale accetta solo
versioni `-rc.N` e, su richiesta esplicita, crea esclusivamente una **bozza di
prerelease privata**. I test con provider simulato non sono un test Google o
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
servizi esterni.

Controllare anche `npm audit --omit=dev` e `npm run audit:release`: il report viene conservato dalla CI,
ma **non è un via libera di sicurezza**. `npm run audit:release` blocca la CI
se il report manca o contiene vulnerabilità critiche; gli altri rilievi restano
visibili e richiedono revisione prima di qualsiasi uso reale. Non applicare downgrade/upgrade maggiori automatici a
OpenWA senza collaudarne il contratto con il bot.

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
   automaticamente. Il repository e i suoi download restano privati.

Non esiste un percorso automatico di pubblicazione stabile in questi workflow.
Per una successiva RC aggiornare versione/lockfile con
`npm version 1.2.0-rc.7 --no-git-tag-version --ignore-scripts`, poi changelog e
istruzioni, senza creare tag che puntino a modifiche non salvate.

## 4. Installazione e aggiornamento di prova

Estrarre in una cartella Windows dedicata. `INSTALLA_UNA_VOLTA.bat` crea, se
assente, `setup/config.json` dall’esempio e si interrompe finché non viene
personalizzato. Inserire le tre credenziali/licenze solo in `secrets/`. Il tecnico
configura CALENDAR_ID e APP_HWID; il bootstrap verifica realmente firma e HWID.
Chromium usa argomenti espliciti, senza i bypass TLS/sandbox predefiniti di
OpenWA v4. Se la sandbox non parte sullo specifico host Docker/WSL2, fermare il
collaudo e far valutare al tecnico l’isolamento del container/VM. Non aggiungere
privilegi ampi o disabilitare la sandbox automaticamente. L’eventuale
`CHROME_NO_SANDBOX=1` è un opt-in tecnico che riduce l’isolamento e va valutato
consapevolmente, mai un’impostazione implicita dell’installazione.

Le password casuali vengono generate solo alla prima creazione di `.env`:
conservare la password dashboard nel gestore password del salone. Lo script non
rimpiazza una configurazione privata esistente. Docker Desktop deve essere
attivo, con motore Linux/WSL2 e avvio dopo il login Windows.

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
