<div align="center">

<img src="docs/assets/synkris-hero.svg" alt="SYNKRIS presenta synk: meno gestione, più relazione. Illustrazione concettuale in viola e fucsia." width="100%">

# SYNKRIS · synk

### Il tuo salone, in sintonia. Anche quando l'agenda si complica.

**synk** è un sistema di automazione per attività che lavorano su appuntamento. Riunisce gestione dei clienti, organizzazione del team, conversazioni WhatsApp e integrazione con Google Calendar in un'esperienza pensata per chi deve occuparsi delle persone, non rincorrere i messaggi.

**[Richiedi informazioni o una demo](https://github.com/oakvx/synkris/issues/new?template=richiesta-demo.yml)** · **[Guarda l'interfaccia](#uno-sguardo-alla-dashboard)** · **[Scopri come funziona](#come-funziona)**

<sub>Versione attuale: `1.2.0-rc.6` · Release candidate di collaudo · Licenza proprietaria · Italiano</sub>

</div>

---

## Meno tempo a organizzare. Più tempo per il tuo lavoro.

Un cliente scrive mentre sei impegnato. Un altro chiede un appuntamento. Una collega cambia disponibilità. Poi c'è da controllare il calendario, rispondere, registrare e verificare che tutto sia andato a buon fine.

**synk nasce per rendere questo lavoro più ordinato.** Il sistema è progettato per affiancare il salone nella gestione operativa, automatizzando i passaggi ripetitivi e lasciando al team la possibilità di intervenire.

<img src="docs/assets/synkris-benefits.svg" width="100%" alt="Tre benefici: meno interruzioni, agenda più chiara, più tempo per la relazione con i clienti.">

### Pensato per attività dove ogni appuntamento conta

**Centri estetici e benessere · Nail studio · Parrucchieri e barber shop · Studi di tatuaggio · Altri saloni su appuntamento**

Il modello di servizi, durate e disponibilità può essere configurato per processi diversi. La compatibilità con un'attività specifica viene valutata durante la configurazione e il collaudo: non tutti i flussi sono pronti all'uso senza adattamenti.

## Cosa offre synk

| Per il salone | Cosa fa il sistema |
| :--- | :--- |
| **Prenotazioni organizzate** | Gestisce servizi multipli, durate per operatrice, buffer e controllo delle sovrapposizioni. |
| **Agenda coordinata** | Integra Google Calendar e rende distinguibili le operazioni registrate, quelle in coda e quelle da verificare. |
| **Clienti e trattamenti** | Mantiene anagrafiche, catalogo servizi, abilitazioni delle operatrici e configurazioni specifiche. |
| **Messaggi WhatsApp** | Prevede conversazioni operative e presa in carico manuale da parte del team. |
| **Gestione del lavoro** | Considera orari settimanali, pause, chiusure, assenze e lista d'attesa con consenso. |
| **Dashboard di controllo** | Espone stato dei servizi, attività da verificare, manutenzione e richieste privacy. |
| **AI locale facoltativa** | Offre un'integrazione opzionale con Ollama; non è necessaria per tutte le funzioni e non sostituisce le verifiche applicative. |

Queste sono **capacità implementate nel progetto e oggetto di collaudo**, non una dichiarazione che tutte le integrazioni siano operative presso un salone reale. I risultati dipendono anche dalle impostazioni, dalla disponibilità dei provider e dai test dell'installazione.

## Come funziona

<img src="docs/assets/synkris-journey.svg" width="100%" alt="Flusso concettuale di synk: il cliente invia una richiesta, synk verifica il contesto, registra e sincronizza gli stati e il team mantiene il controllo.">

**1. Il cliente contatta il salone.** Una richiesta entra tramite il canale WhatsApp associato, quando il servizio è configurato e connesso.

**2. synk verifica i dettagli.** Trattamenti, durata, operatrici e disponibilità sono controllati in base alle regole del salone.

**3. La prenotazione viene gestita con stati espliciti.** I dati applicativi sono salvati localmente; la sincronizzazione con Google Calendar è monitorata e può richiedere una verifica.

**4. Il team può intervenire.** L'operatore conserva la possibilità di assumere il controllo della conversazione e gestire i casi che richiedono attenzione.

> **Un dettaglio importante:** se Google Calendar non risponde in modo affidabile, synk non presume che uno slot sia disponibile. Un'operazione **in coda** non equivale a una conferma di sincronizzazione.

## Uno sguardo alla dashboard

L'interfaccia è pensata per mostrare le informazioni utili senza nascondere gli stati operativi.

> [!NOTE]
> **Anteprime documentali, non dati di clienti reali.** Le schermate seguenti sono state renderizzate dal frontend ricostruito con **fixture sintetiche** e dati dimostrativi. Non certificano un collegamento WhatsApp o Google Calendar effettivamente funzionante.

<p align="center"><a href="docs/assets/dashboard-overview.webp"><img src="docs/assets/dashboard-overview.webp" width="100%" alt="Dashboard synk dimostrativa con dati sintetici e stati operativi."></a></p>

<table>
  <tr>
    <td width="50%"><a href="docs/assets/dashboard-agenda.webp"><img src="docs/assets/dashboard-agenda.webp" alt="Agenda dimostrativa con stati distinti e appuntamenti fittizi."></a></td>
    <td width="50%"><a href="docs/assets/dashboard-editor.webp"><img src="docs/assets/dashboard-editor.webp" alt="Editor dimostrativo di un appuntamento con più trattamenti."></a></td>
  </tr>
  <tr>
    <td><strong>Agenda leggibile</strong><br>Appuntamenti e sincronizzazioni non vengono confusi.</td>
    <td><strong>Trattamenti su misura</strong><br>Durate, ordine dei servizi e operatrici in un unico flusso.</td>
  </tr>
</table>

*Apri le immagini per ingrandirle. [Origine delle anteprime e come rigenerarle](docs/readme/README.md).*

## Un sistema che lavora vicino alla tua attività

synk è progettato per un'**installazione locale assistita** sul computer del salone, non come una piattaforma cloud già pronta da attivare con un clic.

- **Controllo operativo:** dati applicativi in PostgreSQL locale, dashboard web sul PC e processi di manutenzione espliciti.
- **Collegamenti necessari:** Google Calendar e WhatsApp restano provider esterni; i dati richiesti dalle rispettive integrazioni vengono trasmessi ai loro servizi.
- **Supervisione umana:** conversazioni sospendibili, stati verificabili e intervento del personale.
- **AI come opzione:** Ollama può essere abilitato localmente, ma è disattivato per impostazione predefinita.

**Locale non significa offline:** agenda Google, WhatsApp ed eventuali notifiche SMTP richiedono connessione e configurazione. Il backup PostgreSQL non è automaticamente cifrato; vanno applicate le procedure di protezione indicate nella documentazione.

## Vuoi capire se synk è adatto al tuo salone?

Ogni attività ha trattamenti, orari, abitudini e modalità di gestione differenti. Per questo la proposta parte dai **processi da semplificare**, non da un elenco generico di funzioni.

<div align="center">

### Raccontaci come lavori oggi.

**[Richiedi informazioni o una demo di collaudo](https://github.com/oakvx/synkris/issues/new?template=richiesta-demo.yml)**

<sub>La richiesta avviene tramite GitHub e può essere pubblica: non inserire contatti personali, dati di clienti, credenziali o informazioni riservate. Non si tratta di un ordine o di un'attivazione immediata.</sub>

</div>

---

## Per sviluppatori e tecnici

Questa sezione descrive **quello che il repository contiene oggi** e i limiti della release. Per installazione, attivazione commerciale o uso con dati reali è necessario seguire i documenti tecnici e completare il collaudo.

### Architettura

<img src="docs/assets/synkris-architecture.svg" width="100%" alt="Architettura locale di synk: browser, dashboard PHP, PostgreSQL, Node.js e Ollama opzionale, con Google e WhatsApp come servizi esterni.">

<img src="docs/assets/synkris-stack.svg" width="100%" alt="Stack di synk: Node.js 22/24, PHP 8.3, PostgreSQL 16, Docker/WSL2 e AI locale facoltativa.">

| Livello | Tecnologia / funzione |
| --- | --- |
| **Frontend amministrativo** | Dashboard PHP 8.3; sessioni, CSRF e proxy interno autorizzato |
| **Backend applicativo** | Node.js 22/24, Express, automazioni e API amministrativa |
| **Persistenza** | PostgreSQL 16, transazioni, vincoli anti-conflitto e outbox |
| **Agenda** | Google Calendar API, verifica disponibilità e sincronizzazione asincrona |
| **Messaggistica** | `whatsapp-web.js@1.34.7` tramite WhatsApp Web |
| **AI (opzionale)** | Ollama, abilitazione esplicita |
| **Ambiente locale** | Docker Compose e, su Windows, Docker Desktop / WSL2 |

> [!IMPORTANT]
> **WhatsApp non usa l'API ufficiale WhatsApp Business Cloud.** L'integrazione si basa su `whatsapp-web.js` / WhatsApp Web. Compatibilità, possibili restrizioni e conformità ai termini del provider devono essere valutate prima dell'uso. La migrazione del codice è eseguita; il collaudo WhatsApp reale resta da fare. L'adapter migrato non è stato convalidato su una sessione WhatsApp reale.

### Una prenotazione non è soltanto un «Salva»

<img src="docs/assets/synkris-booking-flow.svg" width="100%" alt="Schema tecnico di prenotazione: controlli, transazione locale, outbox e sincronizzazione Calendar.">

Il sistema distingue la **registrazione transazionale nel database** dall'invio asincrono verso Google Calendar. Questo riduce l'ambiguità degli stati, ma **non crea una transazione ACID distribuita** e non esclude tutte le condizioni di gara. Un ripristino sospende i worker fino alla riconciliazione tecnica.

### Stato del progetto

| Aspetto | Stato verificato / limite |
| --- | --- |
| **Versione** | `1.2.0-rc.6` — prerelease ricostruita, destinata al collaudo |
| **Test della migrazione** | Alla verifica dell'8 novembre 2026: 139 test Node locali superati |
| **CI della base storica** | 6 job superati sul commit indicato nel [report di rilascio](REPORT_RICOSTRUZIONE_RC6.md); non è una certificazione della nuova installazione |
| **Audit dipendenze** | 19 rilievi noti alla verifica dell'8 novembre 2026: **11 elevati, 8 moderati, 0 critici** |
| **Test con provider reali** | Ancora necessari su WhatsApp, Google Calendar, SMTP, Windows e procedure di ripristino |
| **Disponibilità commerciale** | Richiede valutazione, accordo scritto e collaudo assistito; nessun percorso self-service |

**Non considerare questa RC idonea a gestire appuntamenti e dati di clienti reali senza prima completare gli interventi di sicurezza e la [checklist di collaudo](COLLAUDO.md).** Questa fotografia storica **non è un badge live**: i risultati datati non garantiscono la versione attuale.

### Verifiche locali

Per chi è autorizzato a lavorare sul codice. Prerequisito: **Node.js 22 o 24**.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run audit:release
```

Per i controlli PHP servono PHP 8.3 con `pdo_pgsql`, `curl` e `sodium`:

```sh
npm run check:php
npm run test:php
```

Il test d'integrazione richiede un PostgreSQL **dedicato e cancellabile** denominato `synk_test`. Lo script può resettare lo schema `public`: **non usarlo mai con il database del salone**.

```sh
TEST_DATABASE_URL=postgresql://synk_test:synk_test@127.0.0.1:5432/synk_test \
SYNK_TEST_DB_ALLOW_RESET=1 npm run test:integration
```

Questi comandi controllano il codice e i componenti disponibili nell'ambiente: **non avviano automaticamente un salone configurato** e non dimostrano la disponibilità dei provider.

<details>
<summary><strong>Installazione di collaudo e manutenzione su Windows</strong></summary>

L'attuale percorso è **assistito da un tecnico**, con Docker Desktop / WSL2. Leggere prima [LEGGIMI.txt](LEGGIMI.txt), [RELEASE.md](RELEASE.md) e [COLLAUDO.md](COLLAUDO.md). Sono necessari configurazione riservata, chiavi e licenza firmata/HWID anche per la prova privata autorizzata.

| Operazione | Entrypoint |
| --- | --- |
| Prima installazione | `INSTALLA_UNA_VOLTA.bat` |
| Avvio e dashboard | `AVVIA_SYNK.bat` / `APRI_SYNK.bat` |
| Aggiornamento tecnico | `AGGIORNA_SYNK_TECNICO.bat` |
| Ripristino sospeso | `RIPRISTINA_BACKUP.bat` |
| Riconciliazione Calendar | `RIATTIVA_CALENDAR_TECNICO.bat` |
| Esportazione USB BitLocker | `ESPORTA_BACKUP_CIFRATO_TECNICO.bat` |
| AI locale opzionale | `ATTIVA_AI_LOCALE.bat` |

Per la migrazione WhatsApp, fermare l'istanza precedente e seguire la [guida dedicata](docs/WHATSAPP_MIGRATION.md). **Non eseguire `docker compose down -v` con dati del salone.** Il rollback del codice non annulla una migrazione del database.

</details>

### Privacy e sicurezza

- `.env`, `setup/config.json`, `secrets/`, `runtime/`, sessioni, licenze e chiavi private non devono entrare nel repository o nei pacchetti.
- La dashboard usa controlli di sessione e un proxy server-side per le operazioni amministrative; non esporre direttamente le porte interne.
- I backup contengono dati personali e richiedono procedure di protezione, conservazione e ripristino concordate.
- I log e le issue pubbliche **non** devono contenere numeri, conversazioni, QR, credenziali o informazioni sui clienti.
- I rilievi di sicurezza elevati ancora aperti richiedono valutazione e mitigazione **prima** dell'uso con dati reali.

Per i dettagli: [SECURITY.md](SECURITY.md).

### Licenza e utilizzo commerciale

**synk non è open source.** SYNKRIS distribuisce il prodotto come software proprietario con codice consultabile (source-available).

La [licenza attuale](LICENSE.md) permette gratuitamente solo un **uso strettamente privato e non commerciale da parte di una persona fisica**, con attivazione firmata. Anche per la prova privata il rilascio è gestito manualmente. L'uso in saloni, aziende, per clienti, in servizi ospitati, nella rivendita o nel white-label **richiede prima un accordo commerciale scritto**, salvo diversa autorizzazione espressa.

**Non è pubblicato un listino prezzi** e il repository non costituisce un'offerta commerciale vincolante. Le dipendenze di terzi mantengono le rispettive licenze: vedi [THIRD_PARTY_NOTICES.md](deploy/THIRD_PARTY_NOTICES.md).

### Documentazione

| Hai bisogno di… | Consulta |
| --- | --- |
| Panoramica della ricostruzione e limiti RC6 | [Report di ricostruzione](REPORT_RICOSTRUZIONE_RC6.md) |
| Procedura di installazione | [LEGGIMI.txt](LEGGIMI.txt) |
| Preparazione di una release | [RELEASE.md](RELEASE.md) |
| Test su PC e provider reali | [COLLAUDO.md](COLLAUDO.md) |
| Migrazione dell'integrazione WhatsApp | [WHATSAPP_MIGRATION.md](docs/WHATSAPP_MIGRATION.md) |
| Sicurezza e protezione dei dati | [SECURITY.md](SECURITY.md) |
| Diritti d'uso e distribuzione | [LICENSE.md](LICENSE.md) · [Readiness](docs/OPEN_SOURCE_READINESS.md) |
| Cronologia delle modifiche | [CHANGELOG.md](CHANGELOG.md) |
| Produzione delle immagini del README | [Guida agli asset](docs/readme/README.md) |
| Controlli automatici | [CI](.github/workflows/ci.yml) · [Prerelease](.github/workflows/prerelease.yml) |

---

<div align="center">

**SYNKRIS** · *Automazione con criterio. Persone al centro.*

**[Richiedi informazioni](https://github.com/oakvx/synkris/issues/new?template=richiesta-demo.yml)** · **[Torna all'inizio](#synkris-synk)**

<sub>Illustrazioni SVG originali; anteprime con dati sintetici. Nessuna statistica commerciale o recensione inventata.</sub>

</div>
