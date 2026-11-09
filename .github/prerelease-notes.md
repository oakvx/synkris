## Candidata ricostruita — solo collaudo

Dashboard, deploy, asset e strumenti Windows sono stati ricostruiti dai contratti
rimasti nel repository, non recuperati dagli originali. Leggere
`RELEASE.md` e `CHANGELOG.md` nello ZIP. Il report storico RC6 e' disponibile
nel repository sotto `docs/history/REPORT_RICOSTRUZIONE_RC6.md`, non nel pacchetto di installazione.

### Download

Scaricare lo ZIP `synk-<versione>.zip`, piatto, leggere prima
`PRIMO_AVVIO.txt` al suo interno e confrontarne lo SHA256 con il
file `.zip.sha256` proveniente da questo canale fidato. Il checksum rileva
corruzioni ma non è una firma digitale di autenticità. Il manifest contiene
commit sorgente e hash di ogni file. Non sono incluse credenziali, sessioni o dati
cliente: configurarli solo sul PC del salone.

### Licenza e attivazione

Licenza proprietaria/source-available: solo uso privato non commerciale gratuito;
ogni altro uso richiede un accordo commerciale scritto a titolo oneroso, salvo
diversa autorizzazione scritta. Prezzi e royalties vanno concordati, non sono
automatici. Il file di attivazione firmato/HWID serve anche al privato: il suo
rilascio è gratuito ma manuale, da richiedere al titolare prima della prova.
Non è una release open source. Leggere `LICENSE.md`.

### Limiti da non ignorare

- **Non usare con clienti reali prima di completare e firmare `COLLAUDO.md`.**
- CI e provider simulati non sostituiscono Windows/Docker Desktop, Google,
  WhatsApp, SMTP e recovery reali.
- Provider migrato a whatsapp-web.js 1.34.7 (Apache-2.0), QR in RAM con qrcode
  (MIT). **Serve una nuova associazione**: fermare OpenWA, conservare i vecchi
  file e non avviare due bot sullo stesso account. Leggere RELEASE.md.
- LocalAuth persistente separato; destroy non esegue logout. QR reale,
  riconnessione, revoca e messaggi richiedono collaudo con account dedicato.
  Verificare anche sandbox Chromium sul PC Docker/WSL2, senza bypass impliciti.
- Audit migrato: 19 rilievi, 11 elevati, zero critici all’8 novembre 2026.
  I critici bloccano la procedura; gli altri non sono approvazione produzione.
  I testi dei nuovi componenti sono in deploy/THIRD_PARTY_NOTICES.md.
- Un rollback del codice non annulla migrazioni del database; un restore richiede
  riconciliazione manuale Calendar prima della riattivazione.
- Il repository sorgente e' PUBBLICO. Una bozza GitHub Release non e'
  pubblicata ai visitatori; se si sceglie Publish, ZIP, manifest e note
  diventano scaricabili pubblicamente. Non caricare file di attivazione,
  segreti, dati o immagini dei clienti. Licenza proprietaria e obblighi
  dei componenti di terzi restano applicabili.

Questa è una **bozza prerelease**. Nessuna promozione stabile è automatica.
