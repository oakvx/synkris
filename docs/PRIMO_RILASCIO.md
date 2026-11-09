# Valutazione del primo rilascio synk

Snapshot del **9 novembre 2026**, basato sulla revisione dei file del branch `master` (prima della PR di preparazione). Questa pagina non sostituisce `RELEASE.md` né `COLLAUDO.md`.

## Decisione proposta

**Prima uscita: `v1.2.0-rc.6`, esclusivamente come Draft + Prerelease di collaudo tecnico.**

- **Sì:** generare ZIP, checksum e manifest da un commit revisionato, farli scaricare al tecnico e testarli su un PC Windows di prova, con account dedicati al test e dati fittizi, usando credenziali valide solo per l'ambiente di prova.
- **Non ancora:** pubblicare una release stabile, fornire il pacchetto ai saloni per gestire clienti veri o promettere un installer `.exe` autonomo.
- **La prima release pubblica:** richiede una decisione separata, dopo collaudo reale, revisione delle dipendenze e verifica delle condizioni commerciali.

## Stato dei componenti

| Componente | Presenza | Prova ancora necessaria |
| --- | --- | --- |
| `src/index.js` e logica Node | Implementato | Esecuzione con account WhatsApp di prova |
| Dashboard PHP | Implementata | Login, editor, ruoli e comportamento reale in browser |
| PostgreSQL / outbox | Implementati, con test automatizzati | Conflitti e restore su host reale |
| Google Calendar | Adapter e integrazione presenti | Disponibilità, ricorrenze, sync bidirezionale e disconnessioni reali |
| `whatsapp-web.js` / LocalAuth | Codice e test simulati | Associazione QR, riconnessione, revoca e compatibilità provider |
| Installazione Windows | Wizard PowerShell + BAT | Docker Desktop/WSL2 su PC reale e test primo avvio |
| Generatore release | ZIP piatto con allowlist, manifest e SHA256 | Build del commit candidato e verifica degli artifact del workflow |
| AI locale | Ollama opzionale | Abilitazione e verifica separata; non necessario alla prima RC |
| Attivazione | Licenza firmata/HWID | Emissione della licenza di collaudo e import corretto |
| Sicurezza | Audit automatico e controlli di segreti | Risoluzione/accettazione documentata dei rilievi e revisione prima di dati veri |

L'audit citato nel repository l'**8 novembre 2026** segnalava **11 vulnerabilità elevate, 8 moderate e 0 critiche**. È un dato storico, non un'approvazione di sicurezza: consultare l'audit del commit della release. La CI con simulatori **non sostituisce** i test con provider reali.

## Che cosa si trova nella sezione GitHub Releases

Il workflow `.github/workflows/prerelease.yml` produce:

1. `synk-1.2.0-rc.6.zip`: codice, dashboard, strumenti Windows, Compose, Dockerfile, guida `PRIMO_AVVIO.txt` e licenza, **senza credenziali o dati cliente**.
2. `synk-1.2.0-rc.6.zip.sha256`: checksum dell'archivio.
3. `RELEASE-MANIFEST.json`: provenienza del commit, versione e SHA256 dei singoli file.

Non sono inclusi Docker Desktop, immagini precompilate, dipendenze installate, licenze cliente, chiavi Google o un eseguibile Windows autonomo. Il wizard prepara le immagini sul PC, con rete disponibile e Docker Desktop / WSL2 installati.

## Primo percorso verificabile (senza pubblicare)

1. Congelare il commit candidato dopo la fusione della PR e verificare tutti i job GitHub Actions.
2. Aprire **Actions → Prerelease → Run workflow** sul branch predefinito, lasciare `create_draft=false` e lanciare la build.
3. Scaricare l'artifact `synk-prerelease`; controllare che contenga i tre file, il nuovo `PRIMO_AVVIO.txt` nello ZIP, la versione, il commit e `sourceDirty=false` nel manifest.
4. Verificare il checksum con `sha256sum -c` oppure con un equivalente Windows affidabile, confrontando i valori con il canale ufficiale.
5. Provare `INSTALLA_UNA_VOLTA.bat` su un **PC Windows dedicato** con Docker Desktop/WSL2, account e calendari di prova; completare `COLLAUDO.md`.
6. Solo se il test del pacchetto è accettabile, ripetere il workflow con `create_draft=true` per creare `v1.2.0-rc.6` come **Draft + Prerelease**. Esaminare i file e le note prima di qualsiasi pubblicazione.

**Il repository sorgente è pubblico.** La bozza GitHub Release non è visibile ai visitatori, ma il comando *Publish release* renderebbe gli allegati disponibili pubblicamente. Non allegare mai dati del salone, credenziali, licenze cliente, dump, sessioni o log.

## Condizioni per promuovere il pacchetto a uso reale

- Collaudo Windows, Google Calendar, WhatsApp, backup/restore, sicurezza delle credenziali e privacy completato e firmato da chi effettua il test.
- Revisione e mitigazione delle dipendenze vulnerabili, verifica delle licenze dei componenti e dei termini WhatsApp Web.
- Revisione del repository pubblico e della **cronologia Git** per materiale riservato; in caso di esposizione, revoca delle credenziali, non semplice cancellazione del file.
- Condizioni commerciali scritte per l'uso in un salone; distribuzione di chiavi firmate/HWID attraverso un canale separato.
- Test di aggiornamento e recupero dati da un pacchetto precedente, senza presumere che un rollback di codice annulli migrazioni PostgreSQL.
- Scelta esplicita di un nuovo tag/versione se il codice cambia dopo il freeze.

Per l'intera procedura tecnica e le avvertenze: [RELEASE.md](../RELEASE.md), [COLLAUDO.md](../COLLAUDO.md), [SECURITY.md](../SECURITY.md).
