# Changelog

## Non rilasciato

### Rimozione del vecchio sistema di attivazione (8 novembre 2026)
- Eliminati verificatori Node/PHP, worker firma, HWID, scadenze, import dei file
  di licenza e monitor periodico; nessun flag di bypass o stato sempre valido.
- Runtime, dashboard e bootstrap funzionano senza file/chiavi di licenza.
  Rimangono login, sessioni, origin/CSRF, token, Google, validazione setup,
  readiness WhatsApp, loopback e protezioni dopo restore.
- Wizard, avvio e riparazione Windows richiedono solo il JSON Google; invariati
  permessi, backup atomico, mutex, ownership, conferme e rollback del rifiutato.
- Doctor e report non espongono più stati di licenza. Onboarding ridotto a cinque
  controlli: database, catalogo, WhatsApp, Calendar e backup.
- Nessuna cancellazione di dati legacy; preservate esclusioni e redazione.
  Compose monta solo il JSON Google dove serve, non tutti i segreti nel PHP.
  Rimossi requisiti PHP/libsodium e file obsoleti dalla allowlist di rilascio.
- Test aggiornati: startup e installazione senza attivazione, impostazioni
  obsolete ignorate, bootstrap/import una tantum su PostgreSQL CI sintetico,
  accesso PHP con login e protezioni auth/CSRF ancora obbligatorie.
- Aggiornati guide, termini tecnici obsoleti e anteprime. I diritti d’uso
  proprietari e le licenze dei terzi non sono stati ampliati o sostituiti.

Le voci successive conservano la cronologia; i riferimenti all’attivazione
precedente sono superati dalla rimozione sopra.

### Percorso guidato Windows e checklist (8 novembre 2026)
- Wizard senza JSON manuali: catalogo/orari iniziali validati prima del DB, nome
  salone inizializzato una volta, import file privati e ambiente riprendibile.
- Preflight Docker locale/Linux/Compose, doctor read-only senza rete/dependencies
  con verificatore di produzione, attesa servizi e blocco progetti di altre root.
- Menu nel launcher esistente: avvio senza build/pull, diagnostica, finestra
  password mascherata, autostart per utente opt-in e report status-only locale.
- Esteso il guard Docker locale/ownership anche agli entrypoint tecnici storici,
  prima delle operazioni di aggiornamento, restore, export, riconciliazione e AI.
- Recupero configurazione e correzione file privati soltanto prima del primo
  import, con conferme e backup; rollback del file rifiutato dal doctor.
- Checklist dashboard autenticata: DB, firma/attivazione, catalogo, WhatsApp,
  sync Calendar e backup; progress/azioni sicure, nessun vecchio verde su errore
  e nessuna certificazione produzione implicita.
- Backup atomici finali con staging, pg_restore --list e SHA256. Conservati i
  precedenti in caso di errore; metadata recenti non attestano un restore.
- 239 test Node, casi backup con fault injection, regressioni Windows 5.1/7,
  integrazioni PG/PHP e test Docker doctor effettivo. CI aggiunge restore reale
  di un DB PostgreSQL 16 sintetico: nessuna prova sul PC destinatario implicita.
- Guide, checklist di collaudo e anteprime aggiornate con sole fixture sintetiche.
  Nessuna nuova PR/tag/release o pubblicazione npm, nessun bypass attivazione,
  allargamento porte, sandbox disattivata o cambio ai diritti d'uso.

### Migrazione e decisione di licenza precedenti

- Definito il modello proprietario/source-available: uso privato non commerciale
  gratuito per persone fisiche; ogni altro uso su accordo commerciale scritto,
  senza fissare prezzi o royalties e senza affermare conseguenze penali automatiche.
- Allineati metadati, README, asset e istruzioni alla licenza personalizzata.
  Firma/HWID restano richiesti anche per l’attivazione privata gratuita, con
  emissione manuale; nessun bypass o sistema automatico di incasso introdotto.
- Migrato il runtime da OpenWA a whatsapp-web.js 1.34.7 (Apache-2.0), con
  LocalAuth isolato e QR PNG soltanto in RAM tramite qrcode 1.5.4 (MIT).
  Rimossi OpenWA e l’override parse-url dal lockfile; vecchie sessioni intatte,
  nuova associazione richiesta e arresto senza logout.
- Introdotto adapter per ready/stato, invio singolo, esito incerto senza retry,
  normalizzazione di messaggi e LID, coda limitata e chiusura anche di un browser
  avviato in ritardo. Conservati dispatcher/inbox e verifica firma/HWID.
- Estesa la suite a 139 test Node; contratto nuovo SDK nel job Docker e verifica
  documentazione offline in CI. Aggiornate guide, asset e avvisi di terzi.
- Audit produzione migrato: 19 rilievi (8 moderati, 11 elevati, zero critici),
  contro 57 precedenti; SBOM locale di 335 componenti. Nessun via libera produzione
  o collaudo WhatsApp reale implicito, nessuna release pubblicata.

## 1.2.0-rc.6 — ricostruzione per collaudo

- Riscritti i componenti mancanti `dashboard/`, `deploy/`, `assets/`, `strumenti/`
  e aggiunto un esempio di configurazione iniziale senza dati reali.
- Dashboard autenticata, sessioni limitate, CSRF, verifica Ed25519 della licenza,
  proxy interno con allowlist e accesso web limitato agli entrypoint autorizzati.
- Editor normalizzato PostgreSQL: clienti indipendenti dallo storico, servizi
  ordinati, durate per operatrice e buffer; verifica Calendar fail-closed,
  transazione/outbox, controllo concorrenza e sospensione durante riconciliazione.
- Centro operativo, chat/presa in carico/QR, note cliente, catalogo, orari,
  assenze, consenso lista d’attesa, impostazioni e download backup.
- Ricostruiti installazione, aggiornamento ZIP piatto con checksum/manifest,
  backup binario, ripristino sospeso e export USB verificato BitLocker.
- Aggiunti lockfile npm, protezioni Git, build con `npm ci`, controlli di pacchetto,
  test UI/archivio/PHP/Windows/database e workflow CI/prerelease manuale.
- **Compatibilità OpenWA:** la versione 5.1.0 dichiarata nel pacchetto precedente
  non esporta `create`/`ev` usati dal bot. Dipendenza allineata alla 4.76.0 esatta,
  con test del contratto di import, stato `CONNECTED` e chiusura browser v4.
  Argomenti Chromium espliciti senza bypass impliciti TLS/sandbox, QR nei log
  disattivato. Non è stata effettuata una migrazione API v5.
  Nodemailer aggiornato alla 10.4.0 e parser URL transitivo fissato alla 8.1.0
  per rimuovere gli avvisi critici del parser, con test di compatibilita.
  Rimangono dipendenze legacy e avvisi elevati: vedi il report RC6.

### Non certificato

Nessun collaudo reale di Docker Desktop/WSL2, account WhatsApp, Google Calendar,
SMTP, USB BitLocker e recovery completo sul PC del salone. L’interfaccia
ricostruita non garantisce parità grafica/funzionale con i file persi. La
pubblicazione stabile rimane fuori da questa procedura.

## 1.2.0-rc.5 — versione precedente importata

Vedi `REPORT_BUGFIX_RC5.md` e `REPORT_BUGFIX_RC4.md`. Quei report sono storici:
i risultati dichiarati non attestano automaticamente la ricostruzione RC6.
