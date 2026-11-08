# Changelog

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
