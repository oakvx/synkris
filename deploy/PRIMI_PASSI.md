# synk: primi passi guidati su Windows

**RC di collaudo, non ancora approvata per clienti reali.** Non devi installare Node.js o PHP sul PC: sono nelle immagini Docker. Servono Windows con Docker Desktop/WSL2 e motore Linux, Internet per la preparazione e per Google/WhatsApp, più i file di attivazione e del service account. Non vengono creati nuovi account cloud obbligatori.

## 1. Prepara una cartella fissa

Estrai **tutto** lo ZIP in una cartella locale dedicata: devi vedere insieme `compose.yaml`, `INSTALLA_SYNK.bat` e `strumenti/`. Non eseguire i BAT dall'interno dello ZIP. Evita cartelle condivise, pubbliche o sincronizzate con OneDrive/Dropbox: contengono anche segreti e dati personali. Non è implementato un rilevatore universale delle cartelle cloud.

Non spostare la cartella dopo l'installazione. Un'altra cartella che tenta di usare lo stesso progetto Docker viene bloccata, non sostituisce silenziosamente i container esistenti.

## 2. Tieni a portata di mano

- `license.txt` firmato e `license-public.pem` del titolare, più l'**HWID** associato alla tua attivazione. Non importare la chiave privata di firma.
- `google-service-account.json` originale, scaricato dalla console Google.
- ID del calendario del salone ed email dei calendari delle operatrici. Condividi tutti i calendari operativi con il service account, con autorizzazione a gestire gli eventi.
- Team, trattamenti, prezzi facoltativi e orari iniziali.

La licenza è proprietaria/source-available: solo uso privato personale non commerciale gratuito; ogni altro uso richiede prima un accordo commerciale scritto, salvo diversa autorizzazione scritta. Anche l'attivazione privata gratuita richiede firma/HWID, con emissione manuale: il wizard non rilascia licenze né sceglie automaticamente la gratuità.

## 3. Due soli launcher principali: installazione e avvio

Per configurare il programma usa soltanto **`INSTALLA_SYNK.bat`**. Per gli avvii successivi usa soltanto **`AVVIA_SYNK.bat`**. Gli altri BAT con suffisso `_TECNICO` riguardano esclusivamente la manutenzione.

Apri `INSTALLA_SYNK.bat`; premi **Invio** per **1 — Installa/riprendi**. Il wizard:

1. controlla Docker locale, Compose e motore Linux; può avviare Docker Desktop e attende che sia pronto;
2. chiede nome salone, operatrici, trattamenti, abilitazioni e orari, senza farti modificare JSON;
3. importa i tre file privati: puoi trascinare il file originale nella console o incollare il **percorso**, mai il contenuto;
4. prepara `.env` e segreti casuali solo dove mancano, senza cambiare la password di un database esistente;
5. prepara le immagini e verifica configurazione, chiave pubblica, firma/HWID e formato delle credenziali Google;
6. avvia i servizi, attende gli endpoint locali e apre dashboard e finestra credenziali.

La preparazione iniziale può richiedere diversi minuti. Se annulli, i file completati restano e puoi riprendere. Il configuratore non ripopola il catalogo a ogni avvio: dopo il primo import modifica team, trattamenti e orari dalla dashboard.

**Password:** la finestra la mostra mascherata. Rivelazione e copia richiedono un tuo clic. Non viene stampata né rigenerata. Alla chiusura si tenta di cancellare dagli appunti solo il valore copiato da quella finestra, se è ancora quello; **non vengono cancellate la cronologia appunti o la sincronizzazione cloud di Windows**. Conservala in un gestore password.

## 4. Completa “Primi passi” nella dashboard

Accedi a `http://127.0.0.1:8080/`. Nel Centro operativo trovi sei controlli: **database, attivazione, catalogo, WhatsApp, Calendar e backup**.

- Associa WhatsApp dalla sezione Conversazioni. Passando da OpenWA serve un nuovo QR; lascia intatti i vecchi file e non avviare due bot sullo stesso account.
- Verifica Calendar con calendari di prova: creazione, spostamento, annullamento, eventi esterni e indisponibilità di rete.
- Segui gli avvisi sui backup. “Recente” riguarda solo i metadati di un dump finale compatibile: non attesta checksum, restore o copia esterna cifrata.
- Anche sei controlli completati **non certificano produzione o collaudo**. Firma `COLLAUDO.md` solo dopo prove reali sul PC di prova.

## 5. Menu strumenti

| Numero | Operazione |
| --- | --- |
| 1 | Installa o riprende il setup; non sovrascrive automaticamente i file privati presenti. |
| 2 | Avvia e apre la dashboard; equivalente al percorso quotidiano. |
| 3 | Diagnostica offline, senza stampare credenziali, avviare DB o contattare i provider. Richiede Docker e immagini già preparate. |
| 4 | Riapre la finestra password locale, senza cambiarla. |
| 5 | Crea un report assistenza **solo locale** in `runtime/support/`. |
| 6 | Propone e richiede conferma `ATTIVA` per l'avvio automatico dopo il login Windows. |
| 7 | Disattiva solo il collegamento di avvio automatico gestito per questa cartella. |
| 8 | Rifà il file iniziale con conferma e backup, **solo prima del primo import**. |
| 9 | Corregge uno dei tre file privati iniziali, **solo prima del primo import**, a servizi fermi. |
| 0 | Esce senza avviare nulla. |

### Hai importato un file sbagliato?

Se il primo setup si ferma nel preflight, scegli **9**, seleziona il file e conferma `SOSTITUISCI`. Serve la diagnostica già disponibile nell'immagine. Il file precedente viene conservato in `runtime/private-file-backups/`; il nuovo file è sottoposto al controllo pertinente del doctor. Se non supera il controllo, viene ripristinato l'originale. Anche le copie rifiutate restano private: non allegarle all'assistenza.

È un recupero del **primo setup**, non un sistema di rinnovo o rotazione in produzione. Una chiave pubblica formalmente valida non prova da sola che la licenza sia firmata da quella chiave: il controllo separato di firma deve comunque riuscire. Correggi gli altri punti segnalati e rilancia **1**; nessun servizio parte da questa riparazione. Per rinnovi o rotazioni dopo l'import contatta il tecnico.

### Avvio automatico facoltativo

Non è attivato dall'installazione. L'opzione **6** crea un collegamento nella cartella Esecuzione automatica dell'utente, non un servizio o un'attività amministrativa. Non richiede o salva la password Windows. Funziona **dopo il login**, non a PC spento; anche Docker Desktop deve poter partire. Non apre il browser automaticamente. Prima di spostare la cartella disattivalo dalla vecchia copia; non vengono rimossi collegamenti di altre installazioni.

### Assistenza senza inviare l'intera installazione

L'opzione **5** seleziona versione, piattaforma e stati tecnici conosciuti. Non copia log grezzi, chat, contatti, QR, token, HWID o contenuto delle licenze/credenziali. La lettura del runtime avviene autenticata **dentro il container bot esistente**, non inviando il token a un servizio sconosciuto sulla porta host.

Il report **non viene caricato o inviato automaticamente**. Rileggilo e condividi solo quel JSON con il tecnico. Non inviare `.env`, `secrets/`, sessioni, dump, backup dei file privati o screenshot del QR. Se il runtime non è disponibile, i relativi stati possono restare sconosciuti: non sono una diagnosi di causa certa.

## 6. Ogni giorno e manutenzione

- Apri `AVVIA_SYNK.bat`: avvio senza build o download delle immagini. Se mancano, riprendi l'installazione guidata.
- Non aprire porte sulla LAN e non usare un Docker remoto. Dashboard e API restano sul PC.
- I backup automatici sono dump PostgreSQL locali, circa ogni 24 ore con retention 14 giorni. Staging, verifica strutturale e SHA256 evitano di pubblicare come finale una copia interrotta; non sostituiscono restore e copia esterna cifrata. Non comprendono segreti o profili WhatsApp.
- Per export, aggiornamento e restore usa gli entrypoint tecnici descritti in `LEGGIMI.txt` e `RELEASE.md`. Dopo un restore non rimuovere il blocco Calendar e non ripetere automaticamente vecchi job.
- “PRENOTAZIONI SOSPESE” prevale sui normali avvii: serve riconciliazione tecnica, non un altro clic su Installa.

**Limiti ancora aperti:** collaudo Windows/Docker Desktop/WSL2 e sandbox Chromium sul PC destinatario, prova interattiva della finestra, Google/WhatsApp reali, SMTP se richiesto, restore/recovery e USB BitLocker. Restano anche i rilievi delle dipendenze da valutare. Il wizard riduce i passaggi manuali, non li trasforma in una certificazione di idoneità.
