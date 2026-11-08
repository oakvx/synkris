# Sicurezza e dati riservati

Repository da mantenere privato, soprattutto durante lo sviluppo e il pilota.
Non creare issue contenenti log con contatti clienti, numeri, messaggi, token,
QR o dati di prenotazione. Tratta la chiave privata di firma delle licenze e
le credenziali Google come materiale altamente sensibile.

I file `.env`, `secrets/`, dati PostgreSQL, `bookings.json`, sessioni browser,
licenze cliente e certificati privati **non devono essere committati**.
Lo script `npm run check:repo` intercetta alcune esposizioni accidentali, ma
non puo riconoscere tutte le credenziali o i dati personali.

Se un segreto finisce in un commit, eliminarlo dal commit **non basta**:
revoca subito la credenziale e valuta la bonifica dell'intera cronologia Git.
Non usare un archivio storico con credenziali attive come sorgente del repo.

Non esporre direttamente le porte amministrative: usare HTTPS, un reverse proxy
e protezioni di accesso coerenti con l'ambiente. Conservare backup cifrati
separati dai sorgenti.

## Integrità e responsabilità della distribuzione

synk distribuito con sorgente modificabile non offre DRM inviolabile: chi modifica il codice può aggirare controlli locali. Per gestire una licenza commerciale mantenere il repository privato, custodire fuori dal repository la chiave di firma, distribuire immagini versionate e formalizzare il diritto d'uso. Il controllo del rollback dell'orologio è limitato all'esecuzione corrente e non garantisce revoca remota; i file clienti, le sessioni e i backup richiedono protezione e conservazione locale concordate.

## Licenza d’uso e attivazione

Il modello è proprietario/source-available: solo l’uso privato non commerciale
è gratuito; gli altri usi richiedono l’accordo commerciale descritto in LICENSE.md.
Anche l’attivazione privata gratuita richiede un file firmato rilasciato
manualmente dal titolare. I verificatori non sono stati disattivati e non
esiste un selettore anonimo «privato» che aggiri firma/HWID. La firma non
classifica l’utilizzo concreto e non è un sistema automatico di incasso royalties.
La chiave privata di firma deve restare separata dai sorgenti e dalle installazioni.

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
