# synk: licenza scelta e stato della distribuzione

**Valutazione dell’8 novembre 2026.** La CI storica è riferita alla base `bdee2e5`; test locali, lockfile, audit e SBOM qui aggiornati si riferiscono alla migrazione a whatsapp-web.js. Verificare sempre anche la CI del commit effettivo della PR.

## Risposta breve

**Il modello scelto dal titolare è proprietario/source-available, non open source:** diritto d’uso gratuito soltanto per una persona fisica nella propria sfera privata e non commerciale; **ogni altro uso richiede un accordo commerciale scritto a titolo oneroso**, salvo diversa autorizzazione scritta.

**OpenWA è stato sostituito nel codice e nel lockfile da `whatsapp-web.js@1.34.7` (Apache-2.0).** Questo rimuove tale dipendenza H-DNH dalla nuova installazione, non riscrive i diritti sulle vecchie copie né risolve automaticamente sicurezza, obblighi di tutte le dipendenze o termini del servizio WhatsApp.

| Obiettivo | Verdetto attuale |
| --- | --- |
| Proseguire il collaudo in una RC privata | **Sì**, con i limiti dichiarati e account/dati di prova. |
| Chiamare i sorgenti proprietari «open source» | **No**: sarebbe un’etichetta incoerente con i diritti concessi. |
| Pubblicare una prerelease realmente open source | **Non con il modello scelto:** richiedere un pagamento per ogni uso non privato non è una licenza open source. Servirebbe una nuova decisione del titolare. |
| Dichiarare una stabile per clienti reali | **No**: restano revisione delle vulnerabilità, aspetti legali e collaudo operativo. |

Questa è una valutazione tecnica e documentale, **non un parere legale**. La licenza di synk e i metadati sono stati aggiornati alla decisione del titolare. I verificatori firma/HWID, la visibilità del repository, i tag e le release remote non sono stati modificati. Il testo personalizzato e gli accordi economici richiedono revisione professionale prima della distribuzione commerciale.

## 1. Che cosa è già verificato

La [CI sul commit di base](https://github.com/oakvxish/synkris/actions/runs/42504896463) aveva completato tutti i **6 job**, con **92 test Node**:

- Node.js 22 e 24.
- PHP 8.3 nativo con `pdo_pgsql`, `curl`, `sodium`, più integrazione PostgreSQL 16.
- Windows PowerShell 5.1 e PowerShell 7: build, parser, ZIP e conservazione dei percorsi privati.
- Build Docker, contratto d’importazione delle dipendenze e smoke test del confine Apache.

**Per la migrazione** sono stati rieseguiti localmente installazione da lockfile, `npm run check` e **139 test Node**, inclusi i contratti del nuovo provider e gli esiti incerti. La CI ora importa il nuovo SDK nell’immagine di produzione e controlla anche asset, link e metadati di licenza. Consultare l’esecuzione della PR per i risultati dei runner sul nuovo commit: il verde della base **non è** la prova della nuova build.

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

I verificatori in `src/licensing/`, `deploy/license-guard.php` e nel bootstrap verificano il file firmato e l’HWID. **Sono rimasti invariati e sono richiesti anche per l’uso privato.** La verifica precede la creazione del provider e viene ripetuta dopo l’associazione prima di abilitare messaggi e worker. Non è stata aggiunta una variabile che trasformi qualsiasi installazione in una modalità gratuita o aggiri la firma.

Per l’uso privato non commerciale il diritto d’uso e la relativa attivazione sono gratuiti secondo la licenza, ma la richiesta e l’emissione del file sono gestite manualmente dal titolare. Non esiste ancora un percorso self-service: la gratuità giuridica non equivale a un’attivazione già disponibile.

Per gli usi non privati il file firmato non sostituisce l’accordo economico. Il software non classifica automaticamente la natura dell’utilizzo, non calcola royalties e non ha ricevuto un sistema di incasso o rendicontazione. I costi di servizi terzi, hardware, installazione assistita e assistenza restano distinti dal diritto d’uso privato gratuito.

**Le anteprime restano soltanto frontend con fixture documentali**, non un’applicazione avviata senza licenza. Prima della distribuzione occorre documentare e verificare con il titolare il processo manuale di rilascio, senza pubblicare chiavi private o attivazioni cliente.

### D. Prima di rendere pubblico serve una revisione della cronologia

Il checkout disponibile è **shallow**. `npm run check:repo` controlla l’albero corrente e alcune firme di credenziali, non tutti i commit storici e non tutti i possibili dati sensibili.

Prima di cambiare visibilità:

- [ ] Ottenere e scansionare la cronologia completa e i ref destinati alla pubblicazione.
- [ ] Rivedere log, artifact, immagini Docker, dump, licenze cliente, profili browser, sessioni e QR.
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
3. **Collaudare installazione e attivazione:** rilascio manuale dell’attivazione privata gratuita e procedure commerciali distinte; nuova sessione WhatsApp, nessun bypass nascosto.
4. **Revisionare un’eventuale apertura pubblica:** cronologia completa, segreti, diritti e canale security.
5. **Pubblicare eventualmente una RC sperimentale**, con limiti e audit chiari, da un commit esatto e verificato. Richiede una nuova autorizzazione alla pubblicazione.
6. **Promuovere a stabile solo dopo il collaudo reale** e la revisione di sicurezza.

`private: true` in `package.json` può rimanere come protezione da pubblicazioni npm accidentali anche in un repository pubblico: non è una licenza e non va rimosso per semplice estetica.

## Riferimenti interni

[README](../README.md) · [Migrazione WhatsApp](WHATSAPP_MIGRATION.md) · [Licenza](../LICENSE.md) · [Avvisi di terzi](../deploy/THIRD_PARTY_NOTICES.md) · [Sicurezza](../SECURITY.md) · [Release](../RELEASE.md) · [Collaudo](../COLLAUDO.md)
