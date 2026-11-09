## Weekly Release automatica — VERSIONE DI COLLAUDO

Questa GitHub Release viene **pubblicata automaticamente una volta a
settimana**, dopo tutti i controlli CI e il packaging, anche quando il codice
non e' cambiato rispetto alla settimana precedente.

**ATTENZIONE:** la versione distribuita resta una `-rc.N` (release candidate)
e **non e' una release stabile ne' un'autorizzazione all'uso in produzione**.
Il workflow disabilita intenzionalmente l'indicazione GitHub "Latest".
La pubblicazione rende ZIP, checksum, manifest e sorgente accessibili
pubblicamente, ma non conferisce licenze commerciali.

### Contenuto e provenienza

- `synk-<versione>.zip`: ZIP piatto per Windows, con
  `INSTALLA_SYNK.bat`, `AVVIA_SYNK.bat`, Docker/Compose e guida
  `PRIMO_AVVIO.txt`.
- `synk-<versione>.zip.sha256`: checksum da verificare prima di estrarre.
- `RELEASE-MANIFEST.json`: SHA del commit effettivo, provenienza e hash dei
  file. L'identita' del commit e' riportata anche in fondo a queste note.

Non sono incluse credenziali, licenze cliente, runtime, QR, sessioni
WhatsApp, database, backup o file privati. Il pacchetto non include
Docker Desktop/WSL2 e non contiene un eseguibile standalone.

### Vincoli prima di usare synk

- Installare e provare **solo su PC di collaudo con dati sintetici**.
- Eseguire e firmare `COLLAUDO.md` prima di un eventuale utilizzo reale:
  Google Calendar e WhatsApp reali, sandbox Chromium, licenza/HWID,
  backup/ripristino e Windows non sono certificati dalla CI.
- Consultare l'audit dipendenze della relativa esecuzione CI. Le
  vulnerabilita' di livello **critico** bloccano il workflow; altri rilievi
  elevati/moderati richiedono revisione e mitigazione prima della produzione.
- Il codice e' proprietario/source-available. `LICENSE.md` disciplina l'uso;
  uso commerciale o in un salone richiede un accordo scritto, salvo specifica
  autorizzazione del titolare.

Questa release **non incrementa automaticamente `package.json`**.
Il tag identifica la settimana ISO del rilascio; il manifest identifica
il preciso sorgente verificato. Un rilancio non sposta il tag settimanale.

### Aggiornamenti di installazioni precedenti

Le vecchie versioni usavano nomi launcher e allowlist diversi: l'aggiornamento
automatico da una vecchia RC puo' essere rifiutato. Non forzare l'updater
o eliminare volumi/dati: consultare `RELEASE.md` e usare una migrazione
tecnica verificata.
