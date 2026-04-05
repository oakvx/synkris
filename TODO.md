# TODO

## Priorita alta
- Integrare un provider WhatsApp reale nel nuovo `apps/bot-worker`, partendo dal codice legacy in root e mantenendo l'interfaccia provider pulita.
- Aggiungere invio email reale per `forgot-password` e `reset-password` con provider SMTP o API transactional.
- Consolidare il file `.env` locale con valori coerenti al nuovo stack per evitare conflitti con configurazioni storiche.
- Aggiungere un flusso di bootstrap iniziale per creare un utente admin o demo in ambiente locale.

## Backend e sicurezza
- Introdurre refresh token o session management piu' solido per il portale utenti.
- Aggiungere rate limiting su login, forgot-password e reset-password.
- Registrare audit log per login, reset password, connessioni/disconnessioni bot e modifiche alle impostazioni.
- Rafforzare la validazione input e la gestione errori con codici applicativi coerenti.
- Preparare una strategia di gestione segreti per ambiente server reale.

## Bot worker
- Salvare e ripristinare i reali artifact di sessione WhatsApp nel volume persistente condiviso al provider reale.
- Gestire stati piu' granulari: `reconnecting`, `expired`, `blocked`, `needs_reauth`.
- Aggiungere retry policy e backoff per reconnect del provider reale.
- Separare meglio command handling, session manager e provider events per facilitare test e manutenzione.

## Frontend
- Migliorare UX della dashboard con polling intelligente o SSE/WebSocket per aggiornamento stato bot in tempo reale.
- Aggiungere pagina cronologia eventi bot e attivita account.
- Aggiungere conferma visuale migliore per recupero password e reset completato.
- Introdurre gestione profilo utente, cambio password e logout da tutti i dispositivi.

## DevOps e operativita
- Aggiungere `ferma-tutto.bat` per spegnere in un colpo solo stack locale e servizi Docker.
- Aggiungere CI per `typecheck`, build, lint e verifica Prisma.
- Preparare compose separati per `dev` e `prod` o profili Compose dedicati.
- Aggiungere backup/restore documentati per volume Postgres e volume sessioni bot.
- Preparare osservabilita minima: log strutturati, request id e health checks piu' ricchi.

## Produzione futura
- Riallineare frontend a GitHub Pages o dominio reale quando il backend verra' pubblicato.
- Configurare Caddy con domini veri, TLS automatico e redirect HTTP -> HTTPS.
- Impostare CORS production-safe con allowlist per dominio finale.
- Valutare un job worker dedicato per task asincroni: email, retry, sync stato bot, pulizia token scaduti.
