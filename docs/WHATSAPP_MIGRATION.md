# Migrazione da OpenWA a whatsapp-web.js

**Aggiornamento dell’8 novembre 2026.** Il runtime usa `whatsapp-web.js@1.34.7` (Apache-2.0) e `qrcode@1.5.4` (MIT). OpenWA e il relativo override `parse-url` sono rimossi da manifest e lockfile. Non è una migrazione a OpenWA v5 né alla WhatsApp Business Cloud API ufficiale.

Il codice è ancora una RC ricostruita. I test offline non sostituiscono l’associazione e il collaudo con un account dedicato. Questa modifica non pubblica una release, non cambia la visibilità del repository e non disattiva firma/HWID.

## Che cosa cambia

| Contratto applicativo | Implementazione nuova |
| --- | --- |
| Avvio | `Client` + `LocalAuth`; attesa sia di `initialize()` sia dell’evento nativo `ready`. `authenticated` o il solo stato `CONNECTED` non bastano. |
| QR | Stringa nativa `qr` trasformata in PNG in RAM. Nessun QR su disco, terminale o log; endpoint amministrativo autenticato, `no-store`, validità documentale di 20 secondi. |
| Messaggi | Evento nativo `message`; solo conversazioni dirette, testo/caption fino a 4.000 caratteri, ID serializzato per la deduplicazione. Nessun download automatico di media. |
| Destinatari LID | Risoluzione esplicita con `getContactLidAndPhone`; soltanto una corrispondenza verificata verso `@c.us` entra nel core. Mai interpretare le cifre di un LID come numero telefonico. |
| Invio | Il piccolo adapter `sendText` chiama `sendMessage` una volta, senza ricevuta di lettura automatica e con attesa limitata a 15 secondi (prima del timeout del proxy). Un errore, timeout o risultato senza ID dopo la chiamata è **esito incerto**, non autorizzazione a riprovare automaticamente. |
| Stato | `ready` più `WAState.CONNECTED`; un polling vecchio non può riattivare lo stato dopo una disconnessione. |
| Arresto | Drain limitato del lavoro già avviato, poi `destroy()`, **non `logout()`**: la sessione viene conservata. Compose concede 30 secondi, oltre il limite applicativo di 20. |
| Guasto terminale | Stato offline immediato e arresto del processo; Docker Compose può riavviarlo tramite `restart: unless-stopped`. Nessuna acquisizione automatica di sessioni in conflitto. |

I gruppi (anche senza `isGroupMsg`), i messaggi propri, gli stati, i broadcast, i canali e i payload non supportati vengono esclusi prima della persistenza. Se WhatsApp non fornisce la mappatura di un LID, il messaggio viene scartato senza inventare un contatto. La normalizzazione ha coda limitata e lookup con timeout; il dispatcher conserva ordine per chat e inbox PostgreSQL basata su hash, non una promessa di consegna exactly-once.

## Sessioni: nuova associazione obbligatoria

**I formati OpenWA e LocalAuth non sono compatibili. Non copiare, rinominare, convertire o cancellare automaticamente i vecchi file.** Prima del passaggio fermare la vecchia istanza: due bot attivi sullo stesso account possono inviare risposte o notifiche duplicate, anche se ogni processo ha la propria deduplicazione.

Nel deploy Compose, già configurato con `SESSION_PATH=/app/runtime/session`:

```text
runtime/session/
├── … file OpenWA preesistenti, lasciati intatti
└── whatsapp-web.js/
    ├── session-whatsapp-ai/       profilo Chromium LocalAuth
    └── web-cache/                 cache privata del client web
```

`WHATSAPP_SESSION_ID=whatsapp-ai` è il default. Cambiarlo seleziona un altro profilo e può richiedere un nuovo QR; non eseguire contemporaneamente due processi sullo stesso profilo.

Senza `SESSION_PATH`, il nuovo default è `<APP_DATA_DIR>/session/whatsapp-web.js` (con i fallback di `resolveDataDir`). Il vecchio default OpenWA `<APP_DATA_DIR>/session-v5` rimane intatto. L’intera directory privata deve restare scrivibile dall’utente del bot; il bootstrap Compose conserva il mount `runtime/` e prepara la proprietà non-root.

Il backup PostgreSQL **non include il profilo LocalAuth**, le licenze o i segreti. Proteggere separatamente eventuali copie autorizzate di `runtime/` e `secrets/`. La portabilità del profilo fra PC/sistemi operativi non è garantita: potrebbe servire una nuova associazione.

## Procedura tecnica di collaudo

1. Usare un account WhatsApp e calendari dedicati, senza clienti reali. Verificare autorizzazione, file firmato/HWID e configurazione prima dell’avvio.
2. Conservare backup verificato del database, codice/lockfile precedenti, configurazione e directory privata delle vecchie sessioni. **Mai `docker compose down -v`.**
3. Fermare l’istanza OpenWA e qualsiasi altra copia del bot. Eseguire l’aggiornamento dal pacchetto ufficiale con `AGGIORNA_SYNK_TECNICO.bat`, oppure dal checkout autorizzato seguendo [RELEASE.md](../RELEASE.md). Non sovrascrivere `.env`, `setup/config.json`, `runtime/` o `secrets/`.
4. Ricostruire le immagini dal nuovo lockfile e avviare i servizi. Il volume runtime resta quello esistente; la nuova sessione vive nella sottocartella mostrata sopra. Non vengono eseguite conversioni di sessione o dello schema DB specifiche di questo provider.
5. Accedere alla dashboard → **Conversazioni** e associare il nuovo QR dal telefono. `/health` indica solo un processo vivo; `/ready` deve restare 503 finché WhatsApp non è pronto o il DB non è raggiungibile. Il QR non viene offerto nei log.
6. Inviare dal numero di prova un testo e una caption, poi verificare `privacy`, `reset`, presa in carico operatrice e prenotazione su calendari dedicati. Verificare che i gruppi non ricevano risposte automatiche. Se disponibile, provare anche un mittente rappresentato da LID.
7. Riavviare il bot sullo stesso host e verificare il riuso del profilo senza QR, i messaggi e i promemoria. Provare anche disconnessione/revoca dal telefono, riavvio controllato e nuova associazione quando necessaria. Non assumere che una sessione revocata possa essere ripristinata dai vecchi file.
8. In caso di **esito invio incerto**, verificare WhatsApp prima di ripetere manualmente l’operazione; non introdurre retry automatici. La dashboard conserva il testo e mostra un avviso, senza dichiarare un invio sicuramente fallito.
9. Compilare [COLLAUDO.md](../COLLAUDO.md) con gli esiti effettivi prima di qualsiasi impiego operativo.

Le immagini del README usano soltanto fixture frontend e **non sono prove di questa associazione**.

## Configurazione conservata

| Variabile | Regola |
| --- | --- |
| `SESSION_PATH` | Base privata persistente; il provider aggiunge `whatsapp-web.js/`. In Compose `/app/runtime/session`. |
| `WHATSAPP_SESSION_ID` | Default `whatsapp-ai`; 1–64 caratteri ASCII alfanumerici, `_` o `-`, nessun percorso. |
| `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` | Browser locale; in Docker `/usr/bin/chromium`. Nessun browser scaricato dai lifecycle npm. |
| `CHROME_HEADLESS` | Headless salvo valore esatto `0`. |
| `CHROME_NO_SANDBOX` | Default `0`; solo `1` abilita il bypass consapevole. Nessun bypass TLS/CSP implicito. Verificare isolamento e sandbox sul PC di destinazione. |
| `AUTH_TIMEOUT_MS` | Millisecondi per l’inizializzazione auth/injection del provider, default 30.000; il provider tratta `0` come default. Non è un timeout totale del collaudo. |
| `QR_TIMEOUT_MS` | Millisecondi dall’inizio della richiesta QR, senza azzerare il termine a ogni rotazione; default `0`, nessun limite aggiuntivo. Non cambia la scadenza del QR lato WhatsApp. |

La firma della licenza viene verificata prima di creare il provider e ricontrollata dopo l’associazione, prima di abilitare worker e gestione dei messaggi. Il monitor periodico resta attivo. I test con factory/encoder iniettati sono soltanto unit test: non esiste una variabile d’ambiente che salti licenza, firma o HWID.

## Rollback

Fermare prima il bot migrato. Conservare separatamente il nuovo profilo e ripristinare il precedente codice **insieme al suo lockfile**, poi ricostruire le immagini. I file OpenWA precedenti non sono stati cancellati, ma ciò **non garantisce** che il vecchio dispositivo sia ancora autorizzato da WhatsApp: verificarlo, senza avviare due bot contemporaneamente. Un rollback del codice non annulla le normali migrazioni DB o lo stato esterno di Calendar/WhatsApp.

## Evidenza e limiti

- Installazione da lockfile, controlli di repository/sintassi e **139 test Node** riusciti localmente; includono API reali importate, strategia LocalAuth reale senza browser, modello Message reale, PNG QR sintetico, adapter, dispatcher/inbox, endpoint amministrativi e messaggio d’errore della dashboard.
- Audit produzione dell’8 novembre 2026: **19 rilievi — 0 bassi, 8 moderati, 11 elevati, 0 critici**. Il gate non approva automaticamente quelli elevati. Nessun downgrade/`npm audit fix --force` applicato.
- SBOM CycloneDX locale: **335 componenti**; OpenWA assente, licenze Apache-2.0 e MIT dei nuovi componenti presenti. [Testi e avvisi distribuiti](../deploy/THIRD_PARTY_NOTICES.md).
- Verificare la CI **del commit della migrazione**, non soltanto la CI storica della base. I test non hanno aperto account WhatsApp reali né certificato il PC Windows/Docker Desktop/WSL2 del salone.
- Restano da completare QR reale, persistenza/riconnessione con account dedicato, integrazione Google, revisione dei rilievi, restore e validazione operativa. WhatsApp Web rimane un’integrazione non ufficiale soggetta ai termini e agli aggiornamenti del servizio, con possibili rischi per l’account.

La licenza del progetto resta [proprietaria con uso privato non commerciale gratuito](../LICENSE.md): ogni altro uso richiede un accordo commerciale. Apache-2.0 riguarda la libreria, **non cambia synk in software open source**. I termini personalizzati, i contratti e l’inventario delle altre dipendenze richiedono ancora revisione professionale prima della distribuzione commerciale.
