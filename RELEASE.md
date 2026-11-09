# Releases automatiche di synk (versione RC)

## Stato

Il repository `oakvx/synkris` è **pubblico** e il workflow
[Prerelease and Weekly Release](.github/workflows/prerelease.yml) pubblica
ora **due tipologie di pacchetti**, sempre dopo la suite CI completa:

1. **Ogni commit che arriva a `master`:** una **GitHub Prerelease pubblica**,
   con tag univoco `v1.2.0-rc.6-commit.<SHA40>`. Ogni commit rimane
   identificabile e i tag **non vengono spostati**. Le PR non pubblicano
   release: la pubblicazione avviene dopo il merge, con il push su `master`.
2. **Ogni lunedì alle 06:17 UTC:** una **GitHub Release settimanale pubblica**
   con tag `v1.2.0-rc.6-weekly.AAAAwSS` (settimana ISO, per esempio
   `2026w46`). Funziona **anche senza commit nuovi**: prende l'ultimo
   commit del branch predefinito al momento dello schedule. Un tentativo
   successivo nella stessa settimana non crea duplicati o sposta il tag.

Le pubblicazioni avvengono automaticamente; **non** sono semplici bozze.
La settimana è calcolata in UTC/ISO per evitare doppioni anche quando
GitHub ritarda una run oltre la mezzanotte. GitHub può ritardare o omettere
esecuzioni `schedule` per carico o disattivarle dopo 60 giorni di inattività
di un repository pubblico.

**La release settimanale non è una versione stabile:** il software resta
`1.2.0-rc.6` e non ha completato il collaudo su Windows reale con
WhatsApp/Google Calendar, né la revisione di tutte le dipendenze.
La release settimanale viene pubblicata come GitHub Release normale,
ma il titolo e le note riportano *SOLO COLLAUDO* e `--latest=false`
impedisce di indicarla come "Latest". L'automazione **non incrementa**
`package.json`, non pubblica npm, non genera EXE o immagini Docker
distribuite e non rilascia file di attivazione.

## Regole prima della pubblicazione

Il job di pubblicazione dipende da `checks`, che richiama
`.github/workflows/ci.yml`. Deve concludersi con successo **tutta** la CI:

- Node.js 22/24 (sintassi,  test, compatibilità del provider).
- PHP 8.3 e PostgreSQL 16, test di integrazione e backup/restore sintetici.
- Windows PowerShell 5.1/7, ZIP, preflight e protezione dei file privati.
- Build Docker bot/dashboard, test Apache, doctor offline e guardrail.
- Audit delle dipendenze: blocca il rilascio per risultati assenti o rilievi
  **critici**. Rilievi elevati/moderati rimangono aperti e **non**
  sono autorizzazione all'uso reale.

Solo se la CI passa, il job:

1. Esegue `npm ci` e `npm run release:package` sul commit dell'evento.
2. Verifica struttura dell'archivio, SHA256 e `RELEASE-MANIFEST.json`.
3. Impone `sourceCommit === GITHUB_SHA` e `sourceDirty === false`.
4. Carica gli artifact temporanei dell'esecuzione (30 giorni).
5. Crea una GitHub Prerelease o una Release settimanale **pubblica**.
   ZIP, checksum e manifest sono gli unici allegati pubblicati;
   un tag esistente con commit/stato differenti blocca la procedura.

La workflow non usa `concurrency` con cancellazione o sostituzione dei
job in attesa: commit ravvicinati devono poter pubblicare ciascuno la
propria prerelease. I tag sono immutabili e gli eventuali rerun
identici sono idempotenti; il workflow non usa `--clobber` o
`git push --force` per sostituire asset precedenti.

**Non è un deployment automatico sui PC dei saloni:** viene prodotto
un download pubblico, non viene modificata alcuna installazione locale.

## Esecuzione manuale

Aprire **GitHub → Actions → Prerelease and Weekly Release → Run workflow**,
selezionando `master`. Il parametro `publication` offre:

| Modalità | Risultato |
| --- | --- |
| `artifacts-only` (predefinita) | Esegue i test e genera solo l'artifact CI, senza release |
| `commit-prerelease` | Pubblica una prerelease del commit scelto, se non esiste già |
| `weekly-release` | Pubblica la Release della settimana ISO corrente, se non esiste già |
| `draft-rc` | Crea la bozza non pubblica del tag canonico `v1.2.0-rc.6` |

La pubblicazione manuale è permessa **solo da `master`**; una build
`artifacts-only` può essere eseguita anche da un branch diverso.
Se si ripete la pubblicazione di un tag già esistente con un commit
diverso, l'operazione fallisce senza cambiare il tag originario.

## Artifact e checksum

Gli allegati sono:

- `synk-1.2.0-rc.6.zip` — ZIP piatto, con
  `INSTALLA_SYNK.bat`, `AVVIA_SYNK.bat`, dashboard,
  Docker/Compose, `PRIMO_AVVIO.txt` e documenti di collaudo.
- `synk-1.2.0-rc.6.zip.sha256` — checksum dell'archivio.
- `RELEASE-MANIFEST.json` — file, hash, commit e stato sorgenti.

Il checksum controlla l'integrità, **non costituisce una firma
di autenticità**. Il pacchetto segue una allowlist che esclude
`.git`, `.env`, `setup/config.json`, `runtime/`, `secrets/`,
sessioni, database, file di clienti e dipendenze di sviluppo.

Per generare localmente un pacchetto di prova:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run audit:release
npm run release:package
node scripts/release/archive.mjs artifacts/synk-1.2.0-rc.6.zip
(cd artifacts && sha256sum --check synk-1.2.0-rc.6.zip.sha256)
```

Per gli aggiornamenti di versione, sincronizzare il lockfile e verificare
i test prima del merge. Una nuova RC può essere preparata con
`npm version 1.2.0-rc.7 --no-git-tag-version --ignore-scripts`, poi
revisionando changelog, licenze e codice. La pubblicazione settimanale
non sostituisce una promozione stabile dopo collaudo.

**Licenza:** software proprietario/source-available. L'uso privato
non commerciale è consentito nei termini di `LICENSE.md`, mentre l'uso
commerciale e nei saloni richiede un accordo scritto salvo diversa
autorizzazione. Pubblicare pacchetti non concede diritti commerciali
automatici. Le chiavi e i file di licenza firmati vanno sempre
gestiti fuori dal repository e dalla release.


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
