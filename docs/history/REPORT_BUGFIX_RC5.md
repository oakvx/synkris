# synk 1.2 RC5 — Revisione bug della RC4

**Stato:** release candidata al collaudo, non certificata per saloni con clienti reali. Non aggiunge funzioni commerciali: corregge controlli di disponibilità e flussi operativi.

## Problemi corretti

1. **Slot offerto attraverso un impegno Google (grave)** — `src/services/gcal/availability.js`: la routine `computeSlots` poteva proporre un intervallo più corto del trattamento se `MAX_OVERRUN` consentiva lo sforamento teorico dell'ora di chiusura. Ora la tolleranza si applica solo a una fascia che termina alla chiusura, mai a una fascia che termina contro un appuntamento occupato; gli eventi dopo la chiusura non allungano le disponibilità.
2. **Calendario generale ignorato da flussi standard** — `getFreeSlotsForDay` e `getFreeSlotsForProfessional` interrogano e uniscono gli impegni sia del calendario dell'operatrice sia di quello principale del salone (`CALENDAR_ID`, quando presente), bloccando l'offerta se una risposta è mancante o errata.
3. **Risposta Calendar incompleta interpretata come agenda vuota** — `src/services/calendar-guard.js` interrompe il controllo se `events.list` non restituisce una collezione valida; prima il risultato mancante diventava `[]`.
4. **Riattivazione non sicura di appuntamenti annullati** — `dashboard/api/router.php`: il cambio di stato verso `pending`/`confirmed` verifica gli eventi esterni mantenendo il lock per operatrice. Un appuntamento annullato non può essere riattivato modificando soltanto lo stato PostgreSQL: occorre creare una nuova prenotazione verificata.
5. **Lista d'attesa bloccata dopo offerta scaduta** — `src/services/waitlist/waitlist.js` riapre le richieste ancora valide dopo la scadenza dell'offerta da 15 minuti; le richieste già scadute vengono marcate `expired`.
6. **Possibili notifiche duplicate della stessa offerta** — La registrazione dell'offerta controlla ora `RETURNING`; su un duplicato non invia un nuovo messaggio. In caso di eccezione non lascia la richiesta bloccata in `offered`.
7. **Parametri malformati di disponibilità lista d'attesa** — `src/services/waitlist/availability.js` blocca date `NaN`, identificativi professionista non numerici e intervalli oltre 16 ore prima della query PostgreSQL.
8. **Giorni di chiusura traslati in UTC** — `src/services/gcal/availability.js` usa il giorno locale del salone tanto nella ricerca generale quanto per singola operatrice, senza conversione a `toISOString().slice(0,10)`.

## Prove automatiche effettuate

- `npm test`: **68/68** (58 test RC4 più 10 nuovi test di regressione RC5).
- `php tests/php-datetime.test.php`: **10 casi** su fusi, ora legale/solare.
- Controllo sintattico completo JavaScript, CommonJS e PHP: nessun errore rilevato.
- Pacchetto ZIP piatto, verificato integro, senza `.env`, credenziali o sessioni WhatsApp.

## Limiti non risolti dal collaudo automatico

- Assenti in questo ambiente Docker Desktop, PostgreSQL, credenziali Google e una sessione WhatsApp del salone: **nessun test end-to-end** e nessun collaudo reale di concorrenza con transazioni PostgreSQL.
- Il lockfile npm **non è presente** e la build Docker non è stata riprodotta con `npm ci`; la cache/registro npm non erano disponibili.
- Google Calendar non partecipa alla transazione ACID del database PostgreSQL. Rimangono possibili condizioni di gara tra la verifica e la creazione remota. Synk necessita quindi di riconciliazione e supervisione delle anomalie.
- OpenWA è un client WhatsApp non ufficiale: connessione, aggiornamenti e limitazioni dell'account vanno monitorati nel pilota.

**Prima dei clienti reali:** eseguire `COLLAUDO.md` su PC di prova e attestare ciascun punto.
