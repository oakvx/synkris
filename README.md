<div align="center">

# SYNKRIS · synk

**Sistema on-premise per saloni su appuntamento: prenotazioni, WhatsApp e Google Calendar con consistenza esplicita.**

<img alt="Release" src="https://img.shields.io/badge/release-1.2.0--rc.6-C12CAC?style=flat-square&labelColor=170C29">
<img alt="Node.js 22/24" src="https://img.shields.io/badge/Node.js-22%20%2F%2024-7540B8?style=flat-square&labelColor=170C29">
<img alt="PHP 8.3" src="https://img.shields.io/badge/PHP-8.3-7540B8?style=flat-square&labelColor=170C29">
<img alt="PostgreSQL 16" src="https://img.shields.io/badge/PostgreSQL-16-7540B8?style=flat-square&labelColor=170C29">
<a href="https://github.com/oakvx/synkris/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/oakvx/synkris/actions/workflows/ci.yml/badge.svg?branch=master"></a>
<a href="https://github.com/oakvx/synkris/actions/workflows/prerelease.yml"><img alt="Prerelease" src="https://img.shields.io/github/actions/workflow/status/oakvx/synkris/prerelease.yml?branch=master&style=flat-square&label=prerelease"></a>
<a href="https://github.com/oakvx/synkris/commits/master/"><img alt="Last commit" src="https://img.shields.io/github/last-commit/oakvx/synkris/master?style=flat-square&color=7540B8&labelColor=170C29"></a>
<a href="https://github.com/oakvx/synkris/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/oakvx/synkris?style=flat-square&color=C12CAC&labelColor=170C29"></a>
<a href="https://github.com/oakvx/synkris/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/oakvx/synkris?style=flat-square&color=7540B8&labelColor=170C29"></a>
<a href="https://github.com/oakvx/synkris/forks"><img alt="Forks" src="https://img.shields.io/github/forks/oakvx/synkris?style=flat-square&color=C12CAC&labelColor=170C29"></a>
<img alt="Docker Compose" src="https://img.shields.io/badge/Docker-Compose-C12CAC?style=flat-square&labelColor=170C29">
<img alt="License: proprietary, source-available" src="https://img.shields.io/badge/license-proprietary%20(source--available)-64748B?style=flat-square&labelColor=170C29">

</div>

> [!WARNING]
> **Release candidate di collaudo, proprietaria (source-available).** Non usare con appuntamenti o dati di clienti reali prima di aver chiuso i rilievi di sicurezza aperti e la [checklist di collaudo](COLLAUDO.md). L'adapter WhatsApp non è stato convalidato su una sessione reale.

## Indice

- [Panoramica](#panoramica)
- [Architettura](#architettura)
- [Servizi (Docker Compose)](#servizi-docker-compose)
- [Modello dati e invarianti](#modello-dati-e-invarianti)
- [Consistenza con Google Calendar](#consistenza-con-google-calendar)
- [Messaggistica WhatsApp](#messaggistica-whatsapp)
- [Scheduler e worker](#scheduler-e-worker)
- [Configurazione](#configurazione)
- [Privacy e sicurezza](#privacy-e-sicurezza)
- [Sviluppo e test](#sviluppo-e-test)
- [Installazione di collaudo su Windows](#installazione-di-collaudo-su-windows)
- [Stato della release](#stato-della-release)
- [Licenza](#licenza)
- [Documentazione](#documentazione)

## Panoramica

synk gestisce agenda, anagrafiche, servizi, operatrici e conversazioni WhatsApp di un salone. L'installazione è **locale** (un PC con Docker Desktop / WSL2): i dati applicativi risiedono in un PostgreSQL locale. Google Calendar e WhatsApp restano provider esterni. **Locale non significa offline.**

Principi di progetto:

- Uno slot non è mai presunto libero se Calendar non risponde in modo affidabile.
- La scrittura transazionale su PostgreSQL è separata dall'effetto asincrono su Google Calendar. Un'operazione **in coda** non è una conferma di sincronizzazione.
- Ogni stato incerto è visibile in dashboard (`pending`, `attention`, `needs_attention`) e delegabile a un operatore.
- L'AI locale (Ollama) è opzionale, disattivata di default, e non riceve le note cliente.

## Architettura

<img src="docs/assets/synkris-architecture.svg" width="100%" alt="Architettura locale: browser, dashboard PHP, bot Node.js, PostgreSQL, Ollama opzionale; Google e WhatsApp come servizi esterni.">

| Livello | Tecnologia |
| --- | --- |
| Dashboard amministrativa | PHP 8.3; sessioni, CSRF, proxy server-side verso l'API interna del bot |
| Backend | Node.js 22/24 (ESM), Express 4; automazioni, API amministrativa, scheduler |
| Persistenza | PostgreSQL 16; vincoli, transazioni, outbox, saga |
| Agenda | Google Calendar API (`googleapis`), service account, sync token incrementale |
| Messaggistica | `whatsapp-web.js@1.34.7` (WhatsApp Web, Chromium headless) |
| Orari e ricorrenze | `luxon`, `rrule` |
| Notifiche operative | `nodemailer` (SMTP opzionale, solo codici di stato) |
| AI | Ollama 0.12.8, profilo Compose `ai` |

> [!IMPORTANT]
> L'integrazione WhatsApp **non** usa l'API ufficiale WhatsApp Business Cloud: si basa su `whatsapp-web.js`. Compatibilità, restrizioni possibili e conformità ai termini del provider vanno valutate prima dell'uso.

```text
src/
  index.js          bootstrap, scheduler, shutdown, license monitor
  core/             logica conversazionale e prenotazione
  services/         Calendar (outbox, saga, sync), WhatsApp, waitlist, admin API, alert
  storage/          pool PostgreSQL, accesso ai dati
  licensing/        verifica licenza firmata e monitor
  observability/    contatori e trace
  security/         utilità HTTP
  ai/               integrazione Ollama (opzionale)
dashboard/          dashboard PHP
scripts/db/         schema.sql idempotente e migrazioni
scripts/deploy/     bootstrap, doctor
scripts/release/    check, audit, packaging
```

## Servizi (Docker Compose)

Definiti in [`compose.yaml`](compose.yaml). Tutte le porte sono pubblicate solo su `127.0.0.1`.

| Servizio | Immagine / ruolo | Note |
| --- | --- | --- |
| `postgres` | `postgres:16-alpine` | Volume `postgres_data`; healthcheck `pg_isready` |
| `bootstrap` | runtime locale, one-shot | Applica schema e configurazione, poi termina. `bot` e `dashboard` dipendono da `service_completed_successfully` |
| `bot` | runtime Node.js | `127.0.0.1:3000`, `/health`, `init: true`, `stop_grace_period: 30s`, `shm_size: 1gb` per Chromium |
| `dashboard` | `Dockerfile.dashboard` (PHP) | `127.0.0.1:8080`; raggiunge il bot via `BOT_API_INTERNAL=http://bot:3000` |
| `backup` | `postgres:16-alpine` | Loop di backup su `./runtime/backups` |
| `doctor` | profilo `tools` | `network_mode: none`, `read_only`, `cap_drop: ALL`, `no-new-privileges`; non scarica immagini, non tocca il DB né i provider |
| `ollama` | `ollama/ollama:0.12.8`, profilo `ai` | Attivabile con `ATTIVA_AI_LOCALE.bat` |

Il backup PostgreSQL non è cifrato di default; per l'esportazione cifrata su USB BitLocker usare `ESPORTA_BACKUP_CIFRATO_TECNICO.bat`.

## Modello dati e invarianti

Schema in [`scripts/db/schema.sql`](scripts/db/schema.sql): idempotente, non importa dati e non cancella record.

| Invariante | Implementazione |
| --- | --- |
| Nessuna sovrapposizione di appuntamenti attivi della stessa operatrice | `EXCLUDE USING gist (professional_id WITH =, tstzrange(start_time, end_time, '[)') WITH &&)` con predicato sugli stati attivi (`btree_gist`). Vale per **tutti** i writer: bot, dashboard, IVR. Intervalli semiaperti: due appuntamenti consecutivi sono ammessi |
| Su dati esistenti in conflitto l'installazione si interrompe | Nessuna cancellazione automatica |
| Prenotazioni multi-servizio | `appointment_services` con `duration_min`, `sort_order`; durate per operatrice in `professional_service_durations`; buffer post-trattamento `services.buffer_after_min` (0–180) |
| Prezzo coerente fra writer | Trigger `sync_service_price` mantiene `price` e `base_price` allineati |
| Slot in trattativa | `appointment_holds` con `expires_at` e stato `active/released/expired` |
| Un solo contatto per numero | Indici univoci parziali su `client_contacts` (`phone`, `whatsapp_chat`) |
| Calendario multiplo | `appointment_calendar.calendar_id`: le righe legacy non vincolate non vengono sincronizzate finché non sono verificate |
| Lista d'attesa con consenso | `waitlist_requests`: `expires_at <= consent_at + 30 giorni`; offerte uniche per `(request_id, start_time)` |
| Handoff operatore | `chat_handoffs`: pausa automatica 24 h; `chat_id` validato con regex |
| Dati privacy | `privacy_requests` (accesso/cancellazione): riferimento cliente e hash, mai contenuto di chat |

La tabella `bookings` (JSONB) esiste per compatibilità con gli endpoint della dashboard PHP.

## Consistenza con Google Calendar

Non esiste una transazione ACID distribuita fra PostgreSQL e Google. Il sistema usa tre meccanismi complementari.

### 1. Transactional outbox

[`src/services/calendar-outbox.js`](src/services/calendar-outbox.js). Chi modifica un appuntamento accoda il job **nella stessa transazione**; la chiamata al provider avviene dopo ed è idempotente.

```mermaid
stateDiagram-v2
    [*] --> pending: enqueue (stessa transazione dell'appuntamento)
    pending --> pending: errore ritentabile, backoff min(3600, 30·2^min(n,7)) s
    pending --> done: ack del provider (lease_token coincidente)
    pending --> attention: errore terminale o n ≥ 12
    done --> [*]
```

- Operazioni: `create`, `cancel`, `update`, `reschedule`. Payload ≤ 20 000 caratteri; intervallo di `reschedule` validato.
- **FIFO per `event_id`**: un job non è reclamabile finché esiste un job precedente dello stesso evento non `done`.
- Reclamo con `FOR UPDATE SKIP LOCKED` e lease di 2 minuti con **fencing token** (`lease_token` UUID): un worker scaduto non può chiudere il job di un worker successivo.
- Ritentabili: HTTP 408, 409, 425, 429, 500, 502, 503, 504 ed errori di rete. Terminali: 400, 401, 403, 422 e codici applicativi (`UNBOUND_CALENDAR`, `INVALID_APPOINTMENT`, `BOOKING_METADATA_MISSING`, `BOOKING_NO_LONGER_ACTIVE`).
- `cancel` tratta 404 come successo. L'eventuale offerta a un cliente in lista d'attesa parte solo **dopo** la conferma del provider.

### 2. Saga di compensazione

[`src/services/calendar-saga.js`](src/services/calendar-saga.js). Per le prenotazioni "Calendar-first" l'evento ha un id generato localmente e un record `pending` in `calendar_booking_sagas`. Se dopo 15 minuti l'evento non risulta collegato in `appointment_calendar`, il worker lo **cancella** (compensazione); se risulta collegato, la saga passa a `committed`. Backoff `min(3600, 60·2^min(n,6))` s; dopo 12 tentativi lo stato è `needs_attention`. È un meccanismo di recupero, non una transazione.

### 3. Sync in ingresso

`runCalendarSync` usa sync token incrementali (`calendar_sync_cursors`), registra i conflitti (`calendar_sync_conflicts`) e traccia solo metadati (`calendar_sync_audit`). Un ripristino da backup sospende i worker (`isCalendarPaused`) fino alla riconciliazione tecnica (`RIATTIVA_CALENDAR_TECNICO.bat`).

<img src="docs/assets/synkris-booking-flow.svg" width="100%" alt="Schema tecnico di prenotazione: controlli, transazione locale, outbox e sincronizzazione Calendar.">

## Messaggistica WhatsApp

- **Deduplicazione durevole.** `whatsapp_message_inbox` conserva solo l'hash SHA-256 dell'id del messaggio (`processing` → `completed`, con lease); pulizia giornaliera dei completati.
- **Dispatcher con backpressure.** Coda limitata; i messaggi rifiutati per `queue_full` o `at_capacity` sono contati e loggati.
- **Readiness.** Gli handler sono registrati prima di `initialize()`, ma i messaggi sono accettati solo dopo l'evento nativo `ready` e il ricontrollo della licenza.
- **Handoff.** Con la chat in pausa **tutte** le risposte automatiche sono soppresse, compreso `reset`.
- **Comandi dell'utente.** `privacy`/`informativa`; `cancella dati`/`elimina dati`/`delete my data` (cancella la cronologia locale della chat, non gli eventi Calendar né i dati presso WhatsApp); `annulla`/`reset`/`stop`/`ricomincia`.
- **Prenotazione multipla via chat.** Dietro il flag `MULTI_BOOKING_WHATSAPP_ENABLED=1`.
- **Ritenzione.** Messaggi cancellati dopo `CHAT_RETENTION_DAYS` (default 90, intervallo 7–730).

## Scheduler e worker

Tutti i cicli sono in `src/index.js`. I cicli di recupero e sync Calendar hanno guardie anti-rientro; outbox, sync, promemoria, conferme e follow-up sono sospesi quando il Calendar è in pausa (`isCalendarPaused`).

| Ciclo | Periodo |
| --- | --- |
| Healthcheck PostgreSQL | 30 s |
| Stato WhatsApp | 15 s |
| Refresh cache prenotazioni | 60 s |
| Ricarica configurazione e servizi | 90 s |
| Drain outbox Calendar | 60 s |
| Recupero saga | 2 min |
| Sync Calendar in ingresso | 2 min |
| Controllo allarmi operativi | 60 s |
| Promemoria 24 h | 60 s (batch 200) |
| Conferme appuntamento | 15 min (anticipo `CONFIRM_LEAD_MINUTES`, default 180) |
| Follow-up recensioni | 30 min |
| Pulizia lista d'attesa | 1 h |
| Pulizia inbox e retention chat | 24 h |
| Verifica licenza | `LICENSE_CHECK_INTERVAL_MINUTES` (default 15, 1–1440) |

**Shutdown.** Su `SIGINT`/`SIGTERM` il processo smette di accettare messaggi, attende fino a 12 s i messaggi in corso e forza l'uscita a 20 s. La saga copre i crash oltre la finestra di drain.

## Configurazione

Template in [`.env.example`](.env.example). Obbligatori all'avvio:

| Variabile | Requisito |
| --- | --- |
| `DATABASE_URL` | Connessione PostgreSQL |
| `CALENDAR_ID` | Calendario di default |
| `ADMIN_TOKEN` | Almeno 32 caratteri |
| `LICENSE_PUBLIC_KEY_PEM` o `LICENSE_PUBLIC_KEY_FILE` | Chiave pubblica per la licenza firmata |
| Credenziali Google | `GOOGLE_CREDENTIALS_JSON`, `GOOGLE_CREDENTIALS_B64`, `GOOGLE_APPLICATION_CREDENTIALS` oppure file in `DATA_DIR` |

Flag e parametri rilevanti: `CALENDAR_OUTBOX_ENABLED`, `CALENDAR_INBOUND_SYNC`, `CALENDAR_SYNC_CALENDARS`, `MULTI_BOOKING_WHATSAPP_ENABLED`, `CHAT_RETENTION_DAYS`, `CONFIRM_LEAD_MINUTES`, `LICENSE_CHECK_INTERVAL_MINUTES`, `LICENSE_READ_GRACE_MINUTES`, `ADMIN_ALLOWED_ORIGINS`.

La licenza è un testo `LIC=` / `SIG=` verificato con la chiave pubblica e ricontrollato periodicamente; in caso di licenza non valida il processo termina.

## Privacy e sicurezza

- Non versionare né pacchettizzare `.env`, `setup/config.json`, `secrets/`, `runtime/`, sessioni, licenze e chiavi private.
- L'API amministrativa richiede `ADMIN_TOKEN`; la dashboard usa sessioni, CSRF e proxy server-side. Non esporre le porte interne.
- Gli allarmi SMTP contengono solo codici di stato, mai prenotazioni, numeri o chat. Le note cliente non sono esposte ad AI o servizi esterni.
- I backup contengono dati personali: servono cifratura, conservazione e ripristino concordati.
- Log e issue pubbliche non devono contenere numeri, conversazioni, QR, credenziali o dati cliente.
- Audit dipendenze all'8 novembre 2026: 19 rilievi noti (11 elevati, 8 moderati, 0 critici). Vanno valutati e mitigati prima dell'uso con dati reali.

Dettagli: [SECURITY.md](SECURITY.md).

## Sviluppo e test

Prerequisito: Node.js 22 o 24.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check          # sintassi
npm test               # test Node
npm run audit:release  # audit di release
```

PHP 8.3 con `pdo_pgsql`, `curl`, `sodium`:

```sh
npm run check:php
npm run test:php
```

Integrazione (richiede un PostgreSQL **dedicato e cancellabile** `synk_test`; lo script può resettare lo schema `public`, **non usarlo mai con il database del salone**):

```sh
TEST_DATABASE_URL=postgresql://synk_test:synk_test@127.0.0.1:5432/synk_test \
SYNK_TEST_DB_ALLOW_RESET=1 npm run test:integration
```

Altri script: `npm run doctor` (diagnostica installazione), `npm run db:init`, `npm run release:package`.

Questi comandi verificano il codice, non avviano un salone configurato e non dimostrano la disponibilità dei provider.

## Installazione di collaudo su Windows

Percorso guidato da wizard, ma richiede assistenza tecnica, Docker Desktop / WSL2, licenza firmata/HWID e credenziali Calendar. Partire da [PRIMO_AVVIO.txt](PRIMO_AVVIO.txt), poi [Primi passi](deploy/PRIMI_PASSI.md), [LEGGIMI.txt](LEGGIMI.txt), [RELEASE.md](RELEASE.md) e [COLLAUDO.md](COLLAUDO.md).

| Operazione | Entrypoint |
| --- | --- |
| Prima installazione / menu strumenti | `INSTALLA_UNA_VOLTA.bat` |
| Avvio e dashboard | `AVVIA_SYNK.bat` / `APRI_SYNK.bat` |
| Aggiornamento tecnico | `AGGIORNA_SYNK_TECNICO.bat` |
| Ripristino sospeso | `RIPRISTINA_BACKUP.bat` |
| Riconciliazione Calendar | `RIATTIVA_CALENDAR_TECNICO.bat` |
| Esportazione USB BitLocker | `ESPORTA_BACKUP_CIFRATO_TECNICO.bat` |
| AI locale opzionale | `ATTIVA_AI_LOCALE.bat` |

**Non eseguire `docker compose down -v` con dati del salone.** Il rollback del codice non annulla una migrazione del database. Per la migrazione WhatsApp seguire [WHATSAPP_MIGRATION.md](docs/WHATSAPP_MIGRATION.md).

### Dashboard

<p align="center"><a href="docs/assets/dashboard-overview.webp"><img src="docs/assets/dashboard-overview.webp" width="100%" alt="Dashboard con dati sintetici e stati operativi."></a></p>

Le schermate sono renderizzate da fixture sintetiche; non certificano un collegamento WhatsApp o Google Calendar funzionante. Origine e rigenerazione: [docs/readme/README.md](docs/readme/README.md).

## Stato della release

| Aspetto | Stato |
| --- | --- |
| Versione | `1.2.0-rc.6`, prerelease ricostruita per collaudo |
| Pacchetti | **Ogni commit su `master`** pubblica una Prerelease; **ogni lunedì** pubblica una GitHub Release settimanale, anche senza commit nuovi. **Sono RC di collaudo, non stabili né Latest.** [GitHub Releases](https://github.com/oakvx/synkris/releases) · [Procedura](docs/PRIMO_RILASCIO.md) |
| Test (snapshot datato, commit `9ff8000`, 8 novembre 2026) | 239/239 test Node e 6 job CI superati. Non è un test sul PC di un salone |
| Copertura aggiuntiva | Setup Windows, checklist, diagnosi offline, backup/restore su DB sintetico ([PLUG_AND_PLAY.md](docs/PLUG_AND_PLAY.md)) |
| Ancora da fare | Collaudo con WhatsApp, Google Calendar, SMTP, Windows e procedure di ripristino reali |

Lo snapshot dei test è una fotografia, non un badge live.

## Licenza

**Non open source.** Software proprietario con codice consultabile (source-available). La [licenza](LICENSE.md) consente gratuitamente solo uso privato e non commerciale di una persona fisica, con attivazione firmata e rilascio manuale. Uso in saloni, aziende, per clienti, come servizio ospitato, rivendita o white-label richiede un accordo commerciale scritto. Il repository non è un'offerta vincolante e non pubblica un listino. Licenze di terzi: [THIRD_PARTY_NOTICES.md](deploy/THIRD_PARTY_NOTICES.md).

Per valutare l'adozione: [richiesta informazioni](https://github.com/oakvx/synkris/issues/new?template=richiesta-demo.yml). La richiesta è pubblica: non inserire contatti personali, dati di clienti o credenziali.

## Documentazione

| Argomento | Riferimento |
| --- | --- |
| Indice completo | [docs/README.md](docs/README.md) · [archivio storico](docs/history/README.md) |
| Report di ricostruzione RC6 | [REPORT_RICOSTRUZIONE_RC6.md](docs/history/REPORT_RICOSTRUZIONE_RC6.md) |
| Installazione | [LEGGIMI.txt](LEGGIMI.txt) · [Primi passi](deploy/PRIMI_PASSI.md) · [PLUG_AND_PLAY.md](docs/PLUG_AND_PLAY.md) |
| Release e collaudo | [RELEASE.md](RELEASE.md) · [COLLAUDO.md](COLLAUDO.md) |
| Migrazione WhatsApp | [WHATSAPP_MIGRATION.md](docs/WHATSAPP_MIGRATION.md) |
| Sicurezza | [SECURITY.md](SECURITY.md) |
| Licenza e distribuzione | [LICENSE.md](LICENSE.md) · [OPEN_SOURCE_READINESS.md](docs/OPEN_SOURCE_READINESS.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| CI | [ci.yml](.github/workflows/ci.yml) · [prerelease.yml](.github/workflows/prerelease.yml) |
