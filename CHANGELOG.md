# Changelog

## Non rilasciato

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
