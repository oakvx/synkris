## Candidata ricostruita — solo collaudo

Dashboard, deploy, asset e strumenti Windows sono stati ricostruiti dai contratti
rimasti nel repository, non recuperati dagli originali. Leggere
`REPORT_RICOSTRUZIONE_RC6.md`, `RELEASE.md` e `CHANGELOG.md` nello ZIP.

### Download

Scaricare lo ZIP `synk-<versione>.zip`, piatto, e confrontarne lo SHA256 con il
file `.zip.sha256` proveniente da questo canale fidato. Il checksum rileva
corruzioni ma non è una firma digitale di autenticità. Il manifest contiene
commit sorgente e hash di ogni file. Non sono incluse credenziali, sessioni o dati
cliente: configurarli solo sul PC del salone.

### Limiti da non ignorare

- **Non usare con clienti reali prima di completare e firmare `COLLAUDO.md`.**
- CI e provider simulati non sostituiscono Windows/Docker Desktop, Google,
  WhatsApp, SMTP e recovery reali.
- OpenWA è allineato alla API v4 del bot; dipendenze legacy e vulnerabilità npm
  richiedono revisione. I critici bloccano la procedura; gli altri rilievi non
  costituiscono approvazione produzione. Verificare anche sandbox Chromium su WSL2.
- Un rollback del codice non annulla migrazioni del database; un restore richiede
  riconciliazione manuale Calendar prima della riattivazione.
- Repository e release restano privati; licenza proprietaria e obblighi dei
  componenti di terzi restano applicabili.

Questa è una **bozza prerelease**. Nessuna promozione stabile è automatica.
