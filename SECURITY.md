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
