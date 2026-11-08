# synk: licenza scelta e stato della distribuzione

**Valutazione dell’8 novembre 2026.** Il milestone plug-and-play `9ff8000` ha 6 job CI verdi e 239 test Node; audit e SBOM mantengono il lockfile migrato a whatsapp-web.js. Verificare la CI del commit effettivo, non solo lo snapshot storico. [Guida e confini delle prove](PLUG_AND_PLAY.md).

## Risposta breve

**Il modello scelto dal titolare è proprietario/source-available, non open source:** diritto d’uso gratuito soltanto per una persona fisica nella propria sfera privata e non commerciale; **ogni altro uso richiede un accordo commerciale scritto a titolo oneroso**, salvo diversa autorizzazione scritta.

**OpenWA è stato sostituito nel codice e nel lockfile da `whatsapp-web.js@1.34.7` (Apache-2.0).** Questo rimuove tale dipendenza H-DNH dalla nuova installazione, non riscrive i diritti sulle vecchie copie né risolve automaticamente sicurezza, obblighi di tutte le dipendenze o termini del servizio WhatsApp.

| Obiettivo | Verdetto attuale |
| --- | --- |
| Proseguire il collaudo in una RC privata | **Sì**, con i limiti dichiarati e account/dati di prova. |
| Chiamare i sorgenti proprietari «open source» | **No**: sarebbe un’etichetta incoerente con i diritti concessi. |
| Pubblicare una prerelease realmente open source | **Non con il modello scelto:** richiedere un pagamento per ogni uso non privato non è una licenza open source. Servirebbe una nuova decisione del titolare. |
| Dichiarare una stabile per clienti reali | **No**: restano revisione delle vulnerabilità, aspetti legali e collaudo operativo. |

Questa è una valutazione tecnica e documentale, **non un parere legale**. La licenza di synk e i metadati sono stati aggiornati alla decisione del titolare. Il vecchio sistema tecnico di attivazione è stato rimosso. Visibilità del repository, tag e release remote non sono stati modificati; la rimozione non amplia i diritti d’uso. Il testo personalizzato e gli accordi economici richiedono revisione professionale prima della distribuzione commerciale.

## 1. Che cosa è già verificato

La [CI senza attivazione `a7deb3d`](https://github.com/oakvx/synkris/actions/runs/42531242615) ha completato tutti i **6 job**:

- Node.js 22 e 24: **242 test**, zero fallimenti/skip.
- PHP 8.3 nativo con `pdo_pgsql` e `curl`, integrazione PostgreSQL 16,
  bootstrap reale senza licenza, proxy/checklist e roundtrip backup/restore su DB CI sintetico separato.
- Windows PowerShell 5.1 e PowerShell 7: parser, ZIP, configuratore, import,
  avvio, proprietà progetto, autostart COM solo in TEMP, report e correzione iniziale.
- Build Docker, import SDK, smoke Apache e doctor effettivo senza rete o avvio
  dipendenze/DB, senza creare marker import o volumi dati.

La migrazione precedente aveva **139 test Node** e la [relativa CI riuscita](https://github.com/oakvxish/synkris/actions/runs/42511346131); la baseline ancora precedente `bdee2e5` ne aveva 92. Sono risultati storici distinti: non usare i numeri della base per attestare un nuovo commit. I casi aggiunti dopo il milestone richiedono la CI del ref corrente.

Il controllo del repository non ha segnalato file privati nell’albero corrente. I provider sono simulati dove previsto; LocalAuth, Message e l’encoder PNG sono esercitati anche tramite le API effettivamente installate, **senza aprire una sessione WhatsApp**.

**Confini dell’evidenza:** un job Windows riuscito non è un’installazione sul PC del salone; uno smoke test Docker non è un collaudo QR/Google/recovery. Il report di ricostruzione conserva risultati storici, ora distinti dall’aggiornamento successivo.

## 2. Decisione di licenza e componenti

### A. Uso privato gratuito; ogni altro uso su accordo commerciale

[LICENSE.md](../LICENSE.md) concede l’uso personale/domestico non commerciale a una persona fisica, anche per studio e sperimentazione personali. Non estende tale gratuità a saloni, imprese, professionisti, clienti, associazioni, enti o scuole, né a rivendita, hosting, SaaS, white-label o servizi a terzi. Non basta che il servizio sia gratuito o che non abbia ancora prodotto un utile.

Gli altri usi richiedono prima dell’utilizzo un accordo scritto a titolo oneroso con il titolare, salvo sua diversa autorizzazione scritta. **Prezzi, canoni e percentuali sui ricavi non sono predefiniti:** vanno stabiliti nell’accordo, insieme a base di calcolo, rendicontazione e scadenze. La licenza non attribuisce automaticamente una quota di qualsiasi fatturato.

AGPL, MIT e Apache permettono anche usi commerciali conformi senza un pagamento automatico al titolare. Per questo **non è stata applicata una di queste licenze al codice di synk**. I metadati npm e il lockfile rimandano a `SEE LICENSE IN LICENSE.md`; `private: true` rimane attivo.

Prima della distribuzione commerciale occorrono comunque verifica della titolarità dei diritti, intestazione legale, contatti, accettazione dei termini e revisione professionale del testo. La tutela dei diritti avviene secondo la legge: non ogni violazione è automaticamente un reato e non sono state introdotte penali automatiche.

### B. OpenWA rimosso; diritti di terzi ancora autonomi

| Componente | Stato / licenza |
| --- | --- |
| `@open-wa/wa-automate@4.76.0` | Rimosso da manifest, lockfile e runtime. Le vecchie copie avevano metadati `H-DNH V1.0` e testo H-DNH 1.1: i relativi obblighi non vengono cancellati retroattivamente. |
| `whatsapp-web.js@1.34.7` | Nuovo provider, Apache-2.0; `Client`, `LocalAuth`, eventi nativi, API di invio/stato e `destroy`. |
| `qrcode@1.5.4` | MIT; conversione del QR nativo in PNG in RAM. |
| Puppeteer | 24.38.0 tramite il nuovo SDK; browser di sistema in Docker, download/lifecycle npm disabilitati. |

I [testi originali dei due nuovi componenti](../deploy/THIRD_PARTY_NOTICES.md) sono inclusi nel pacchetto e nelle immagini, senza sostituirli con la licenza proprietaria. Il testo di licenza upstream è verificabile nei pacchetti installati e nel [repository whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js/blob/main/LICENSE). Il precedente override Postman/`parse-url` di OpenWA è rimosso, non riutilizzato sul nuovo provider.

La [guida di migrazione](WHATSAPP_MIGRATION.md) documenta nuova associazione QR obbligatoria, directory LocalAuth separata, conservazione dei file OpenWA, rollback e collaudo. Le sessioni **non sono convertite** e il loro mantenimento su disco non prova che WhatsApp le autorizzi ancora. Non eseguire contemporaneamente vecchio e nuovo bot sullo stesso account.

È stato rigenerato un SBOM CycloneDX di produzione con **335 componenti**, in `artifacts/sbom.cdx.json` (ignorato da Git): OpenWA è assente e i nuovi componenti espongono Apache-2.0/MIT. Il documento non è una certificazione di compatibilità: occorrono ancora revisione dell’intero inventario, testi, avvisi e pacchetti delle immagini Docker.

```sh
npm sbom --omit=dev --sbom-format=cyclonedx > artifacts/sbom.cdx.json
```

WhatsApp Web rimane un’integrazione **non ufficiale**: una libreria permissiva non elimina i termini del servizio, i possibili rischi per l’account o la necessità di collaudo reale.

### C. Diritto d’uso e attivazione tecnica sono distinti

Il vecchio sistema tecnico di attivazione è stato **eliminato**: verificatori Node/PHP, file firmati, HWID, scadenze, monitor e vincoli di bootstrap non fanno più parte dell’applicazione. Installazione, dashboard, associazione WhatsApp e API autenticate non richiedono una licenza tecnica, una chiave pubblica o un rinnovo. Non è un flag di bypass o un falso stato “valido”.

Restano configurazione, credenziali Google, password database/dashboard, token admin, login, controlli origin/CSRF, porte loopback e riconciliazione dopo restore. I vecchi file/impostazioni di attivazione sono ignorati e non cancellati o esportati; le esclusioni e le redazioni difensive restano per evitare fughe di dati legacy.

**Questa rimozione non cambia il modello proprietario né concede nuovi diritti d’uso o redistribuzione.** Per gli usi non privati resta l’accordo richiesto. Il software non classifica la natura dell’utilizzo e non calcola o incassa royalties. I costi dei servizi terzi, hardware, installazione e assistenza restano distinti dal diritto d’uso privato gratuito.

**Le anteprime restano soltanto frontend con fixture documentali**, non una prova dei provider reali. Non pubblicare segreti, vecchie attivazioni cliente, sessioni o backup privati.

### D. Prima di rendere pubblico serve una revisione della cronologia

Il checkout disponibile è **shallow**. `npm run check:repo` controlla l’albero corrente e alcune firme di credenziali, non tutti i commit storici e non tutti i possibili dati sensibili.

Prima di cambiare visibilità:

- [ ] Ottenere e scansionare la cronologia completa e i ref destinati alla pubblicazione.
- [ ] Rivedere log, artifact, immagini Docker, dump, vecchi file di attivazione, profili browser, sessioni e QR.
- [ ] Revocare eventuali credenziali esposte: cancellare un file non revoca un segreto.
- [ ] Verificare copyright, provenienza degli asset e diritti sui contributi.
- [ ] Stabilire un canale privato per le segnalazioni di vulnerabilità e regole di contribuzione coerenti con la licenza.

Il repository risulta attualmente **privato** e GitHub classifica la licenza come **Other**. Non è stata effettuata un’apertura pubblica.

## 3. Sicurezza e produzione: un piano distinto

L’audit di produzione rieseguito l’8 novembre 2026 sul lockfile migrato riporta:

| Livello | Rilievi |
| --- | ---: |
| Critico | **0** |
| Elevato | **11** |
| Moderato | **8** |
| Basso | **0** |
| **Totale** | **19** |

La base precedente aveva 57 rilievi, di cui 32 elevati. La riduzione **non è una revisione di esposizione** e non rende la RC approvata per produzione. Il gate ferma report mancanti/non validi e rilievi critici; gli elevati restano visibili, ma **non fanno fallire quel gate**. Non è stato applicato `npm audit fix --force` o un downgrade automatico del provider.

Prima di un impiego con dati reali occorrono almeno:

- [ ] Analisi di esposizione, correzioni e mitigazioni delle dipendenze vulnerabili, con test del bot.
- [ ] Collaudo Google Calendar: modifiche concorrenti, cancellazioni, errori e riconciliazione outbox.
- [ ] Collaudo WhatsApp: nuovo QR, riavvio con LocalAuth, LID se disponibili, riconnessione, revoca, messaggi, presa in carico e invii dall’esito incerto.
- [ ] Installazione e aggiornamento sul PC Windows/Docker Desktop/WSL2 di destinazione, inclusa sandbox Chromium senza bypass automatici.
- [ ] Backup/restore reale, revisione dopo migrazioni e prova fisica dell’export USB BitLocker.
- [ ] SMTP su opt-in, conservazione dei dati e procedure operative/privacy.
- [ ] Compilazione e approvazione di [COLLAUDO.md](../COLLAUDO.md).

**Questi rischi non rendono impossibile pubblicare sorgenti sperimentali** dopo aver risolto diritti e riservatezza. Impediscono però di confondere quella pubblicazione con una stabile o con una certificazione per il salone.

## 4. Sequenza consigliata

1. **Formalizzare il modello scelto:** uso privato non commerciale gratuito; tutti gli altri usi su accordo commerciale scritto. Verifica professionale di titolarità, testo e contratti economici.
2. **Revisionare i componenti effettivi dopo la migrazione:** inventario, avvisi, licenze e 19 rilievi; non soltanto il nuovo SDK.
3. **Collaudare l’installazione senza attivazione tecnica:** Google, nuova sessione WhatsApp, credenziali e protezioni operative; verificare separatamente l’autorizzazione d’uso applicabile.
4. **Revisionare un’eventuale apertura pubblica:** cronologia completa, segreti, diritti e canale security.
5. **Pubblicare eventualmente una RC sperimentale**, con limiti e audit chiari, da un commit esatto e verificato. Richiede una nuova autorizzazione alla pubblicazione.
6. **Promuovere a stabile solo dopo il collaudo reale** e la revisione di sicurezza.

`private: true` in `package.json` può rimanere come protezione da pubblicazioni npm accidentali anche in un repository pubblico: non è una licenza e non va rimosso per semplice estetica.

## Riferimenti interni

[README](../README.md) · [Migrazione WhatsApp](WHATSAPP_MIGRATION.md) · [Licenza](../LICENSE.md) · [Avvisi di terzi](../deploy/THIRD_PARTY_NOTICES.md) · [Sicurezza](../SECURITY.md) · [Release](../RELEASE.md) · [Collaudo](../COLLAUDO.md)
