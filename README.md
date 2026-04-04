# WhatsApp AI Portal

## Panoramica
Questo repository ora evolve verso un monorepo con separazione netta tra frontend statico, backend API, bot worker, database PostgreSQL e reverse proxy Caddy.

Flusso target:
Frontend statico (GitHub Pages o Vite locale) -> API HTTP/HTTPS -> backend API -> bot-worker + PostgreSQL + session storage server-side.

La root storica resta come riferimento e compatibilita per il vecchio bot Node (`index.js`, `util.js`, `gcal.js`, `bookings-norm-pg.js`), ma la nuova struttura di lavoro e' questa:

- `apps/frontend`: portale React + Vite + TypeScript, statico e compatibile con GitHub Pages.
- `apps/api`: API Express + TypeScript con auth, CORS, impostazioni, stato bot e recupero password.
- `apps/bot-worker`: worker separato con provider WhatsApp astratto e storage persistente su volume Docker.
- `packages/shared`: contratti condivisi, tipi e schemi zod.
- `prisma`: schema database e migrazioni.
- `infrastructure/caddy`: Caddyfile per reverse proxy locale/produzione.
- `infrastructure/scripts`: script di supporto, incluso il wrapper per importare dati legacy.

## URL frontend GitHub Pages
Il sito statico finale e' previsto su:

- `https://oakvxish.github.io/synkris`

Per questo motivo il frontend e' configurato con base path GitHub Pages `'/synkris/'` e il recupero password genera link compatibili con `https://oakvxish.github.io/synkris/#/login` quando usi `APP_BASE_URL` di produzione.

## Architettura attuale trovata nel repository
Prima del refactor il repository conteneva gia materiale utile:

- Un bot WhatsApp legacy in root (`index.js` + `util.js`) con logica conversazionale estesa e uso di `@open-wa/wa-automate`.
- Persistenza PostgreSQL parziale per servizi, professionisti, appuntamenti, chat session e hold (`bookings-norm-pg.js`, `01_migrate_json_to_pg.mjs`, `gcal.js`, `util.js`).
- Dashboard e admin legacy statiche/PHP (`public/`, `dashboard.html`, `dashboard.php`, `server.js`).
- Configurazioni JSON e script di migrazione/importazione in root.

I gap principali rispetto al target erano:

- frontend, backend e bot ancora mescolati nella root;
- nessun portale utenti moderno con auth dedicata;
- nessun bot-worker separato dall'API;
- nessuna fonte di verita ORM/migration per la parte portale utenti;
- nessun recupero password;
- nessun Compose/Caddy pronti per l'architettura finale.

## Cosa e' stato implementato
### Frontend
`apps/frontend` contiene:

- login;
- registrazione;
- recupero password con preview locale del token/link di reset;
- dashboard protetta;
- pagina `Connetti WhatsApp`;
- vista stato bot;
- impostazioni base;
- API client centralizzato;
- sessione frontend tramite token API;
- routing con `HashRouter` per compatibilita con GitHub Pages.

Per ora il frontend punta in locale a `http://localhost:4000` tramite `VITE_API_BASE_URL`. In produzione potrai lasciare il sito su `https://oakvxish.github.io/synkris` e puntare `VITE_API_BASE_URL` verso il tuo server reale.

### Backend API
`apps/api` espone:

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`
- `GET /auth/me`
- `GET /health`
- `GET /bot/status`
- `POST /bot/connect/init`
- `GET /bot/connect/qr`
- `GET /bot/connect/pairing-code`
- `POST /bot/disconnect`
- `GET /settings`
- `PUT /settings`

La logica e' separata in route/controller/service/repository/client. Il recupero password salva i token hashati nel database. In locale la risposta include `previewToken` e `previewUrl` per poter testare subito il flusso senza email.

### Bot worker
`apps/bot-worker` e' un servizio separato che oggi usa un provider `mock`:

- session manager dedicato;
- persistenza su file nel volume `bot_sessions`;
- provider interface pronta per un provider reale;
- provider `mock` che genera QR/pairing demo e promuove automaticamente lo stato a `connected`;
- endpoint interni protetti da token per essere comandato solo dall'API;
- sync dello stato nel database.

Per collegare il provider WhatsApp reale e' stato lasciato il punto di integrazione `OpenWaLegacyProvider`, pensato per assorbire il codice legacy in root quando vorrai fare il passaggio.

### Database
Lo schema Prisma (`prisma/schema.prisma`) include:

- utenti (`users`);
- impostazioni utente (`user_settings`);
- istanze bot (`bot_instances`);
- metadata sessione (`bot_session_metadata`);
- token di recupero password (`password_reset_tokens`);
- tabelle legacy principali per servizi, professionisti, appuntamenti, chat session e hold.

Sono presenti le migrazioni:

- `20260404190000_init_portal_stack`
- `20260404193000_add_password_reset_tokens`

## GitHub Pages e frontend statico
Il frontend non contiene logica server, non parla con PostgreSQL e non salva la sessione WhatsApp nel browser.

Per deploy statico su `https://oakvxish.github.io/synkris`:

1. imposta `VITE_API_BASE_URL` verso la tua API reale;
2. usa `GITHUB_PAGES_BASE=/synkris/`;
3. esegui `npm run build -w @whatsapp-ai/frontend`;
4. pubblica `apps/frontend/dist` su GitHub Pages.

## Caddy
`infrastructure/caddy/Caddyfile` include:

- blocco locale `:8080` per reverse proxy verso l'API;
- blocco `api.miodominio.tld` pronto per produzione;
- blocco `app.miodominio.tld` per servire il frontend statico dal server se in futuro non vuoi usare GitHub Pages.

## Docker Compose
`docker-compose.yml` orchestra:

- `postgres`
- `api`
- `bot-worker`
- `caddy`

Caratteristiche incluse:

- rete interna dedicata;
- volume persistente per PostgreSQL;
- volume persistente per le sessioni bot;
- healthcheck sensati;
- restart policy `unless-stopped`;
- PostgreSQL non esposto pubblicamente;
- bot-worker non esposto pubblicamente.

## Sviluppo locale
### Prerequisiti
- Node 18.18+ o superiore
- Docker Desktop / Docker Engine
- PostgreSQL via Docker oppure installato localmente

### Avvio locale base
1. copia `.env.example` in `.env` e personalizza i valori;
2. installa le dipendenze di workspace con `npm install`;
3. genera Prisma Client con `npm run db:generate` o `npx prisma generate`;
4. applica le migrazioni con `npm run db:migrate:dev` oppure `npm run db:migrate`;
5. avvia i servizi in locale con:
   - `npm run dev:api`
   - `npm run dev:bot-worker`
   - `npm run dev:frontend`

Oppure usa Docker Compose per la parte server:

1. `docker compose up --build -d postgres bot-worker api caddy`
2. frontend via Vite o build statico.

### Import dati legacy
Se vuoi importare i dati storici JSON nel database normalizzato:

- `node infrastructure/scripts/import-legacy-data.mjs`

Il wrapper invoca l'attuale `01_migrate_json_to_pg.mjs` presente in root.

## Deploy server Windows con Docker
1. prepara `.env` con valori reali per database, JWT e domini;
2. esegui `docker compose build`;
3. esegui `docker compose up -d`;
4. configura DNS verso il server;
5. usa Caddy per terminare HTTPS e proxyare l'API.

## CORS e domini
Poiche il frontend girera su GitHub Pages e l'API su un dominio separato:

- usa `ALLOWED_ORIGINS=https://oakvxish.github.io` lato API;
- usa `VITE_API_BASE_URL` lato frontend;
- in locale puoi lavorare con `http://localhost:5173` -> `http://localhost:4000`;
- in produzione il sito resta su `https://oakvxish.github.io/synkris` mentre `VITE_API_BASE_URL` punta all'host API reale.

## Volumi persistenti
- PostgreSQL: volume `postgres_data`
- Sessioni bot: volume `bot_sessions`
- Caddy: `caddy_data`, `caddy_config`

La sessione WhatsApp non deve mai stare nel browser: resta nel worker e sul relativo volume server-side.

## Recupero password
Per ora il recupero password e' pensato per sviluppo locale:

- `POST /auth/forgot-password` genera un token nel DB;
- in `development` la risposta include `previewToken` e `previewUrl`;
- il frontend mostra questi valori cosi puoi completare il reset subito;
- in produzione la stessa logica e' pronta per essere agganciata a un servizio email reale.

## Cosa e' reale e cosa e' mockato
### Pronto ora
- monorepo e separazione servizi;
- database utenti e bot state;
- auth login/register;
- recupero password con token persistito nel DB;
- frontend statico React/Vite/TS con base GitHub Pages `'/synkris/'`;
- backend API con CORS e route richieste;
- bot-worker separato;
- Docker Compose;
- Caddyfile;
- session storage lato server;
- connessione locale tra servizi via `localhost` o rete Docker interna.

### Mockato per ora
- provider WhatsApp reale nel nuovo `apps/bot-worker`;
- invio email reale per password reset;
- collegamento automatico del nuovo worker alla logica legacy `open-wa`.

### Da collegare per WhatsApp reale
- implementare `OpenWaLegacyProvider` riusando o rifattorizzando il bot legacy in root (`index.js`, `util.js`, `gcal.js`);
- gestire QR/pairing reali provenienti dal provider;
- persistere i file/session artifact reali nello stesso `BOT_SESSION_DIR`;
- decidere se l'API debba leggere lo stato solo dal worker o anche da webhook/event bus quando il provider reale sara online.

## Troubleshooting
- Se il frontend non raggiunge l'API: verifica `VITE_API_BASE_URL` e `ALLOWED_ORIGINS`.
- Se il login funziona ma il bot no: verifica `BOT_WORKER_BASE_URL` e `INTERNAL_SERVICE_TOKEN`.
- Se Prisma fallisce: controlla `DATABASE_URL` e l'ordine delle migrazioni.
- Se il reset password non appare: in locale controlla che `NODE_ENV` non sia `production`, altrimenti il preview token non viene restituito.
- Se Caddy non parte su Windows: verifica che 80/443/8080 non siano gia occupate.
