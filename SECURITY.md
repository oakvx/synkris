# Sicurezza e dati riservati

Repository da mantenere privato, soprattutto durante lo sviluppo e il pilota.
Non creare issue contenenti log con contatti clienti, numeri, messaggi, token,
QR o dati di prenotazione. Tratta le credenziali Google, i token e le password come materiale altamente
sensibile; proteggi anche eventuali vecchi file o chiavi di attivazione.

I file `.env`, `secrets/`, dati PostgreSQL, `bookings.json`, sessioni browser,
vecchi file di attivazione e certificati privati **non devono essere committati**.
Lo script `npm run check:repo` intercetta alcune esposizioni accidentali, ma
non puo riconoscere tutte le credenziali o i dati personali.

Se un segreto finisce in un commit, eliminarlo dal commit **non basta**:
revoca subito la credenziale e valuta la bonifica dell'intera cronologia Git.
Non usare un archivio storico con credenziali attive come sorgente del repo.

Il deploy previsto resta **solo loopback**: non allargare automaticamente le
porte alla LAN/Internet e non usare Docker remoto. Un eventuale accesso remoto
richiede un progetto di sicurezza distinto (HTTPS, reverse proxy e autenticazione),
non una modifica alle porte del wizard. Conservare backup cifrati separati.

## Strumenti guidati e assistenza locale

- Import ordinario create-only; correzione esplicita solo prima del primo import,
  a servizi fermi, con mutex, backup e rollback se il file non supera il doctor.
  `runtime/private-file-backups/` può contenere vecchie credenziali e copie
  rifiutate: è privato come `secrets/`, non va allegato a issue o report.
- La finestra password è mascherata e non stampa il valore. Mostra/copia solo su
  clic; lo svuotamento condizionale degli appunti non elimina cronologia/cloud
  Windows. Preferire un gestore password; evitare cartelle sincronizzate.
- Il report assistenza in `runtime/support/` usa una allowlist di metadati/stati,
  non filtri su log arbitrari. Esclude chat, nomi/contatti, QR, token,
  credenziali e dati del precedente sistema di attivazione. Nessun upload automatico: rileggere prima di
  condividere anche un report minimizzato. Non è una scansione forense completa.
- Il token admin viene usato solo dal worker interno al container bot esistente,
  con richiesta loopback, timeout, limite corpo e redirect vietati. Non viene
  inviato automaticamente alla porta host, che potrebbe appartenere ad altri.
- Autostart opt-in per utente dopo login, non servizio/admin. Non memorizza la
  password Windows e non sostituisce collegamenti modificati o di altre cartelle.
- Il doctor offline non avvia DB, browser o provider e non attesta la condivisione
  Google. La checklist dashboard conserva `productionReady: false`: anche un
  backup recente è soltanto un'indicazione di metadati, non una prova di restore.
- I backup PostgreSQL sono staging + controllo strutturale + SHA256 prima della
  pubblicazione finale. Restano personali e non cifrati in automatico; provare
  periodicamente restore e copia esterna cifrata. Un checksum non autentica la fonte.

## Integrità e responsabilità della distribuzione

Distribuire immagini versionate da un commit verificato, controllare manifest e provenienza del pacchetto e formalizzare il diritto d'uso quando richiesto. I file clienti, le sessioni e i backup richiedono protezione e conservazione locale concordate. La rimozione del sistema di attivazione non modifica login, token, sessioni, controlli origin/CSRF, porte loopback o i blocchi di riconciliazione.

## Diritti d’uso e rimozione dell’attivazione

Il modello è proprietario/source-available: solo l’uso privato non commerciale
è gratuito; gli altri usi richiedono l’accordo commerciale descritto in LICENSE.md.
Il vecchio meccanismo di file firmati/HWID, scadenze e monitor è stato eliminato,
non sostituito da una verifica sempre valida. Non servono chiavi di licenza o
rinnovi. Le credenziali Google restano obbligatorie per l’integrazione.
Gli eventuali vecchi file non sono letti, cancellati o esportati nei report/ZIP;
le esclusioni e la redazione difensiva restano per non esporre dati legacy.

## Prerelease ricostruita RC6

Il runtime usa whatsapp-web.js 1.34.7 e Puppeteer 24.38.0; OpenWA e il suo
override sono stati rimossi. L’audit del lockfile migrato riporta 19 rilievi
(11 elevati, 8 moderati, zero critici) all’8 novembre 2026: il gate sui critici
NON approva i restanti rilievi. Non applicare downgrade o fix maggiori forzati
senza collaudo. Leggere la CI del commit effettivo, non soltanto quella storica.

LocalAuth e cache web sono nella directory privata `runtime/session/whatsapp-web.js/`
nel deploy Compose, non nei sorgenti. Il normale arresto usa destroy, non logout.
La prima migrazione richiede un nuovo QR; i vecchi file OpenWA restano intatti.
Non eseguire due bot sullo stesso account. Il QR PNG e la stringa nativa non
vengono salvati o loggati dall’adapter; l’endpoint autenticato rifiuta anche
un timestamp nel futuro. Gli invii dall’esito incerto non sono ritentati in
automatico e non vengono registrati come consegne confermate.

Gli avvisi e i testi originali dei nuovi componenti sono in
[deploy/THIRD_PARTY_NOTICES.md](deploy/THIRD_PARTY_NOTICES.md). Questo non sostituisce
l’inventario/revisione delle altre dipendenze, dei pacchetti Docker o dei termini
WhatsApp. Non promuovere la RC a stabile sulla sola base dei test.
