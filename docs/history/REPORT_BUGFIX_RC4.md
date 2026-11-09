# synk 1.2 RC4 — Audit correttivo della RC3

**Stato:** release candidata al collaudo, non certificata per l'impiego con clienti reali.

## Bug riprodotti e corretti

1. **Fuso orario delle prenotazioni dashboard (critico).** Un input HTML `datetime-local` (`2026-07-15T09:30`) veniva interpretato da `strtotime()` nel fuso predefinito di PHP, potenzialmente UTC, mentre PostgreSQL opera in `Europe/Rome`. L'API ora converte esplicitamente data/ora in ISO 8601 con offset prima di controllare l'occupazione Calendar e scrivere in PostgreSQL. Le ore inesistenti e quelle ambigue al cambio di ora legale sono respinte; il client deve scegliere un orario non ambiguo.
2. **Eventi Google in calendario errato.** Il metodo `createCalendarEvent` ignorava il `calendarId` del job outbox e utilizzava sempre il calendario predefinito. Ora rispetta il calendario del job e fa la verifica dei permessi sullo stesso ID.
3. **Google Calendar: eventi di intera giornata nelle prime ore del giorno.** Le date senza orario venivano considerate mezzanotte UTC, anziché mezzanotte nel fuso del salone. Corretto il calcolo per `Europe/Rome`, anche nel passaggio ora legale/solare. Per calendari situati in altri fusi occorre adeguare `TZ` a quello del calendario.
4. **Prenotazione multipla WhatsApp.** Il controllo `freebusy` interrogava soltanto il calendario dell'operatrice. Ora controlla l'unione di calendario dell'operatrice e calendario principale del salone, bloccando la proposta se una risposta manca o mostra un conflitto.
5. **Lista d'attesa: proposte di slot liberati.** La verifica avveniva soltanto sul calendario dell'operatrice. Ora richiede disponibilità su entrambi i calendari configurati.
6. **Filtri agenda al cambio data.** Le viste “futuri” e “passati” utilizzavano la data UTC dal browser (`toISOString().slice(0,10)`), che poteva differire dal giorno locale. Ora il filtro usa la data locale del PC.

## Test effettuati in questo ambiente

- **58 test Node.js** superati (51 originali + 7 regressioni nuove).
- **10 verifiche PHP** su conversione oraria, fusi e transizioni DST: superate.
- Verifica sintattica di tutti i file `.js`, `.cjs` e `.php` nel pacchetto: superata.
- Verifica dei riferimenti a script locali e degli ID HTML, integrità ZIP, esclusione di `.env` e sessioni: superata.
- Dipendenze: **lockfile npm non generato**. La cache npm è vuota (`ENOTCACHED`) e il registry non è verificabile in questo ambiente. Non dichiarare una build Docker riproducibile prima di generare `package-lock.json` e testare `npm ci` online.

## Test NON eseguiti

Nessuna verifica end-to-end su Windows 11 + Docker Desktop + PostgreSQL + WhatsApp/OpenWA + Google Calendar con credenziali reali, né test SMTP e ripristino database reale. Sono necessari prima di usare il bot con appuntamenti effettivi. L'attuale client WhatsApp non ufficiale implica un rischio aggiuntivo di disconnessione o limitazione dell'account.

## Collaudo richiesto al tecnico

Seguire `COLLAUDO.md`: in particolare uno slot locale alle 09:30 d'inverno e d'estate, blocchi Google di intera giornata, calendario principale occupato e operatrice libera, aggiornamento del codice, copia di sicurezza e ripristino su database di prova.
