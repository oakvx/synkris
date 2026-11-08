# synk 1.2 RC6 - protocollo di collaudo (non eseguito su Windows reale)

La ricostruzione RC6 richiede una nuova verifica completa. I test automatici
sono descritti in REPORT_RICOSTRUZIONE_RC6.md e non attestano il collaudo reale.
**La firma di questa checklist richiede un PC di prova con i calendari e la sessione
WhatsApp del salone.** Non usare dati reali prima di completarla.

## Ricostruzione RC6 (obbligatorio)
- [ ] Verificare con il tecnico la nuova dashboard: nessuna parita presunta con i file persi.
- [ ] Login/logout, scadenza sessione, token CSRF e accesso negato ai file interni.
- [ ] Servizi/operatrici/abilitazioni, ordine servizi e buffer per operatrice modificati dalla dashboard.
- [ ] Una risposta incerta/non disponibile non mostra un salvataggio riuscito; nessun fallback localStorage.
- [ ] Distinguere salvataggio DB, Calendar in coda e Calendar da verificare; niente modifiche su job pendenti.
- [ ] Verificare import OpenWA v4, stato CONNECTED, shutdown del browser, QR, sessione persistente e riconnessione con account di prova.
- [ ] Verificare sandbox Chromium sul PC Docker/WSL2: nessun bypass implicito di sandbox o TLS.
- [ ] Esaminare npm audit e approvare/correggere le dipendenze prima di dati reali.

## Installazione e sicurezza
- [ ] Docker Desktop/WSL2 si avvia dopo login Windows; i container tornano attivi senza interventi.
- [ ] `localhost:8080` è accessibile solo dal PC del salone; login, logout e tentativi falliti sono testati.
- [ ] Licenza, credenziali Calendar e password restano in `secrets/`, `.env` e `runtime/`, fuori dal pacchetto.
- [ ] Verificare importazione iniziale di `setup/config.json` e modifiche da dashboard.

## Verifiche di regressione RC4 (obbligatorie)
- [ ] In dashboard, salva un appuntamento alle 09:30 a gennaio (offset +01) e a luglio (offset +02): PostgreSQL e Google devono mostrare le stesse ore locali.
- [ ] Le ore 02:30 del 29 marzo 2026 (inesistente) e 25 ottobre 2026 (ambigua) devono essere respinte, non spostate automaticamente.
- [ ] Inserire in Google Calendar un evento **intera giornata**; verificare che blocchi anche gli slot nelle prime due ore del giorno.
- [ ] Verificare che l'outbox crei gli eventi nel `calendar_id` assegnato al job, non sempre nel calendario predefinito.
- [ ] Una prenotazione multipla WhatsApp e una proposta lista d'attesa devono essere rifiutate se il calendario generale è occupato anche quando quello dell'operatrice è libero.
- [ ] Provare agenda “futuri/passati” nelle ore a cavallo della mezzanotte locale.

## Regressioni RC5 (da verificare sul PC di prova)
- [ ] Un evento Google solo nel calendario del salone blocca gli orari offerti dal percorso standard WhatsApp, anche quando l'operatrice è libera.
- [ ] Intervalli inferiori alla durata del servizio, adiacenti a eventi occupati, NON vengono proposti, neanche con MAX_OVERRUN abilitato.
- [ ] Un giorno di chiusura del salone a mezzanotte italiana non offre disponibilità del giorno precedente in UTC.
- [ ] Se Google Calendar risponde senza il campo eventi o con payload incompleto, il salvataggio è rifiutato.
- [ ] La modifica di stato di un appuntamento verso pending/confirmed verifica Google Calendar; un annullato non si riattiva senza nuova prenotazione.
- [ ] Le offerte della lista d'attesa scadono senza bloccare la richiesta fino a fine consenso; un invio incerto non duplica la stessa proposta.
- [ ] Le proposte della lista d'attesa con timestamp non validi o intervalli maggiori di 16 ore vengono scartate senza interrogare PostgreSQL.

## Prenotazioni / doppie prenotazioni
- [ ] Creare una nuova cliente senza appuntamenti precedenti, prenotare un trattamento, verificare una sola scheda cliente e un solo evento Google.
- [ ] Indurre un errore Calendar e verificare che le vecchie viste non mostrino una prenotazione fittizia: endpoint legacy HTTP 410 e nessun nuovo dato locale.
- [ ] Confrontare le eventuali prenotazioni salvate nel browser dalla vecchia versione prima di abbandonare i dati legacy.
- [ ] Su almeno due calendari (operatrice + salone) inserire un evento esterno manuale; testare che la dashboard rifiuti uno slot in conflitto (HTTP 409).
- [ ] Togliere l'accesso Calendar o interrompere Internet; i salvataggi devono fallire (503) senza inserire un appuntamento confermato.
- [ ] Verificare Google Calendar creato, modificato, annullato e nessun doppione dopo riavvio durante l'outbox.
- [ ] Testare eventi ricorrenti, giornate intere, appuntamenti fuori orario, ferie, pause e cambio operatrice.
- [ ] Testare due salvataggi contemporanei per lo stesso slot: il vincolo PG blocca uno dei due.
- [ ] Testare trattamento di 45' + buffer 15', modifica durata per singola operatrice, 2-6 servizi e ordine servizi.
- [ ] Verificare sincronizzazione *entrante* Google, conflitti e approvazione umana in Centro operativo.
- [ ] Verificare promemoria, ora legale/solare e idempotenza dopo riavvio.

## WhatsApp e AI
- [ ] QR in dashboard, riconnessione, scadenza sessione, avvio da PC acceso dopo spegnimento.
- [ ] Intervento umano: bot tace soltanto per la conversazione in carico, poi torna attivo.
- [ ] Per default `MULTI_BOOKING_WHATSAPP_ENABLED=0`: il bot singolo rimane utilizzabile.
- [ ] In collaudo abilitarlo e provare sia `/multi` sia una richiesta naturale con due trattamenti nominati.
- [ ] Provare timeout, rifiuto consenso, orario già occupato, nome errato, disconnessione provider e richiesta doppia concorrente.
- [ ] Ollama opzionale: modelli disponibili, classificatore separato, fallback se Ollama non risponde.

## Backup e ripristino
- [ ] Esportare un backup su USB BitLocker con checksum corrispondente; verificare la chiave di recupero separata.
- [ ] Testare RESTORE solo su un PC di prova con database popolato. Accertare flag di manutenzione scritto **prima** di pg_restore.
- [ ] Durante manutenzione niente prenotazioni, outbox, sync entrante, promemoria o follow-up automatici.
- [ ] Confrontare manualmente eventi Google e PostgreSQL (eventi orfani, mancanti, modifiche in conflitto); non riavviare operazioni stale.
- [ ] Verificare la riattivazione tecnica consapevole, con nuova sincronizzazione senza duplicati.
- [ ] Testare AGGIORNA_SYNK_TECNICO con ZIP piatto, rollback codice se healthcheck fallisce, retention runtime/secrets.

## Privacy e notifiche
- [ ] `privacy` mostra l'informativa specifica del salone; `cancella dati` elimina chat locale e crea una richiesta di revisione.
- [ ] Completare revisione esterna e chiudere la richiesta dal Centro operativo; verificare la conservazione dati obbligatori.
- [ ] Verificare eliminazione chat oltre CHAT_RETENTION_DAYS e nessuna cancellazione automatica di prenotazioni.
- [ ] Provare notifiche locali e, solo con opt-in, email SMTP senza nominativi o numeri clienti.
- [ ] Accertare che PC spento significhi NESSUNA notifica esterna automatica (limite architetturale dichiarato).

## Verbale
PC/Windows: __________  Docker: __________  Data: __________
Calendari test: __________  WhatsApp di test: __________
Esito complessivo: [ ] PASSA  [ ] NON PASSA
Anomalie/azioni correttive: ______________________________________________
Tecnico responsabile: ___________________________________________________
