<div align="center">
  <img src="docs/assets/hero.svg" width="1280" alt="synk — Meno incastri. Più tempo per le persone. RC6 di collaudo, licenza proprietaria: uso privato non commerciale gratuito, altri usi su accordo commerciale.">
  <p><strong>Appuntamenti, team e conversazioni per il tuo salone.</strong><br>Un core locale, una dashboard in italiano e integrazioni che restano sotto supervisione umana.</p>
  <p>
    <a href="#anteprima">Anteprima</a> ·
    <a href="#architettura">Architettura</a> ·
    <a href="#sviluppo">Sviluppo</a> ·
    <a href="#licenza-e-open-source">Licenza e open source</a> ·
    <a href="#documentazione">Documentazione</a>
  </p>
</div>

<img src="docs/assets/stack.svg" width="1280" alt="Stack: Node.js 22/24, PHP 8.3, PostgreSQL 16, Docker/WSL2 e AI locale facoltativa.">

> [!WARNING]
> **`1.2.0-rc.6` è una prerelease ricostruita, solo per collaudo.** Il repository è attualmente privato e [la licenza è proprietaria](LICENSE.md): **synk non è open source**. Il diritto d’uso è gratuito solo per uso privato non commerciale; ogni altro uso richiede un accordo commerciale scritto a titolo oneroso. I componenti persi sono stati riscritti, non recuperati dagli originali. Non è garantita la parità con la vecchia interfaccia né l’idoneità all’uso con clienti reali.

## In breve

**synk** mette nello stesso spazio l’agenda, il catalogo dei trattamenti, le operatrici e le conversazioni. PostgreSQL conserva i dati applicativi sul PC del salone; Node.js gestisce automazioni e sincronizzazione; la dashboard PHP rende visibili anche le operazioni ancora in coda o da verificare.

Il punto non è automatizzare tutto: è **sapere che cosa è stato salvato, che cosa è stato sincronizzato e quando deve intervenire una persona**.

<img src="docs/assets/features.svg" width="1280" alt="Quattro capacità: agenda con durate e buffer, stati Calendar distinti, controllo umano delle chat e manutenzione esplicita.">

| Area | Cosa trovi |
| --- | --- |
| **Appuntamenti** | Da 1 a 6 trattamenti ordinati, durate per operatrice, buffer, verifica degli orari e conflitti. |
| **Clienti e team** | Anagrafiche indipendenti dallo storico, note locali, servizi abilitati e durate personalizzate. |
| **Conversazioni** | Interfaccia WhatsApp tramite whatsapp-web.js, presa in carico manuale e revisione privacy. |
| **Organizzazione** | Orari settimanali, pause, chiusure, assenze e lista d’attesa con consenso. |
| **Centro operativo** | Stati dei servizi, operazioni in coda, anomalie Calendar e richieste privacy. |
| **Primi passi guidati** | Wizard Windows, checklist in dashboard, password locale mascherata, diagnostica e report assistenza selettivo. |
| **Manutenzione** | ZIP con manifest e SHA256, backup PostgreSQL pubblicati dopo verifica, restore sospeso e riconciliazione tecnica. |
| **AI locale opzionale** | Integrazione Ollama, disattivata per default. Non sostituisce i controlli applicativi. |

## Anteprima

**Interfaccia effettivamente renderizzata dal frontend ricostruito, con fixture sintetiche.** Nomi, appuntamenti, conteggi e stati mostrati sono dimostrativi. Nessun account reale, database del salone, QR, messaggio cliente o credenziale è stato utilizzato. Le immagini **non attestano** una connessione Google/WhatsApp o un test end-to-end.

### Centro operativo

[![Centro operativo di synk: stati dei servizi e operazioni di esempio, con una fascia che identifica tutti i dati come sintetici.](docs/assets/dashboard-overview.webp)](docs/assets/dashboard-overview.webp)

<table>
  <tr>
    <td width="50%"><strong>Agenda con stati espliciti</strong></td>
    <td width="50%"><strong>Editor multi-trattamento</strong></td>
  </tr>
  <tr>
    <td><a href="docs/assets/dashboard-agenda.webp"><img src="docs/assets/dashboard-agenda.webp" alt="Agenda dimostrativa con appuntamenti sintetici, stati in coda, sincronizzato e verifica tecnica."></a></td>
    <td><a href="docs/assets/dashboard-editor.webp"><img src="docs/assets/dashboard-editor.webp" alt="Editor dimostrativo: una cliente sintetica, un’operatrice e due trattamenti per 100 minuti, buffer inclusi."></a></td>
  </tr>
  <tr>
    <td>Il salvataggio nel database non viene confuso con l’esito su Google.</td>
    <td>Servizi ordinati, abilitazioni e tempi provengono dal catalogo.</td>
  </tr>
</table>

*Clicca sulle immagini per la versione completa. [Come rigenerare gli asset](docs/readme/README.md).*

## Architettura

<img src="docs/assets/architecture.svg" width="1280" alt="Architettura: browser, PHP, PostgreSQL, Node/whatsapp-web.js e Ollama sul sistema locale; Google Calendar, WhatsApp e SMTP oltre il confine dei provider esterni.">

| Componente | Responsabilità |
| --- | --- |
| **Dashboard PHP 8.3** | Login, sessioni, CSRF, editor PDO e proxy interno con allowlist. |
| **Node.js / whatsapp-web.js** | Bot, API amministrativa interna, verifica Calendar e worker di sincronizzazione. |
| **PostgreSQL 16** | Fonte applicativa dei dati, vincolo anti-sovrapposizione, transazioni e outbox. |
| **Docker Compose** | Servizi locali, bootstrap, volumi persistenti e backup pianificati. |
| **Ollama** | Modelli locali facoltativi, attivati esplicitamente dal tecnico. |

**Locale non significa isolato da Internet.** Google Calendar e WhatsApp ricevono i dati necessari alle rispettive integrazioni. SMTP viene contattato soltanto con opt-in e configurazione esplicita. La cancellazione di una chat locale non elimina automaticamente i dati presso quei provider.

L’integrazione WhatsApp usa **whatsapp-web.js / WhatsApp Web**, non la WhatsApp Business Cloud API ufficiale. Compatibilità, termini del provider e rischi per l’account richiedono una valutazione specifica; i test automatici non li certificano.

## Prenotazioni

<img src="docs/assets/booking-flow.svg" width="1280" alt="Flusso: scelta dei trattamenti, verifica di orari e Calendar, transazione PostgreSQL con outbox, sincronizzazione asincrona con Google.">

- Se Calendar non è raggiungibile o la sua risposta non è valida, il salvataggio viene bloccato: **non si presume che lo slot sia libero**.
- Appuntamento, servizi ordinati e operazione outbox vengono registrati nella stessa transazione locale.
- Un’operazione **in coda** non viene presentata come una sincronizzazione riuscita.
- Una modifica concorrente richiede di ricaricare i dati prima di riprovare.
- Dopo un ripristino, il flag di manutenzione sospende prenotazioni e worker finché il tecnico non completa la riconciliazione.

La verifica preliminare e l’outbox **non creano una transazione ACID distribuita con Google** e non eliminano ogni condizione di gara.

## Stato della release

<img src="docs/assets/readiness.svg" width="1280" alt="Snapshot dell’8 novembre 2026: 242 test Node, milestone senza attivazione con 6 job CI verdi, licenza proprietaria con uso privato gratuito, 11 rilievi elevati e collaudo reale ancora richiesto.">

**Fotografia verificata l’8 novembre 2026**, non un badge live. Il milestone senza attivazione **`a7deb3d`** ha completato [tutti i 6 job CI](https://github.com/oakvx/synkris/actions/runs/42531242615). Le modifiche successive richiedono la CI del proprio commit:

| Controllo | Risultato / limite |
| --- | --- |
| **Node.js 22 e 24** | **242/242 test locali**, senza skip: setup senza attivazione, onboarding, API/UI, provider e invii incerti. |
| **PHP e PostgreSQL 16** | Test nativi e integrazione: bootstrap effettivo senza licenza, proxy autenticato, transazioni, outbox e checklist. **Dump e restore reali su database CI sintetico separato**, non sul PC del salone. |
| **Windows PowerShell 5.1 e 7** | Parser/ZIP, wizard, file privati, avvio, collisioni progetto e autostart COM in TEMP. **Non è una prova interattiva del desktop/WSL2**. |
| **Docker** | Build e smoke Apache con login senza licenza; doctor reale senza rete/dependencies, con sole credenziali Google e senza marker import o volumi dati. |
| **Backup interrotti** | 7 casi aggiuntivi con strumenti PG sintetici: staging, errori, checksum e conservazione dei precedenti. |
| **Audit produzione** | **19 rilievi: 8 moderati, 11 elevati, 0 critici.** Rieseguito localmente; non è un via libera di sicurezza. SBOM: 335 componenti. |
| **Provider e PC destinatario** | Collaudo reale Google, WhatsApp, SMTP se configurato, finestra credenziali, Docker Desktop/WSL2, aggiornamento, restore e USB BitLocker ancora richiesto. |
| **Licenza** | **Proprietaria/source-available:** solo privato personale non commerciale gratuito; altri usi su accordo commerciale scritto. Non richiede file di attivazione o HWID. |

[Dettagli e limiti del lavoro plug-and-play](docs/PLUG_AND_PLAY.md). Il [report di ricostruzione](REPORT_RICOSTRUZIONE_RC6.md) conserva la baseline storica; non va confuso con i risultati attuali. **CI verde ≠ software stabile, sicuro o automaticamente open source.**

## Sviluppo

Per chi ha accesso e autorizzazione al repository. **Node.js 22 o 24**; `npm ci` utilizza il lockfile. Non sono necessarie credenziali reali per la suite Node.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run audit:release
```

Questi comandi verificano i sorgenti: **non avviano un salone configurato**. L’avvio applicativo richiede configurazione locale e credenziali delle integrazioni previste.

<details>
<summary><strong>PHP, database, Windows e pacchetto</strong></summary>

Per i test PHP servono **PHP 8.3**, `pdo_pgsql` e `curl`:

```sh
npm run check:php
npm run test:php
```

L’integrazione richiede un PostgreSQL dedicato chiamato `synk_test`. **La suite resetta lo schema `public`: non usare mai dati o credenziali del salone.** Esempio Bash con credenziali esclusivamente sintetiche:

```sh
TEST_DATABASE_URL=postgresql://synk_test:synk_test@127.0.0.1:5432/synk_test \
SYNK_TEST_DB_ALLOW_RESET=1 npm run test:integration
```

Per generare lo ZIP piatto e verificarlo:

```sh
npm run release:package
node scripts/release/archive.mjs artifacts/synk-1.2.0-rc.6.zip
```

Dopo la build, in PowerShell 5.1 o 7:

```powershell
./tests/windows-scripts.test.ps1
```

Gli output sono in `artifacts/`, esclusi da Git. Un pacchetto con `sourceDirty: true` è soltanto una prova locale: non va pubblicato su un tag che identifica un commit diverso.

</details>

## Installazione

Il percorso attuale è una **installazione Windows di collaudo assistita da un tecnico**, con Docker Desktop/WSL2 in modalità container Linux. Il programma non richiede file di attivazione, chiavi di licenza o HWID. Per un salone o altro uso non privato serve prima l’accordo commerciale.

1. Leggi [LEGGIMI.txt](LEGGIMI.txt) e [RELEASE.md](RELEASE.md).
2. Estrai **tutto** lo ZIP piatto in una cartella locale di prova: individua insieme i BAT, `compose.yaml` e `strumenti/`. Non avviare i file dall’interno dello ZIP o da una cartella condivisa/cloud.
3. Avvia `INSTALLA_UNA_VOLTA.bat`, premi Invio: il wizard chiede team, trattamenti e orari, importa il JSON originale del service account Google e prepara i segreti mancanti, **senza modificare JSON a mano**. Le credenziali esistenti non vengono ruotate automaticamente.
4. Il tecnico prepara le credenziali Google e condivide i calendari dedicati. Il doctor offline verifica configurazione, segreti e formato della chiave Google prima del bootstrap; nessun rilascio di licenza è necessario.
5. Accedi con la password della finestra locale mascherata e segui **Primi passi** nel Centro operativo: database, catalogo, WhatsApp, Calendar e backup.
6. Completa la [checklist di collaudo](COLLAUDO.md) con account/dati di prova. Anche cinque controlli completati non certificano l’uso in produzione.

**[Guida rapida Windows e menu strumenti →](deploy/PRIMI_PASSI.md)** · Node/PHP non servono sul PC ospite. Il menu include diagnostica, recupero password, report assistenza locale, autostart opt-in e correzione iniziale dei file privati. L’avvio quotidiano non esegue build/pull. L’installazione non attiva automaticamente l’autostart.

| Operazione | Entrypoint Windows |
| --- | --- |
| Installazione e strumenti locali | `INSTALLA_UNA_VOLTA.bat` (Invio per installare) |
| Avvio / apertura dashboard | `AVVIA_SYNK.bat` / `APRI_SYNK.bat` |
| Aggiornamento controllato | `AGGIORNA_SYNK_TECNICO.bat` |
| Restore sospeso | `RIPRISTINA_BACKUP.bat` |
| Fine riconciliazione Calendar | `RIATTIVA_CALENDAR_TECNICO.bat` |
| Export su USB BitLocker | `ESPORTA_BACKUP_CIFRATO_TECNICO.bat` |
| AI locale facoltativa | `ATTIVA_AI_LOCALE.bat` |

**Passaggio da OpenWA:** fermare la vecchia istanza, conservare backup e vecchi file, aggiornare dal nuovo lockfile e associare il QR dalla dashboard. Non avviare due bot sullo stesso account. Seguire la [guida di migrazione](docs/WHATSAPP_MIGRATION.md).

**Non eseguire `docker compose down -v` sui dati del salone.** Un rollback del codice non annulla una migrazione del database. Dopo un restore non rimettere indiscriminatamente in coda vecchie operazioni Calendar: segui la riconciliazione descritta nella guida.

## Sicurezza e dati

- `.env`, `setup/config.json`, `runtime/`, sessioni, eventuali vecchi file di attivazione e credenziali restano **fuori da Git e dagli ZIP**.
- I vecchi file di attivazione e le relative variabili sono ignorati, non cancellati né copiati in ZIP o report. Il JSON Google resta privato e necessario all’integrazione.
- Il token amministrativo non viene inserito nel browser; le chiamate privilegiate passano dal proxy server-side autorizzato.
- Il backup PostgreSQL contiene dati personali e **non è cifrato automaticamente**. L’export tecnico su USB richiede BitLocker verificato.
- Il menu crea un report locale di soli stati selezionati in `runtime/support/`: niente log grezzi, chat, QR o credenziali, nessun upload. Rileggilo prima di condividerlo. Non inviare `.env`, sessioni o backup privati. Leggi [SECURITY.md](SECURITY.md).
- Il controllo dei file correnti non equivale a una scansione dell’intera cronologia. Prima di un’apertura pubblica servono revisione e scansione completa, con revoca di eventuali credenziali esposte.

L’audit blocca i rilievi **critici** e i report mancanti; gli altri rilievi non vengono nascosti. Gli **11 elevati** restano da valutare e correggere prima di un impiego con dati reali. Zero critici non significa assenza di vulnerabilità.

## Licenza e open source

**Il modello scelto è proprietario/source-available, non open source.** [LICENSE.md](LICENSE.md) consente gratuitamente solo l’**uso strettamente privato e non commerciale di una persona fisica**. Ogni altro uso richiede **prima dell’utilizzo un accordo commerciale scritto a titolo oneroso**, salvo diversa autorizzazione scritta del titolare.

| Utilizzo | Regola |
| --- | --- |
| Uso personale/domestico e sperimentazione personale non commerciale | Diritto d’uso gratuito, rispettando i termini; nessuna attivazione tecnica. |
| Uso operativo nel proprio salone, azienda o attività professionale | Accordo commerciale richiesto, anche per la sola gestione interna. |
| Uso per clienti, associazioni, enti, scuole o altre organizzazioni | Non è uso privato: accordo richiesto anche senza utile o incasso immediato. |
| Rivendita, hosting, SaaS, white-label o integrazione in altri prodotti | Accordo specifico; prezzo, canone o eventuale royalty vanno concordati. |

**Non sono stati fissati prezzi o percentuali sui ricavi.** La licenza non crea una partecipazione automatica a qualsiasi fatturato. Il software non ha ricevuto un sistema di incasso, rendicontazione royalties o classificazione automatica dell’uso.

> [!IMPORTANT]
> **Nessuna attivazione tecnica.** Il vecchio sistema di file firmati, HWID, scadenze e monitor è stato rimosso, non aggirato con un selettore “sempre valido”. Questo non concede automaticamente nuovi diritti d’uso o redistribuzione: restano i termini proprietari e le condizioni dei terzi.

Rendere visibili i sorgenti non rende synk open source. AGPL, MIT o Apache permetterebbero anche usi commerciali conformi senza corrispondere automaticamente compensi al titolare: non sono il modello selezionato. Le eventuali violazioni si valutano secondo la legge applicabile, **senza promettere conseguenze penali automatiche**. Il testo personalizzato e gli accordi economici devono essere verificati da un professionista prima della distribuzione commerciale.

### Dipendenze: licenze autonome

Il runtime usa **`whatsapp-web.js@1.34.7` (Apache-2.0)** e **`qrcode@1.5.4` (MIT)**. OpenWA e il suo override `parse-url` sono stati rimossi da manifest e lockfile, senza convertire o cancellare le sessioni precedenti. I [testi originali dei nuovi componenti](deploy/THIRD_PARTY_NOTICES.md) sono distribuiti anche nello ZIP e nelle immagini.

**La migrazione del codice è eseguita, il collaudo WhatsApp reale resta da fare.** Serve una nuova associazione QR; LocalAuth conserva il profilo in una directory separata nel runtime. Il nuovo adapter gestisce eventi, invio, LID, stato e arresto senza logout. Non è la Cloud API ufficiale e non elimina i termini del servizio o i rischi per l’account.

**[Procedura, percorsi e rollback della migrazione →](docs/WHATSAPP_MIGRATION.md)**

**[Decisione di licenza e stato della distribuzione →](docs/OPEN_SOURCE_READINESS.md)**

`private: true` in `package.json` continua a impedire pubblicazioni npm accidentali. I metadati rimandano ai termini personalizzati con `SEE LICENSE IN LICENSE.md`. La visibilità del repository non è cambiata. I vecchi controlli tecnici di attivazione sono invece stati rimossi.

## Documentazione

| Voglio… | Dove andare |
| --- | --- |
| Migrare WhatsApp, riassociare la sessione e preparare il rollback | [Guida OpenWA → whatsapp-web.js](docs/WHATSAPP_MIGRATION.md) |
| Capire diritti d’uso e vincoli di distribuzione | [Decisione e readiness](docs/OPEN_SOURCE_READINESS.md) |
| Preparare una RC e la bozza di release | [RELEASE.md](RELEASE.md) |
| Installare senza modificare JSON e usare il menu | [Primi passi Windows](deploy/PRIMI_PASSI.md) · [LEGGIMI.txt](LEGGIMI.txt) |
| Distinguere miglioramenti plug-and-play e prove effettive | [Report tecnico](docs/PLUG_AND_PLAY.md) |
| Eseguire il collaudo sul PC reale | [COLLAUDO.md](COLLAUDO.md) |
| Conoscere ricostruzione e limiti | [REPORT_RICOSTRUZIONE_RC6.md](REPORT_RICOSTRUZIONE_RC6.md) |
| Leggere le modifiche | [CHANGELOG.md](CHANGELOG.md) |
| Gestire sicurezza e dati riservati | [SECURITY.md](SECURITY.md) |
| Leggere i diritti attualmente concessi | [LICENSE.md](LICENSE.md) · [Avvisi di terzi](deploy/THIRD_PARTY_NOTICES.md) |
| Rigenerare banner e anteprime | [Guida agli asset](docs/readme/README.md) |
| Esaminare i controlli automatici | [Workflow CI](.github/workflows/ci.yml) · [Workflow prerelease](.github/workflows/prerelease.yml) |

---

<div align="center">
  <img src="assets/logo.svg" width="36" height="36" alt="Logo synk">
  <p><strong>Il tuo salone, in sintonia.</strong><br>Automazioni verificabili. Supervisione umana. Limiti dichiarati.</p>
</div>
